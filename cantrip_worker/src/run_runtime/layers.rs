use super::{Environment, Failure, LaunchJob, process, protection, shell};
use crate::{
    encryption::Service,
    filesystem::paths,
    run_definitions::{
        environment::{self, Source},
        repository::read_bounded,
    },
};
use cantrip_crypto::content::decrypt_secret;
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
use zeroize::Zeroizing;

const CAPTURE: &str = "_CANTRIP_RUN_ENV_CAPTURE";
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_CAPTURE_BYTES: u64 = 1024 * 1024;

pub(super) struct Roots {
    pub source: PathBuf,
    pub target: PathBuf,
}

pub(super) struct Prepared {
    pub environment: Environment,
    pub redactions: Vec<Zeroizing<String>>,
}

pub(super) fn env_value<'a>(environment: &'a Environment, name: &str) -> Option<&'a str> {
    if cfg!(windows) {
        environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    } else {
        environment.get(name).map(String::as_str)
    }
}

fn reserved(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.starts_with("CANTRIP_") || name.starts_with("_CANTRIP_") || name == "CODEX_WORKTREE_PATH"
}

pub(super) fn protected(environment: &Environment) -> impl Iterator<Item = &str> {
    environment
        .iter()
        .filter(|(name, _)| reserved(name))
        .map(|(_, value)| value.as_str())
}

fn put(environment: &mut Environment, name: String, value: String) {
    if cfg!(windows)
        && let Some(old) = environment
            .keys()
            .find(|key| *key != &name && key.eq_ignore_ascii_case(&name))
            .cloned()
    {
        environment.remove(&old);
    }
    environment.insert(name, value);
}

fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte == b'_' || byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
        && name.len() <= 256
}

fn valid_value(value: &str) -> bool {
    !value.contains('\0') && value.encode_utf16().count() <= 16 * 1024
}

fn merge_layer(environment: &mut Environment, layer: Environment) -> Result<(), Failure> {
    if layer.len() > 256 {
        return Err(error(
            "environment-layer-too-large",
            "An environment source exported too many variables.",
            false,
        ));
    }
    let mut total = 0;
    for (name, value) in layer {
        if !valid_name(&name) || !valid_value(&value) {
            return Err(error(
                "environment-layer-invalid",
                "An environment source exported an invalid variable.",
                false,
            ));
        }
        total += name.len() + value.encode_utf16().count();
        if !reserved(&name) {
            put(environment, name, value);
        }
    }
    if total > 128 * 1024 {
        return Err(error(
            "environment-layer-too-large",
            "An environment source exceeded the bounded variable size.",
            false,
        ));
    }
    Ok(())
}

pub(super) async fn resolve(
    job: &LaunchJob,
    roots: &Roots,
    definition: &Value,
    additions: Environment,
    baseline: &Environment,
    encryption: &Service,
) -> Result<Prepared, Failure> {
    let files = files(&roots.target, &definition["files"])?;
    let secrets = secrets(
        &job.command["identity"]["projectId"],
        definition,
        &job.command["protectedSecrets"],
        encryption,
    )?;
    let identity = &job.command["identity"];
    let codex = codex(
        roots,
        baseline,
        definition,
        identity,
        async |cmd, environment| {
            process::run(
                cmd,
                environment,
                &job.control,
                Duration::ZERO,
                Some(Duration::from_secs(120)),
                |output| job.append(output),
                || {},
            )
            .await
        },
    )
    .await?;
    let redactions = secrets
        .values()
        .map(|value| Zeroizing::new(value.clone()))
        .collect();
    let mut environment = baseline.clone();
    for layer in [codex, files, variables(definition), secrets, additions] {
        merge_layer(&mut environment, layer)?;
    }
    let mut environment = launch_environment(roots, identity, environment);
    put(
        &mut environment,
        "CANTRIP_TERMINAL_ID".into(),
        identity["terminalId"].as_str().unwrap().into(),
    );
    Ok(Prepared {
        environment,
        redactions,
    })
}

