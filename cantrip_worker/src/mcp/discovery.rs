//! Import candidates from known worker-local MCP configuration sources.
mod http;

use crate::{
    encryption::Service,
    filesystem::{Scope, paths},
    protected_secrets::protect_discovered_mcp_for_grant,
};
use anyhow::{Result, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, coercion, parse_json_text, value::json};
use regress::Regex;
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::LazyLock,
};
use tokio::{fs, io::AsyncReadExt};

pub(crate) const COMMAND: &str = "mcp.configurations.discover";
const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CANDIDATES: usize = 200;

pub(crate) async fn discover(
    service: &Service,
    project: Option<&JsString>,
    scope: &Scope,
) -> Result<Value> {
    let binding = service.bound_identity();
    let collected = async {
        let mut found = Discovery::default();
        let home = std::env::home_dir();
        let claude_user = if let Some(home) = home {
            found
                .scan(&home.join(".codex/config.toml"), Source::Codex, "user")
                .await;
            found
                .scan(&home.join(".claude.json"), Source::Claude, "user")
                .await
        } else {
            Value::Null
        };
        if let Some(project) = project {
            let project = paths::resolve(&paths::native(project))?;
            found
                .scan(
                    &project.join(".codex/config.toml"),
                    Source::Codex,
                    "project",
                )
                .await;
            found
                .scan(&project.join(".mcp.json"), Source::Claude, "project")
                .await;
            if let Some(matched) = matching_project(&claude_user["projects"], &project) {
                found.collect(matched, Source::Claude, "project");
            }
        }
        for configuration in http::discover(scope)
            .await?
            .into_iter()
            .take(MAX_CANDIDATES - found.candidates.len())
        {
            found.candidates.push(Candidate {
                source: "localhost",
                scope: "user",
                configuration,
            });
        }
        Ok::<_, anyhow::Error>(found)
    };
    let found = tokio::select! {
        result = collected => result?,
        _ = scope.stopped() => anyhow::bail!("MCP configuration discovery stopped."),
    };
    let mut candidates = Vec::with_capacity(found.candidates.len());
    if !found.candidates.is_empty() {
        let binding = binding?;
        let grant = service.bound_component("mcp-secret", None)?;
        ensure!(
            grant.owner_id == binding.0 && grant.server_id == binding.1,
            "The worker binding changed during MCP configuration discovery."
        );
        for candidate in found.candidates {
            scope.check()?;
            let protected = protect_discovered_mcp_for_grant(
                &grant,
                &json!(service.worker_id()),
                &candidate.configuration,
            )?;
            candidates.push(json!({
                "source":candidate.source, "sourceScope":candidate.scope, "configuration":protected,
            }));
        }
        ensure!(
            service.bound_identity()? == binding,
            "The worker binding changed during MCP configuration discovery."
        );
    }
    checked(
        "mcpServerDiscoveryResultSchema",
        &json!({
            "workerId":service.worker_id(),
            "observedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "candidates":candidates, "issues":found.issues,
        }),
    )
}

fn matching_project<'a>(projects: &'a Value, root: &Path) -> Option<&'a Value> {
    coercion::entries(projects.as_object()?)
        .into_iter()
        .find_map(|(path, value)| {
            (paths::resolve(&paths::native(path)).ok().as_deref() == Some(root)).then_some(value)
        })
}

#[derive(Default)]
struct Discovery {
    candidates: Vec<Candidate>,
    issues: Vec<Value>,
}

struct Candidate {
    source: &'static str,
    scope: &'static str,
    configuration: Value,
}

#[derive(Clone, Copy, PartialEq)]
enum Source {
    Codex,
    Claude,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Codex => "mcp_servers",
            Self::Claude => "mcpServers",
        }
    }

    fn file_kind(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
        }
    }
}

struct Issue {
    code: &'static str,
    message: &'static str,
}

fn invalid(message: &'static str) -> Issue {
    Issue {
        code: "invalid-config",
        message,
    }
}

impl Discovery {
    async fn scan(&mut self, path: &Path, source: Source, scope: &'static str) -> Value {
        let failure = match read_config(path).await {
            Ok(None) => return Value::Null,
            Ok(Some(content)) => {
                let document = match source {
                    Source::Codex => toml::from_str::<toml::Table>(&content)
                        .ok()
                        .map(|table| Value::from_serialize(&table)),
                    Source::Claude => parse_json_text(&content).ok(),
                };
                if let Some(document) = document {
                    self.collect(&document, source, scope);
                    return document;
                }
                "parsed"
            }
            Err(_) => "read",
        };
        let message = format!(
            "A {} MCP config file could not be {failure}.",
            source.file_kind()
        );
        self.issue(source, scope, "invalid-config", &message);
        Value::Null
    }

    fn collect(&mut self, document: &Value, source: Source, scope: &'static str) {
        if let Some(servers) = document[source.key()].as_object() {
            for (name, entry) in coercion::entries(servers) {
                if self.candidates.len() == MAX_CANDIDATES {
                    break;
                }
                if crate::protected_secrets::is_managed_mcp_name(name) {
                    continue;
                }
                match configuration(name, entry, source) {
                    Ok(configuration) => self.candidates.push(Candidate {
                        source: source.name(),
                        scope,
                        configuration,
                    }),
                    Err(issue) => self.issue(source, scope, issue.code, issue.message),
                }
            }
        }
    }

