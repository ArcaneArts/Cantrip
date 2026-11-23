use super::{collator, diagnostic};
use crate::filesystem::paths;
use anyhow::{Result, anyhow, bail};
use cantrip_protocol::{ValidationError, parse, parse_property};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const DIRECTORY: &str = ".cantrip/run-configurations";
const MAX_FILES: usize = 128;
pub(super) const MAX_BYTES: u64 = 512 * 1024;
const MAX_DIAGNOSTICS: usize = 200;

pub(crate) struct Repository {
    root: PathBuf,
}

impl Repository {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn directory(&self, create: bool) -> Result<Option<PathBuf>> {
        let mut parent = self.root.clone();
        for name in [".cantrip", "run-configurations"] {
            let target = parent.join(name);
            if create {
                match fs::create_dir(&target) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let Some(metadata) = optional(fs::symlink_metadata(&target))? else {
                return Ok(None);
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                bail!("{} must be a real directory.", target.display());
            }
            let canonical = paths::canonical_sync(&target)?;
            if !paths::within(&parent, &canonical) {
                bail!(
                    "{} resolves outside its parent directory.",
                    target.display()
                );
            }
            parent = canonical;
        }
        Ok(Some(parent))
    }

    pub(crate) fn scan(&self) -> Result<Value> {
        let failure = |code, error: &dyn std::fmt::Display| {
            inventory(
                vec![],
                vec![diagnostic(
                    code,
                    &error.to_string(),
                    Some(DIRECTORY),
                    Value::Null,
                )],
            )
        };
        let dir = match self.directory(false) {
            Ok(Some(dir)) => dir,
            Ok(None) => return Ok(inventory(vec![], vec![])),
            Err(error) => return Ok(failure("directory-invalid", &error)),
        };
        let entries =
            fs::read_dir(&dir).and_then(|entries| entries.collect::<io::Result<Vec<_>>>());
        let mut entries = match entries {
            Ok(entries) => entries,
            Err(error) => return Ok(failure("directory-unreadable", &error)),
        };
        entries.retain(|entry| !temporary(&entry.file_name().to_string_lossy()));
        let collator = collator()?;
        entries.sort_by(|a, b| collator.compare_utf16(name(a).units(), name(b).units()));
        let diagnostics = if entries.len() > MAX_FILES {
            vec![diagnostic(
                "file-limit-exceeded",
                "Only the first 128 Run configuration paths are inspected.",
                Some(DIRECTORY),
                Value::Null,
            )]
        } else {
            vec![]
        };
        let mut inspected = Vec::new();
        for candidate in entries.into_iter().take(MAX_FILES) {
            let name = name(&candidate);
            let relative = relative(&name);
            if !candidate.file_type().is_ok_and(|kind| kind.is_file()) {
                inspected.push(problem(&relative, "unsupported", Value::Null, Value::Null,
                    "path-unsupported", "Only regular JSON files are inspected; directories and symlinks are never followed.", Value::Null));
            } else {
                inspected.push(inspect(&dir, &name));
            }
        }
        // A structurally valid document participates in name conflicts even if
        // its filename disagrees with its identity.
        let mut names = std::collections::HashMap::new();
        for entry in &inspected {
            if let Some(name) = entry["document"]["name"].as_js_string() {
                *names.entry(name.lowercase()).or_insert(0_usize) += 1;
            }
        }
        for entry in &mut inspected {
            if let Some(name) = entry["document"]["name"].as_js_string()
                && names[&name.lowercase()] > 1
            {
                entry["status"] = json!("invalid");
                let duplicate = diagnostic(
                    "name-duplicate",
                    "Run configuration names must be unique within a project.",
                    entry["relativePath"].as_str(),
                    json!("name"),
                );
                if let Value::Array(diagnostics) = &mut entry["diagnostics"]
                    && diagnostics.len() < MAX_DIAGNOSTICS
                {
                    diagnostics.push(duplicate);
                }
            }
        }
        Ok(inventory(inspected, diagnostics))
    }

    pub(crate) fn read(&self, id: &str) -> Result<Option<Value>> {
        let Some(dir) = self.directory(false)? else {
            return Ok(None);
        };
        let name = format!("{id}.json");
        if optional(fs::symlink_metadata(dir.join(&name)))?.is_none() {
            return Ok(None);
        }
        Ok(Some(inspect(&dir, &name.into())))
    }

    pub(super) fn write(&self, request: &Value) -> Result<Value> {
        let document = document(&request["document"])
            .map_err(|_| anyhow!("Invalid Run configuration definition."))?;
        let id = document["id"].as_str().expect("validated configuration ID");
        let expected = &request["expectedRevision"];
        let current = self.read(id)?;
        if let Some(failure) = conflict(id, expected, current.as_ref()) {
            return Ok(failure);
        }
        let name = document["name"].as_js_string().unwrap().lowercase();
        if let Some(conflicting) =
            self.scan()?["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| {
                    entry["document"]["id"] != id
                        && entry["document"]["name"]
                            .as_js_string()
                            .is_some_and(|other| other.lowercase() == name)
                })
        {
            return Ok(write_failure(
                "name-conflict",
                id,
                current.as_ref(),
                &conflicting["document"]["id"],
            ));
        }