fn variables(definition: &Value) -> Environment {
    definition["variables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["enabled"] == true)
        .map(|entry| {
            (
                entry["name"].as_str().unwrap().to_owned(),
                entry["value"].as_js_string().unwrap().lossy().into_owned(),
            )
        })
        .collect()
}

fn launch_environment(
    roots: &Roots,
    identity: &Value,
    mut environment: Environment,
) -> Environment {
    for (name, value) in [
        ("TERM", "xterm-256color".to_owned()),
        ("COLORTERM", "truecolor".to_owned()),
        (
            "CANTRIP_PROJECT_ROOT",
            roots.source.to_string_lossy().into_owned(),
        ),
        (
            "CANTRIP_WORKTREE_PATH",
            roots.target.to_string_lossy().into_owned(),
        ),
        (
            "CODEX_WORKTREE_PATH",
            roots.target.to_string_lossy().into_owned(),
        ),
    ] {
        put(&mut environment, name.to_owned(), value);
    }
    for (name, field) in [
        ("CANTRIP_PROJECT_ID", "projectId"),
        ("CANTRIP_RUN_CONFIGURATION_ID", "configurationId"),
        ("CANTRIP_RUN_GENERATION", "generation"),
        ("CANTRIP_RUN_OPERATION_ID", "operationId"),
        ("CANTRIP_RUN_RUNTIME_ID", "runtimeId"),
        ("CANTRIP_RUN_TERMINAL_ID", "terminalId"),
        ("CANTRIP_RUN_WORKTREE_ID", "worktreeId"),
    ] {
        let value = identity[field]
            .as_str()
            .map_or_else(|| identity[field].stringify(), str::to_owned);
        put(&mut environment, name.to_owned(), value);
    }
    environment
}

#[cfg(all(feature = "guest-run-definitions", target_os = "linux"))]
pub(super) async fn guest(
    input: &Value,
    roots: &Roots,
    definition: &Value,
    additions: Environment,
    baseline: &Environment,
    output: &mut String,
) -> Result<Environment, Failure> {
    let files = files(&roots.target, &definition["files"])?;
    let identity = &input["identity"];
    let codex = codex(
        roots,
        baseline,
        definition,
        identity,
        async |cmd, environment| {
            process::guest_setup(cmd, environment, output)
                .await
                .map(Some)
        },
    )
    .await?;
    let supplied: std::collections::HashMap<_, _> = input["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|secret| (secret["reference"].as_str().unwrap(), &secret["value"]))
        .collect();
    let mut secrets = Environment::new();
    for entry in definition["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["enabled"] == true)
    {
        let reference = entry["secret"].as_str().unwrap();
        let value = supplied.get(reference).ok_or_else(|| {
            error(
                "linux-preparation-failed",
                format!("Run secret reference {reference} is unavailable."),
                true,
            )
        })?;
        put(
            &mut secrets,
            entry["name"].as_str().unwrap().into(),
            value.as_js_string().unwrap().lossy().into_owned(),
        );
    }
    // The guest contract permits dotenv keys with dots and dashes, and
    // bounds the response values after applying all the guest layers.
    let mut environment = baseline.clone();
    for layer in [codex, files, variables(definition), secrets, additions] {
        environment.extend(layer.into_iter().filter(|(name, _)| !reserved(name)));
    }
    Ok(launch_environment(roots, identity, environment))
}

fn files(root: &Path, paths_value: &Value) -> Result<Environment, Failure> {
    let mut environment = Environment::new();
    let mut total = 0;
    for name in paths_value.as_array().unwrap() {
        let relative = name.as_js_string().unwrap();
        let candidate = root.join(paths::native(relative));
        let unsafe_file = |message: &str, retryable| {
            error(
                "environment-file-unsafe",
                format!("Environment file {relative} {message}"),
                retryable,
            )
        };
        let metadata = std::fs::symlink_metadata(&candidate).map_err(|cause| {
            if cause.kind() == std::io::ErrorKind::NotFound {
                error(
                    "environment-file-missing",
                    format!("Environment file {relative} does not exist in the target worktree."),
                    true,
                )
            } else {
                error(
                    "environment-resolution-failed",
                    "The enabled environment sources could not be resolved.",
                    true,
                )
            }
        })?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err(unsafe_file(
                "must be a bounded real file inside the target worktree.",
                false,
            ));
        }
        let canonical = paths::canonical_sync(&candidate).map_err(|_| {
            unsafe_file("changed or became unreadable while it was inspected.", true)
        })?;
        if !paths::within(root, &canonical) {
            return Err(error(
                "environment-file-escape",
                format!("Environment file {relative} resolves outside the target worktree."),
                false,
            ));
        }
        let bytes = read_bounded(&candidate, MAX_FILE_BYTES).map_err(|_| {
            unsafe_file("changed or became unreadable while it was inspected.", true)
        })?;
        total += bytes.len();
        if total > 2 * 1024 * 1024 {
            return Err(error(
                "environment-files-too-large",
                "The declared environment files exceed the combined size limit.",
                false,
            ));
        }
        if bytes.contains(&0) {
            return Err(error(
                "environment-file-invalid",
                format!("Environment file {relative} contains a NUL character."),
                false,
            ));
        }
        for (name, value) in dotenv(&String::from_utf8_lossy(&bytes)) {
            put(&mut environment, name, value);
        }
    }
    Ok(environment)
}

fn dotenv(source: &str) -> impl Iterator<Item = (String, String)> + '_ {
    static LINE: OnceLock<regress::Regex> = OnceLock::new();
    // Run files use the dotenv package's grammar. They are project data and
    // cannot be sourced as shell code. Newlines in double quotes are decoded.
    let line = LINE.get_or_init(|| regress::Regex::with_flags(
        r#"(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)"#,
        "m",
    ).expect("dotenv line pattern"));
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut entries = Vec::new();
    for row in line.find_iter(&normalized) {
        let name = normalized[row.group(1).expect("dotenv variable name")].to_owned();
        let raw = row
            .group(2)
            .map_or("", |range| cantrip_wire::text::trim(&normalized[range]));
        let value = match raw.as_bytes().first() {
            Some(quote @ (b'\'' | b'"' | b'`'))
                if raw.len() >= 2 && raw.as_bytes().last() == Some(quote) =>
            {
                let text = &raw[1..raw.len() - 1];
                if *quote == b'"' {
                    text.replace("\\n", "\n").replace("\\r", "\r")
                } else {
                    text.to_owned()
                }
            }
            _ => raw.to_owned(),
        };
        entries.push((name, value));
    }
    entries.into_iter()
}

fn secrets(
    project: &Value,
    definition: &Value,
    protected: &Value,
    encryption: &Service,
) -> Result<Environment, Failure> {
    let mut opened = std::collections::HashMap::new();
    let mut environment = Environment::new();
    let protected = protected.as_array().unwrap();
    for entry in definition["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["enabled"] == true)
    {
        let reference = entry["secret"].as_str().unwrap();
        let value = match opened.entry(reference) {
            std::collections::hash_map::Entry::Occupied(existing) => existing.into_mut(),
            std::collections::hash_map::Entry::Vacant(vacant) => {
                let record = protected
                    .iter()
                    .find(|row| row["reference"] == reference)
                    .ok_or_else(|| {
                        error(
                            "secret-reference-missing",
                            format!("Secret reference {reference} has no stored value."),
                            true,
                        )
                    })?;
                vacant.insert(open_secret(project, record, encryption)?)
            }
        };
        put(
            &mut environment,
            entry["name"].as_str().unwrap().to_owned(),
            value.to_string(),
        );
    }
    Ok(environment)
}

pub(super) fn open_secret(
    project: &Value,
    record: &Value,
    encryption: &Service,
) -> Result<Zeroizing<String>, Failure> {
    let reference = &record["reference"];
    let unavailable = |_| {
        error(
            "secret-reference-unavailable",
            format!(
                "Secret reference {} could not be opened on this worker.",
                reference.as_str().unwrap()
            ),
            true,
        )
    };
    let encrypted = &record["protectedValue"];
    let grant = encryption
        .bound_component("run-content", encrypted["keyRevision"].as_u64())
        .map_err(|cause| unavailable(anyhow::Error::from(cause)))?;
    let binding = protection::secret(
        &grant.owner_id,
        project,
        reference,
        grant.component.key_revision,
    );
    let content = decrypt_secret(
        &grant.component.key,
        &binding,
        encrypted,
        protection::SECRET_SCHEMA,
        Some(protection::SECRET_LIMIT),
    )
    .map_err(unavailable)?;
    Ok(Zeroizing::new(
        content["value"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned(),
    ))
}

async fn codex(
    roots: &Roots,
    baseline: &Environment,
    definition: &Value,
    identity: &Value,
    run: impl AsyncFnOnce(&shell::Command, &Environment) -> Result<Option<process::Exit>, Failure>,
) -> Result<Environment, Failure> {
    let expected = &identity["codexEnvironmentRevision"];
    if definition["includeCodexEnvironment"] != true {
        if !expected.is_null() {
            return Err(error(
                "codex-environment-revision-mismatch",
                "The Run generation unexpectedly references a disabled Codex environment.",
                true,
            ));
        }
        return Ok(Environment::new());
    }
    let inspect = || {
        environment::inspect(&roots.source).map_err(|_| {
            error(
                "environment-resolution-failed",
                "The enabled environment sources could not be resolved.",
                true,
            )
        })
    };
    let (revision, setup) = match inspect()? {
        Source::Absent => (Value::Null, None),
        Source::Ready { revision, setup } => (json!(revision), setup),
        Source::Invalid { diagnostic, .. } => {
            return Err(error(
                diagnostic["code"]
                    .as_str()
                    .unwrap_or("codex-environment-invalid"),
                diagnostic["message"]
                    .as_str()
                    .unwrap_or("The Codex environment is invalid."),
                true,
            ));
        }
    };
    if &revision != expected {
        return Err(error(
            "codex-environment-revision-mismatch",
            "The Codex environment changed before this generation started.",
            true,
        ));
    }
    let captured = match setup {
        Some(setup) => capture(roots, baseline, &setup, run).await?,
        None => Environment::new(),
    };
    let current = inspect()?;
    let unchanged = match current {
        Source::Absent => revision.is_null(),
        Source::Ready {
            revision: current, ..
        } => revision == current,
        Source::Invalid { .. } => false,
    };
    if !unchanged {
        return Err(error(
            "codex-environment-revision-mismatch",
            "The Codex environment changed while this generation was materializing.",
            true,
        ));
    }
    Ok(captured)
}

async fn capture(
    roots: &Roots,
    baseline: &Environment,
    script: &str,
    run: impl AsyncFnOnce(&shell::Command, &Environment) -> Result<Option<process::Exit>, Failure>,
) -> Result<Environment, Failure> {
    let dir = tempfile::Builder::new()
        .prefix("cantrip-run-environment-")
        .tempdir()
        .map_err(|_| {
            error(
                "environment-resolution-failed",
                "The enabled environment sources could not be resolved.",
                true,
            )
        })?;
    let file = dir.path().join("environment.capture");
    cantrip_host::files::write_private(&file, b"").map_err(|_| {
        error(
            "environment-resolution-failed",
            "The enabled environment sources could not be resolved.",
            true,
        )
    })?;
    let mut capture = baseline.clone();
    for (name, path) in [
        (CAPTURE, &file),
        ("CANTRIP_PROJECT_ROOT", &roots.source),
        ("CANTRIP_WORKTREE_PATH", &roots.target),
        ("CODEX_WORKTREE_PATH", &roots.target),
    ] {
        put(
            &mut capture,
            name.to_owned(),
            path.to_string_lossy().into_owned(),
        );
    }
    let cmd = shell::invocation(
        roots.target.clone(),
        capture_script(script),
        "automatic",
        true,
        baseline,
    )?;
    let result = run(&cmd, &capture).await?;
    let Some(result) = result else {
        return Ok(Environment::new());
    };
    let code = result.code.ok_or_else(|| {
        error(
            "environment-exit-unknown",
            "The environment setup exit status is unknown.",
            true,
        )
    })?;
    if code != 0 || result.signal.is_some() {
        let signal = result
            .signal
            .map_or_else(String::new, |signal| format!(" ({signal})"));
        return Err(error(
            "codex-environment-setup-failed",
            format!("The Codex environment setup exited with code {code}{signal}."),
            true,
        ));
    }
    let raw = Zeroizing::new(read_bounded(&file, MAX_CAPTURE_BYTES).map_err(|_| {
        error(
            "codex-environment-capture-too-large",
            "The Codex environment setup did not produce a bounded environment capture.",
            false,
        )
    })?);
    let text = String::from_utf8_lossy(&raw);
    let mut delta = Environment::new();
    if cfg!(windows) {
        let parsed = parse_json_text(&text)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| {
                error(
                    "codex-environment-capture-invalid",
                    "The Codex environment setup returned an invalid environment capture.",
                    true,
                )
            })?;
        for (name, value) in parsed.as_object().unwrap() {
            if let Some(value) = value.as_str() {
                put(&mut delta, name.lossy().into_owned(), value.to_owned());
            }
        }
    } else {
        for row in text.split('\0') {
            if let Some((name, value)) = row.split_once('=')
                && !name.is_empty()
            {
                put(&mut delta, name.to_owned(), value.to_owned());
            }
        }
    }
    delta.retain(|name, value| {
        !reserved(name)
            && !matches!(
                name.to_ascii_uppercase().as_str(),
                "_" | "OLDPWD" | "PWD" | "SHLVL"
            )
            && env_value(&capture, name) != Some(value)
            && valid_name(name)
            && valid_value(value)
    });
    if delta.len() > 256 {
        return Err(error(
            "codex-environment-too-large",
            "The Codex environment exported too many variables.",
            false,
        ));
    }
    if delta
        .iter()
        .map(|(name, value)| name.len() + value.encode_utf16().count())
        .sum::<usize>()
        > 128 * 1024
    {
        return Err(error(
            "codex-environment-too-large",
            "The Codex environment exceeded the bounded variable size.",
            false,
        ));
    }
    Ok(delta)
}

fn capture_script(command: &str) -> String {
    if cfg!(windows) {
        return format!(
            r#"$cantripExit = 0
$ErrorActionPreference = "Stop"
try {{
  & {{
{command}
  }}
  if ($LASTEXITCODE -is [int]) {{ $cantripExit = $LASTEXITCODE }}
  if ($cantripExit -eq 0) {{
    $cantripEnvironment = @{{}}
    Get-ChildItem Env: | ForEach-Object {{ $cantripEnvironment[$_.Name] = $_.Value }}
    $cantripJson = $cantripEnvironment | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($env:{CAPTURE}, $cantripJson, (New-Object System.Text.UTF8Encoding($false)))
  }}
}} catch {{
  Write-Error $_
  $cantripExit = 1
}}
exit $cantripExit"#
        );
    }
    format!(
        r#"__cantrip_capture_environment() {{
  __cantrip_status=$?
  trap - EXIT
  if [ "$__cantrip_status" -eq 0 ]; then
    env -0 > "${CAPTURE}"
  fi
  exit "$__cantrip_status"
}}
trap __cantrip_capture_environment EXIT
{command}"#
    )
}

fn error(code: &str, message: impl Into<String>, retryable: bool) -> Failure {
    Failure::new("environment", code, message, retryable)
}