    fn issue(&mut self, source: Source, scope: &str, code: &str, message: &str) {
        self.issues.push(json!({
            "source":source.name(), "sourceScope":scope, "code":code, "message":message,
        }));
    }
}

async fn read_config(path: &Path) -> std::io::Result<Option<String>> {
    let result: std::io::Result<_> = async {
        let metadata = fs::metadata(path).await?;
        if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
            return Ok(None);
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NONBLOCK);
        let file = options.open(path).await?;
        if !file.metadata().await?.is_file() {
            return Ok(None);
        }
        let mut data = Vec::new();
        file.take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut data)
            .await?;
        Ok((data.len() as u64 <= MAX_CONFIG_BYTES)
            .then(|| String::from_utf8_lossy(&data).into_owned()))
    }
    .await;
    match result {
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            Ok(None)
        }
        other => other,
    }
}

fn text(value: &JsString, source: Source) -> Result<JsString, Issue> {
    if source == Source::Codex {
        return Ok(value.clone());
    }
    static ENVIRONMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::with_flags(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}", "u").unwrap()
    });
    let units = value.units();
    let mut expanded = Vec::with_capacity(units.len());
    let mut offset = 0;
    for matched in ENVIRONMENT.find_from_utf16(units, 0) {
        expanded.extend_from_slice(&units[offset..matched.start()]);
        let key = JsString::new(units[matched.group(1).unwrap()].to_vec());
        match std::env::var_os(key.as_str().unwrap()).filter(|value| !value.is_empty()) {
            Some(value) => expanded.extend_from_slice(paths::text(&PathBuf::from(value)).units()),
            None => match matched.group(2) {
                Some(fallback) => expanded.extend_from_slice(&units[fallback]),
                None => return Err(invalid("A required environment variable is unavailable.")),
            },
        }
        offset = matched.end();
    }
    expanded.extend_from_slice(&units[offset..]);
    Ok(JsString::new(expanded))
}

fn strings<const LIST: bool>(
    value: Option<&Value>,
    source: Source,
    invalid_message: &'static str,
) -> Result<Value, Issue> {
    let string = |item: &Value| {
        text(
            item.as_js_string()
                .ok_or_else(|| invalid(invalid_message))?,
            source,
        )
        .map(Value::String)
    };
    if LIST {
        return match value {
            None => Ok(Value::Array(Vec::new())),
            Some(value) => {
                let items = value.as_array().ok_or_else(|| invalid(invalid_message))?;
                items
                    .iter()
                    .map(string)
                    .collect::<Result<_, _>>()
                    .map(Value::Array)
            }
        };
    }
    match value {
        None => Ok(json!({})),
        Some(value) => {
            let items = value.as_object().ok_or_else(|| invalid(invalid_message))?;
            let entries = coercion::entries(items);
            entries
                .into_iter()
                .map(|(key, item)| Ok((key.clone(), string(item)?)))
                .collect::<Result<_, _>>()
                .map(Value::Object)
        }
    }
}

fn configuration(name: &JsString, entry: &Value, source: Source) -> Result<Value, Issue> {
    if !entry.is_object() {
        return Err(invalid("An MCP entry is not a server object."));
    }
    let kind = entry["type"].as_js_string();
    let config = if let Some(command) = entry["command"].as_js_string()
        && (source == Source::Codex || kind.is_none_or(|kind| kind.as_str() == Some("stdio")))
    {
        let message = "An MCP entry has invalid stdio arguments or environment.";
        let args = strings::<true>(entry.get("args"), source, message)?;
        let environment = strings::<false>(entry.get("env"), source, message)?;
        json!({
            "name":name,"enabled":true,"transport":"stdio",
            "command":text(command, source)?,"args":args,"environment":environment,
        })
    } else if let Some(url) = entry["url"].as_js_string()
        && (source == Source::Codex
            || kind.is_none_or(|kind| matches!(kind.as_str(), Some("http" | "streamable-http"))))
    {
        let message = "An MCP entry has invalid HTTP headers.";
        let (headers, environment_headers, bearer) = match source {
            Source::Codex => (
                strings::<false>(entry.get("http_headers"), source, message)?,
                strings::<false>(entry.get("env_http_headers"), source, message)?,
                entry["bearer_token_env_var"]
                    .as_js_string()
                    .map_or(Value::Null, |bearer| json!(bearer)),
            ),
            Source::Claude => (
                strings::<false>(entry.get("headers"), source, message)?,
                json!({}),
                Value::Null,
            ),
        };
        json!({
            "name":name,"enabled":true,"transport":"http","url":text(url, source)?,
            "bearerTokenEnvironmentVariable":bearer,"headers":headers,"environmentHeaders":environment_headers,
        })
    } else {
        return Err(Issue {
            code: "unsupported-transport",
            message: "An MCP entry does not use a supported stdio or HTTP transport.",
        });
    };
    // Validation paths can contain private header or environment keys.
    checked("mcpServerConfigurationSchema", &config)
        .map_err(|_| invalid("An MCP entry is not a valid importable configuration."))
}
