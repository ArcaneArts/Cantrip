//! The explicit device operation is the only definition read that runs Flutter.
use super::{Environment, Resolved, SDK, issue, shell, tool_invocation};
use crate::{
    filesystem::{Scope, paths},
    run_definitions::collator,
};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{collections::HashSet, path::Path, time::Duration};

const MAX_DEVICES: usize = 256;
const MAX_OUTPUT: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn inspect_devices(
    document: &Value,
    root: &Path,
    baseline: &Environment,
    scope: &Scope,
) -> Result<(Vec<Value>, Vec<Value>)> {
    let resolved = Resolved::new(document);
    let cwd = match shell::located(root, resolved.field("workingDirectory"), true) {
        Ok(cwd) => cwd,
        Err(message) => {
            return Ok((
                vec![],
                vec![issue(
                    "working-directory-invalid",
                    message,
                    "workingDirectory",
                )],
            ));
        }
    };
    let executable = if let Some(home) = resolved.option("sdkHome").as_js_string() {
        match SDK.inspect(&paths::native(home)) {
            Ok(executable) => executable,
            Err(message) => {
                return Ok((
                    vec![],
                    vec![issue("flutter-sdk-invalid", &message, "options.sdkHome")],
                ));
            }
        }
    } else {
        match super::super::find_executable(SDK.program, root, baseline) {
            Some(executable) => executable,
            None => {
                return Ok((
                    vec![],
                    vec![super::super::missing_executable(
                        SDK.program,
                        "options.sdkHome",
                    )],
                ));
            }
        }
    };
    let command = tool_invocation(
        cwd,
        &executable.to_string_lossy(),
        vec!["devices".into(), "--machine".into()],
        baseline,
    );
    let result = match command {
        Ok(command) => inspect(command, baseline, scope).await,
        Err(failure) => Err(anyhow::anyhow!(failure.message)),
    };
    scope.check()?;
    Ok(match result {
        Ok(devices) => (devices, vec![]),
        Err(_) => (
            vec![],
            vec![issue(
                "flutter-device-inspection-failed",
                "Flutter device inspection could not complete safely. Verify the selected SDK and connected-device tooling, then retry.",
                "options.deviceId",
            )],
        ),
    })
}

async fn inspect(
    command: shell::Command,
    baseline: &Environment,
    scope: &Scope,
) -> Result<Vec<Value>> {
    scope.check()?;
    let mut environment = baseline.clone();
    if cfg!(windows) {
        environment.retain(|key, _| {
            !key.eq_ignore_ascii_case("CI")
                && !key.eq_ignore_ascii_case("FLUTTER_SUPPRESS_ANALYTICS")
        });
    }
    environment.insert("CI".into(), "true".into());
    environment.insert("FLUTTER_SUPPRESS_ANALYTICS".into(), "true".into());
    let mut child = codex_utils_pty::spawn_pipe_process_no_stdin(
        &command.program,
        &command.arguments,
        &command.cwd,
        &environment,
        &None,
        &[],
    )
    .await?;
    let collect = async {
        let mut stdout = Vec::new();
        let mut size = 0;
        let mut stdout_open = true;
        let mut stderr_open = true;
        while stdout_open || stderr_open {
            tokio::select! {
                bytes = child.stdout_rx.recv(), if stdout_open => {
                    if let Some(bytes) = bytes {
                        size += bytes.len();
                        ensure!(size <= MAX_OUTPUT, "Flutter device output exceeded the validation limit.");
                        stdout.extend_from_slice(&bytes);
                    } else {
                        stdout_open = false;
                    }
                }
                bytes = child.stderr_rx.recv(), if stderr_open => {
                    if let Some(bytes) = bytes {
                        size += bytes.len();
                        ensure!(size <= MAX_OUTPUT, "Flutter device output exceeded the validation limit.");
                    } else {
                        stderr_open = false;
                    }
                }
            }
        }
        ensure!(
            child.exit_rx.await? == 0,
            "Flutter device inspection failed."
        );
        parse(&String::from_utf8_lossy(&stdout))
    };
    let result = tokio::select! {
        biased;
        _ = scope.stopped() => Err(anyhow::anyhow!("Flutter device inspection stopped.")),
        result = tokio::time::timeout(TIMEOUT, collect) => result.unwrap_or_else(|error| Err(error.into())),
    };
    drop(child.stdout_rx);
    drop(child.stderr_rx);
    child.session.terminate_and_wait().await;
    result
}

fn bounded_text(value: &Value) -> Result<Option<JsString>> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(value) = value.as_js_string() else {
        anyhow::bail!("Flutter returned an invalid device record.");
    };
    let value = value.trim();
    ensure!(
        !value.is_empty()
            && value.units().len() <= 256
            && !value.units().iter().any(|unit| *unit < 32 || *unit == 127),
        "Flutter returned an invalid device record."
    );
    Ok(Some(value))
}

fn parse(stdout: &str) -> Result<Vec<Value>> {
    let parsed = parse_json_text(stdout)
        .map_err(|_| anyhow::anyhow!("Flutter returned malformed device output."))?;
    let records = parsed
        .as_array()
        .filter(|records| records.len() <= MAX_DEVICES)
        .ok_or_else(|| anyhow::anyhow!("Flutter returned an invalid device inventory."))?;
    let mut devices = Vec::with_capacity(records.len());
    let mut ids = HashSet::new();
    for record in records {
        let id = bounded_text(&record["id"])?
            .ok_or_else(|| anyhow::anyhow!("Flutter returned an invalid device record."))?;
        let name = bounded_text(&record["name"])?
            .ok_or_else(|| anyhow::anyhow!("Flutter returned an invalid device record."))?;
        let target = bounded_text(&record["targetPlatform"])?;
        let flag = |field: &str, default| match record.get(field) {
            Some(value) => value
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("Flutter returned an invalid device record.")),
            None => Ok(default),
        };
        let supported = flag("isSupported", true)?;
        let emulator = flag("emulator", false)?;
        ensure!(
            ids.insert(id.lowercase()),
            "Flutter returned duplicate device identifiers."
        );
        devices.push(json!({
            "id":id, "name":name, "supported":supported, "emulator":emulator, "targetPlatform":target,
        }));
    }
    let collator = collator()?;
    let compare = |left: &Value, right: &Value, field: &str| {
        collator.compare_utf16(
            left[field].as_js_string().unwrap().units(),
            right[field].as_js_string().unwrap().units(),
        )
    };
    devices.sort_by(|left, right| {
        right["supported"]
            .as_bool()
            .unwrap()
            .cmp(&left["supported"].as_bool().unwrap())
            .then_with(|| compare(left, right, "name"))
            .then_with(|| compare(left, right, "id"))
    });
    Ok(devices)
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn run_flutter_device_parser_rejects_duplicate_and_malformed_records() {
        for output in [
            "not json",
            r#"[{"id":"A","name":"First"},{"id":"a","name":"Duplicate"}]"#,
            r#"[{"id":"A","name":"First","isSupported":null}]"#,
            r#"[{"id":"A","name":"bad\u0001"}]"#,
        ] {
            assert!(parse(output).is_err(), "{output}");
        }
    }
}