        let mut encoded = document.stringify_pretty();
        encoded.push('\n');
        let revision = digest(encoded.as_bytes());
        if let Some(current) = &current
            && current["status"] == "ready"
            && current["revision"] == revision
        {
            return Ok(json!({"outcome":"unchanged","entry":current}));
        }
        let directory = self
            .directory(true)?
            .ok_or_else(|| anyhow!("Could not create the Run configuration directory."))?;
        let target = directory.join(format!("{id}.json"));
        let prefix = format!(".{id}.");
        let suffix = format!(".{}.tmp", uuid::Uuid::new_v4());
        let mut temporary = tempfile::Builder::new()
            .prefix(&prefix)
            .rand_bytes(0)
            .suffix(&suffix)
            .tempfile_in(&directory)?;
        temporary.write_all(encoded.as_bytes())?;
        temporary.as_file().sync_all()?;
        if expected.is_null() {
            match temporary.persist_noclobber(&target) {
                Ok(_) => {}
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                    return Ok(write_failure(
                        "already-exists",
                        id,
                        self.read(id)?.as_ref(),
                        &Value::Null,
                    ));
                }
                Err(error) => return Err(error.error.into()),
            }
        } else {
            if let Some(failure) = conflict(id, expected, self.read(id)?.as_ref()) {
                return Ok(failure);
            }
            temporary.persist(&target).map_err(|error| error.error)?;
        }
        let written = self
            .read(id)?
            .filter(|entry| entry["status"] == "ready")
            .ok_or_else(|| anyhow!("The written Run configuration could not be verified."))?;
        Ok(json!({"outcome":if current.is_some() {"updated"} else {"created"},"entry":written}))
    }

    pub(super) fn delete(&self, request: &Value) -> Result<Value> {
        let id = request["id"].as_str().expect("validated configuration ID");
        let expected = &request["expectedRevision"];
        let attempt = |entry: Option<Value>| match entry {
            Some(entry) if &entry["revision"] == expected => None,
            Some(entry) => Some(
                json!({"outcome":"revision-mismatch","id":id,"currentRevision":entry["revision"]}),
            ),
            None => Some(json!({"outcome":"not-found","id":id,"currentRevision":Value::Null})),
        };
        if let Some(failure) = attempt(self.read(id)?) {
            return Ok(failure);
        }
        let directory = self.directory(false)?;
        if let Some(failure) = attempt(self.read(id)?) {
            return Ok(failure);
        }
        let Some(directory) = directory else {
            return Ok(json!({"outcome":"not-found","id":id,"currentRevision":Value::Null}));
        };
        fs::remove_file(directory.join(format!("{id}.json")))?;
        Ok(json!({"outcome":"deleted","id":id,"revision":expected}))
    }
}

fn name(entry: &fs::DirEntry) -> JsString {
    paths::text(Path::new(&entry.file_name()))
}

fn relative(name: &JsString) -> JsString {
    JsString::new(
        DIRECTORY
            .encode_utf16()
            .chain([47])
            .chain(name.units().iter().copied())
            .collect(),
    )
}

fn temporary(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|name| name.strip_suffix(".tmp"))
        .is_some_and(|name| {
            let Some((id, nonce)) = name.split_once('.') else {
                return false;
            };
            [id, nonce].into_iter().all(|part| {
                part.len() == 36
                    && part.bytes().all(|byte| {
                        byte == b'-' || byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
                    })
            })
        })
}

fn inventory(entries: Vec<Value>, diagnostics: Vec<Value>) -> Value {
    json!({"directory":DIRECTORY,"entries":entries,"diagnostics":diagnostics})
}

pub(crate) fn document(value: &Value) -> std::result::Result<Value, ValidationError> {
    parse_property("runConfigurationApiWriteRequestSchema", "document", value)
}

fn entry(
    relative: &JsString,
    status: &str,
    id: Value,
    revision: Value,
    document: Value,
    diagnostics: Vec<Value>,
) -> Value {
    json!({"relativePath":relative,"status":status,"id":id,"revision":revision,"document":document,"diagnostics":diagnostics})
}

fn problem(
    relative: &JsString,
    status: &str,
    id: Value,
    revision: Value,
    code: &str,
    message: &str,
    field: Value,
) -> Value {
    entry(
        relative,
        status,
        id,
        revision,
        Value::Null,
        vec![diagnostic(code, message, relative.as_str(), field)],
    )
}

