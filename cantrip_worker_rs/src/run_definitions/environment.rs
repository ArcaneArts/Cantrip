use super::{
    diagnostic,
    repository::{MAX_BYTES, digest, optional, read_regular},
};
use crate::filesystem::paths;
use anyhow::Result;
use cantrip_wire::{Value, value::json};
use std::{fs, path::Path};

const SOURCE: &str = ".codex/environments/environment.toml";

pub(super) fn status(root: &Path, enabled: bool) -> Result<Value> {
    let source = inspect(root)?;
    let mut result = match source {
        Source::Absent => {
            json!({"configured":false,"valid":true,"revision":Value::Null,"hasSetup":false,"diagnostics":Vec::<Value>::new()})
        }
        Source::Ready { revision, setup } => {
            json!({"configured":true,"valid":true,"revision":revision,"hasSetup":setup.is_some(),"diagnostics":Vec::<Value>::new()})
        }
        Source::Invalid {
            revision,
            configured,
            diagnostic,
        } => {
            json!({"configured":configured,"valid":false,"revision":revision,"hasSetup":false,"diagnostics":vec![diagnostic]})
        }
    };
    result["enabled"] = json!(enabled);
    Ok(result)
}

pub(crate) enum Source {
    Absent,
    Ready {
        revision: String,
        setup: Option<String>,
    },
    Invalid {
        revision: Option<String>,
        configured: bool,
        diagnostic: Value,
    },
}

fn invalid(
    configured: bool,
    revision: Option<String>,
    code: &str,
    message: &str,
    field: Option<String>,
) -> Source {
    Source::Invalid {
        revision,
        configured,
        diagnostic: diagnostic(code, message, Some(SOURCE), json!(field)),
    }
}

pub(crate) fn inspect(root: &Path) -> Result<Source> {
    let directory = root.join(".codex/environments");
    let Some(metadata) = optional(fs::symlink_metadata(&directory))? else {
        return Ok(Source::Absent);
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(invalid(
            false,
            None,
            "codex-environment-directory-unsafe",
            "The Codex environment directory must be a real directory inside Primary.",
            None,
        ));
    }
    if !paths::within(root, &paths::canonical_sync(&directory)?) {
        return Ok(invalid(
            false,
            None,
            "codex-environment-directory-escape",
            "The Codex environment directory resolves outside Primary.",
            None,
        ));
    }
    let path = directory.join("environment.toml");
    let Some(metadata) = optional(fs::symlink_metadata(&path))? else {
        return Ok(Source::Absent);
    };
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Ok(invalid(
            true,
            None,
            "codex-environment-file-unsafe",
            "The Codex environment must be a bounded real file inside Primary.",
            None,
        ));
    }
    if !paths::within(root, &paths::canonical_sync(&path)?) {
        return Ok(invalid(
            true,
            None,
            "codex-environment-file-escape",
            "The Codex environment resolves outside Primary.",
            None,
        ));
    }
    let Ok(bytes) = read_regular(&path) else {
        return Ok(invalid(
            true,
            None,
            "codex-environment-file-unsafe",
            "The Codex environment changed or became unreadable while it was inspected.",
            None,
        ));
    };
    let revision = digest(&bytes);
    let text = String::from_utf8_lossy(&bytes);
    if text.contains('\0') {
        return Ok(invalid(
            true,
            Some(revision),
            "codex-environment-file-invalid",
            "The Codex environment contains a NUL character.",
            None,
        ));
    }
    let Ok(toml) = text.parse::<toml::Table>() else {
        return Ok(invalid(
            true,
            Some(revision),
            "codex-environment-toml-invalid",
            "The Codex environment is not valid TOML.",
            None,
        ));
    };
    match setup(&toml, crate::platform::platform()) {
        Ok(setup) => Ok(Source::Ready { revision, setup }),
        Err((field, message)) => Ok(invalid(
            true,
            Some(revision),
            "codex-environment-setup-invalid",
            &message,
            Some(field),
        )),
    }
}

fn setup(
    table: &toml::Table,
    platform: &str,
) -> std::result::Result<Option<String>, (String, String)> {
    fn valid(value: Option<&toml::Value>) -> bool {
        value.and_then(toml::Value::as_str).is_some_and(|script| {
            !cantrip_wire::text::trim(script).is_empty()
                && script.encode_utf16().count() <= 100_000
                && !script.contains('\0')
        })
    }
    fn script_error(field: String) -> (String, String) {
        let message =
            format!("{field} must be a non-empty script no longer than 100,000 characters.");
        (field, message)
    }
    let Some(setup) = table.get("setup") else {
        return Ok(None);
    };
    let setup = setup
        .as_table()
        .ok_or_else(|| ("setup".into(), "setup must be a TOML table.".into()))?;
    let default = setup.get("script");
    if default.is_some() && !valid(default) {
        return Err(script_error("setup.script".into()));
    }
    let Some(platform_setup) = setup.get(platform) else {
        return Ok(default.and_then(toml::Value::as_str).map(str::to_owned));
    };
    let field = format!("setup.{platform}");
    let platform_setup = platform_setup
        .as_table()
        .ok_or_else(|| (field.clone(), format!("{field} must be a TOML table.")))?;
    if !valid(platform_setup.get("script")) {
        return Err(script_error(format!("{field}.script")));
    }
    Ok(platform_setup
        .get("script")
        .and_then(toml::Value::as_str)
        .map(str::to_owned))
}
