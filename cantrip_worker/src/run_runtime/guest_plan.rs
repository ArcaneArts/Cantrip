//! Materialize a Run in its admitted Linux account and checkout. The worker
//! still owns admission and launches the prepared commands through the executor.
use super::{
    Environment, Failure,
    layers::{self, Roots},
    providers,
    shell::Command,
};
use crate::{
    filesystem::{Scope, paths},
    run_definitions::repository::Repository,
};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::path::PathBuf;

pub(crate) async fn prepare(input: &Value, mut baseline: Environment) -> Result<Value> {
    baseline.retain(|name, _| {
        matches!(
            name.as_str(),
            "HOME" | "USER" | "LOGNAME" | "SHELL" | "PATH"
        )
    });
    baseline.insert("LANG".into(), "C.UTF-8".into());
    let plan = match materialize(input, &baseline).await {
        Ok(result) => return Ok(result),
        Err(failure) => failure,
    };
    crate::http::checked(
        "osRunPlanResponseSchema",
        &json!({
            "state":"failed","phase":plan.phase,"code":plan.code,
            "message":JsString::new(plan.message.encode_utf16().take(1000).collect()),
        }),
    )
}

async fn materialize(input: &Value, baseline: &Environment) -> Result<Value, Failure> {
    let definition_failure =
        |message| Failure::new("definition", "linux-preparation-failed", message, true);
    let roots = Roots {
        source: canonical(&input["sourceRoot"]).await.map_err(|_| {
            definition_failure("A captured Run root changed its canonical Linux location.")
        })?,
        target: canonical(&input["targetRoot"]).await.map_err(|_| {
            definition_failure("A captured Run root changed its canonical Linux location.")
        })?,
    };
    let identity = &input["identity"];
    let id = identity["configurationId"].as_str().unwrap();
    let unchanged = || {
        definition_failure("The Primary Run definition is unavailable or changed before launch.")
    };
    let entry = Repository::new(roots.source.clone())
        .read(id)
        .map_err(|_| unchanged())?
        .filter(|entry| {
            entry["status"] == "ready" && entry["revision"] == identity["definitionRevision"]
        })
        .ok_or_else(unchanged)?;
    let document = &entry["document"];
    let launch = providers::materialize(document, &roots.target, baseline).map_err(|failure| {
        Failure::new(
            "target",
            "linux-preparation-failed",
            failure.message,
            failure.retryable,
        )
    })?;
    let mut output = String::new();
    let environment = layers::guest(
        input,
        &roots,
        &launch.environment,
        launch.additions,
        baseline,
        &mut output,
    )
    .await?;
    let validation =
        providers::validation(document, &roots.target, &environment, &Scope::default()).map_err(
            |_| {
                Failure::new(
                    "provider",
                    "linux-preparation-failed",
                    "The Linux Run provider could not be validated.",
                    true,
                )
            },
        )?;
    if let Some(first) = validation["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|diagnostic| diagnostic["severity"] == "error")
    {
        return Err(Failure::new(
            "provider",
            first["code"].as_str().unwrap_or("linux-preparation-failed"),
            first["message"]
                .as_str()
                .unwrap_or("The Linux Run provider could not be validated."),
            true,
        ));
    }
    let before: Vec<_> = launch.before.iter().map(command).collect();
    let result = crate::http::checked("osRunPlanResponseSchema", &json!({
        "state":"ready","command":command(&launch.main),"beforeLaunch":before,"environment":environment,
        "preparationOutput":output,"stopGracePeriodMs":document["stop"]["gracePeriodMs"],
    })).map_err(|_| Failure::new("provider", "linux-preparation-failed", "The prepared Linux launch exceeded its protocol limits.", true))?;
    // Gradle main-class runs read a private generated script from a later
    // executor process. Keep the file for that command, as the legacy helper did.
    if let Some(scratch) = launch.scratch {
        let _ = scratch.keep();
    }
    Ok(result)
}

async fn canonical(value: &Value) -> Result<PathBuf> {
    let raw = value.as_js_string().unwrap();
    let canonical = paths::canonical(&paths::native(raw)).await?;
    ensure!(
        *raw == paths::text(&canonical) && tokio::fs::metadata(&canonical).await?.is_dir(),
        "The captured Linux Run root changed."
    );
    Ok(canonical)
}

fn command(command: &Command) -> Value {
    json!({"executable":command.program,"arguments":command.arguments,"workingDirectory":paths::text(&command.cwd)})
}