fn inspect(dir: &Path, name: &JsString) -> Value {
    let relative = relative(name);
    let native = paths::native(name);
    if !native
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return problem(
            &relative,
            "unsupported",
            Value::Null,
            Value::Null,
            "extension-unsupported",
            "Run configuration definitions must use the .json extension.",
            Value::Null,
        );
    }
    let Some(file_id) = name
        .as_str()
        .and_then(|name| name.strip_suffix(".json"))
        .and_then(|id| parse("runConfigurationIdSchema", Some(&json!(id))).ok())
    else {
        return problem(
            &relative,
            "invalid",
            Value::Null,
            Value::Null,
            "filename-invalid",
            "Run configuration filenames must be lowercase UUIDs with a .json extension.",
            Value::Null,
        );
    };
    let bytes = match optional(read_regular(&dir.join(native))) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            return problem(
                &relative,
                "invalid",
                file_id,
                Value::Null,
                "file-missing",
                "The Run configuration disappeared while it was read.",
                Value::Null,
            );
        }
        Err(error) => {
            return problem(
                &relative,
                "invalid",
                file_id,
                Value::Null,
                "file-invalid",
                &error.to_string(),
                Value::Null,
            );
        }
    };
    let revision = json!(digest(&bytes));
    let invalid = |code, message: &str, field| {
        problem(
            &relative,
            "invalid",
            file_id.clone(),
            revision.clone(),
            code,
            message,
            field,
        )
    };
    let text = String::from_utf8_lossy(&bytes);
    if text.contains('\0') {
        return invalid(
            "nul-rejected",
            "Run configuration files cannot contain NUL characters.",
            Value::Null,
        );
    }
    let value = match parse_json_text(&text) {
        Ok(value) => value,
        Err(error) => return invalid("json-invalid", &error.lossy(), Value::Null),
    };
    if value["schema"] == "cantrip.run-configuration" {
        if parse("runConfigurationIdSchema", value.get("id")).is_err() {
            return invalid(
                "schema-invalid",
                "Unsupported Run configurations still require a valid ID.",
                json!("id"),
            );
        }
        if value["id"] != file_id {
            return invalid(
                "identity-mismatch",
                "The document ID must match its lowercase UUID filename.",
                json!("id"),
            );
        }
        if value["version"] != 1 {
            return invalid(
                "version-unsupported",
                "This Run configuration version is not supported.",
                json!("version"),
            );
        }
        if let Some(provider) = value["provider"].as_str()
            && !matches!(
                provider,
                "shell" | "node" | "java" | "dart" | "flutter" | "rust"
            )
        {
            return problem(
                &relative,
                "unsupported",
                file_id,
                revision,
                "provider-unavailable",
                &format!("The {provider} Run configuration provider is not available yet."),
                json!("provider"),
            );
        }
    }
    match document(&value) {
        Ok(document) => entry(&relative, "ready", file_id, revision, document, vec![]),
        Err(ValidationError::Invalid(issues)) => {
            let diagnostics = issues
                .iter()
                .take(MAX_DIAGNOSTICS)
                .map(|issue| {
                    let mut diagnostic = diagnostic(
                        "schema-invalid",
                        issue["message"]
                            .as_str()
                            .unwrap_or("Invalid Run configuration."),
                        relative.as_str(),
                        Value::Null,
                    );
                    if let Some(path) = issue["path"].as_array().filter(|path| !path.is_empty()) {
                        diagnostic["field"] = json!(
                            path.iter()
                                .map(|piece| piece
                                    .as_str()
                                    .map_or_else(|| piece.stringify(), str::to_owned))
                                .collect::<Vec<_>>()
                                .join(".")
                        );
                    }
                    diagnostic
                })
                .collect();
            entry(
                &relative,
                "invalid",
                file_id,
                revision,
                Value::Null,
                diagnostics,
            )
        }
        Err(ValidationError::Operation) => {
            invalid("schema-invalid", "Invalid Run configuration.", Value::Null)
        }
    }
}

fn conflict(id: &str, expected: &Value, current: Option<&Value>) -> Option<Value> {
    let outcome = match (expected.is_null(), current) {
        (true, Some(_)) => "already-exists",
        (false, None) => "not-found",
        (false, Some(entry)) if &entry["revision"] != expected => "revision-mismatch",
        _ => return None,
    };
    Some(write_failure(outcome, id, current, &Value::Null))
}

fn write_failure(outcome: &str, id: &str, current: Option<&Value>, conflicting: &Value) -> Value {
    let revision = current.map(|entry| &entry["revision"]);
    json!({"outcome":outcome,"id":id,"currentRevision":revision,"conflictingId":conflicting})
}

pub(super) fn optional<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn read_regular(path: &Path) -> io::Result<Vec<u8>> {
    read_bounded(path, MAX_BYTES)
}

pub(crate) fn read_bounded(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::other(
            "Run configuration paths must be regular files.",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other(
            "Run configuration paths must be regular files.",
        ));
    }
    let mut bytes = Vec::new();
    if metadata.len() <= maximum {
        file.take(maximum + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 <= maximum {
            return Ok(bytes);
        }
    }
    Err(io::Error::other(
        "Run configuration files cannot exceed 524288 bytes.",
    ))
}
