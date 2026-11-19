//! Resolve surfaces through Core and protect the associated operation locally.
use super::server::Server;
use crate::{
    encryption::Service,
    http::checked,
    protected_content::{open_surface_content, protect_surface_content},
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, coercion, value::json};

pub(super) async fn execute(
    server: &Server,
    encryption: &Service,
    request: &Value,
    request_id: &str,
) -> Result<Value> {
    let command = request["command"].as_str().context("CLI surface command")?;
    let (kind, _) = command.split_once('.').context("CLI surface kind")?;
    let surface = Surface::resolve(server, encryption, kind, request, request_id).await?;
    let arguments = &request["arguments"];
    let content = match command {
        "explorer.list" => {
            let path = match &arguments["path"] {
                Value::Null => JsString::from(""),
                value => coercion::string(value)
                    .map_err(|_| anyhow::anyhow!("Invalid Explorer path."))?,
            };
            json!({"type":"explorer.directory.list","path":path})
        }
        "explorer.read" => json!({"type":"explorer.file.read","path":arguments["path"]}),
        "explorer.write" => {
            // Use the same authorized surface for both the version read and the
            // write. Only the resource worker can compare the current version.
            let (_, current) = surface
                .exchange(
                    "explorer.read",
                    &format!("{request_id}:current-version"),
                    &json!({"type":"explorer.file.read","path":arguments["path"]}),
                )
                .await?;
            expect(
                &current,
                "explorer.file",
                "Explorer returned an unexpected protected file.",
            )?;
            let version = current["value"]["version"]
                .as_js_string()
                .context("Explorer did not return a protected file version.")?;
            json!({"type":"explorer.file.write","path":arguments["path"],"content":arguments["content"],"version":version})
        }
        "terminal.read" => {
            let max = arguments.get("maxChars").filter(|value| !value.is_null());
            json!({"type":"terminal.snapshot","maxChars":max.cloned().unwrap_or_else(|| json!(20_000))})
        }
        "terminal.send" => json!({"type":"terminal.input","data":arguments["data"]}),
        _ => unreachable!("registered CLI surface command"),
    };
    let (mut relayed, mut result) = surface.exchange(command, request_id, &content).await?;
    match command {
        "explorer.list" => list(&mut relayed, &result, arguments)?,
        "explorer.read" => read(&mut relayed, result, arguments)?,
        "explorer.write" => {
            expect(
                &result,
                "explorer.file",
                "Explorer returned an unexpected protected file.",
            )?;
            let file = &result["value"];
            relayed["summary"] = file_summary("Saved ", &file["path"], ".");
            relayed["mutated"] = json!(true);
            relayed["data"] = file.clone();
        }
        "terminal.read" => {
            expect(
                &result,
                "terminal.snapshot",
                "Terminal returned an unexpected protected snapshot.",
            )?;
            let status = result["status"].as_str().context("Terminal status")?;
            let suffix = if result["truncated"] == true {
                "; scrollback was truncated"
            } else {
                ""
            };
            relayed["summary"] = json!(format!("Terminal is {status}{suffix}."));
            let Value::Object(snapshot) = &mut result else {
                unreachable!("validated terminal snapshot")
            };
            snapshot.shift_remove(&JsString::from("type"));
            relayed["data"] = result;
        }
        "terminal.send" => {
            expect(
                &result,
                "terminal.input.accepted",
                "Terminal returned an unexpected protected result.",
            )?;
            relayed["summary"] = json!("Sent encrypted terminal input.");
            relayed["mutated"] = json!(true);
        }
        _ => unreachable!("registered CLI surface command"),
    }
    checked("cantripCliCommandResultSchema", &relayed)
}

struct Surface<'a> {
    server: &'a Server,
    encryption: &'a Service,
    context: &'a Value,
    target: Value,
    server_id: Value,
}

impl<'a> Surface<'a> {
    async fn resolve(
        server: &'a Server,
        encryption: &'a Service,
        kind: &str,
        request: &'a Value,
        id: &str,
    ) -> Result<Self> {
        let context = &request["context"];
        let mut arguments = json!({});
        if let Some(target) = request["arguments"]["target"].as_js_string() {
            arguments["target"] = json!(target);
        }
        let command = format!("target.resolve-{kind}");
        let resolved = server
            .execute(
                json!({"command":command,"context":context,"arguments":arguments}),
                &format!("{id}:resolve-{kind}"),
            )
            .await?;
        let target = checked("executionTargetSchema", &resolved["target"])?;
        let server_id = encryption.server_identity()?;
        ensure!(
            target["kind"] == "surface"
                && target["surfaceKind"] == kind
                && resolved["data"]["serverId"] == server_id,
            "The {kind} target cannot receive encrypted operations."
        );
        Ok(Self {
            server,
            encryption,
            context,
            target,
            server_id,
        })
    }

    async fn exchange(
        &self,
        command: &str,
        request_id: &str,
        content: &Value,
    ) -> Result<(Value, Value)> {
        let operation_id = uuid::Uuid::new_v4().to_string();
        let sequence = 0;
        let (schema, direction) = match command {
            "terminal.read" => ("terminalSnapshotRequestContentSchema", "request"),
            "terminal.send" => ("terminalInputContentSchema", "input"),
            _ => ("explorerOperationRequestContentSchema", "request"),
        };
        let mut binding = json!({
            "serverId":self.server_id, "surfaceKind":self.target["surfaceKind"], "surfaceId":self.target["surfaceId"],
            "operationId":operation_id, "direction":direction, "sequence":sequence,
        });
        let protected = protect_surface_content(self.encryption, &binding, content, schema)?;
        let mut relayed = self
            .server
            .execute(
                json!({
                    "command":command, "context":self.context,
                    "arguments":json!({
                        "target":self.target["surfaceId"], "operationId":operation_id,
                        "sequence":sequence, "protectedRequest":protected,
                    }),
                }),
                request_id,
            )
            .await?;
        let wire = checked("surfaceStreamWireResponseSchema", &relayed["data"])?;
        ensure!(
            wire["operationId"] == operation_id.as_str()
                && wire["sequence"].as_u64() == Some(sequence),
            "The protected surface response is stale."
        );
        ensure!(
            relayed["target"] == self.target,
            "The protected surface response belongs to a different target."
        );
        binding["direction"] = json!("response");
        let outcome = open_surface_content(
            self.encryption,
            &binding,
            &wire["protectedResponse"],
            "surfaceOperationOutcomeContentSchema",
        )?;
        if outcome["ok"] != true {
            bail!(
                "{}",
                outcome["error"]
                    .as_js_string()
                    .context("Protected surface error")?
            );
        }
        relayed["data"] = Value::Null;
        Ok((relayed, outcome["result"].clone()))
    }
}

fn expect(value: &Value, kind: &str, detail: &str) -> Result<()> {
    ensure!(value["type"] == kind, "{detail}");
    Ok(())
}

fn bounded_integer(
    value: &Value,
    default: usize,
    minimum: f64,
    maximum: f64,
    error: &str,
) -> Result<usize> {
    if value.is_null() {
        return Ok(default);
    }
    let value = coercion::number(Some(value)).map_err(|_| anyhow::anyhow!("{error}"))?;
    ensure!(
        value.fract() == 0.0 && (minimum..=maximum).contains(&value),
        "{error}"
    );
    Ok(value as usize)
}

fn list(relayed: &mut Value, result: &Value, arguments: &Value) -> Result<()> {
    expect(
        result,
        "explorer.directory.list",
        "Explorer returned an unexpected protected result.",
    )?;
    let cursor = bounded_integer(
        &arguments["cursor"],
        0,
        0.0,
        999.0,
        "Explorer pagination is invalid.",
    )?;
    let limit = bounded_integer(
        &arguments["limit"],
        100,
        1.0,
        200.0,
        "Explorer pagination is invalid.",
    )?;
    let directory = &result["value"];
    let entries = directory["entries"]
        .as_array()
        .context("Explorer directory entries")?;
    let page = entries
        .iter()
        .skip(cursor)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let next = (cursor + page.len() < entries.len()).then_some(cursor + page.len());
    let summary = format!("Found {} encrypted Explorer entries.", page.len());
    relayed["summary"] = json!(summary);
    relayed["data"] = json!({
        "path":directory["path"], "entries":page,"cursor":cursor, "nextCursor":next,
        "total":entries.len(), "truncated":directory["truncated"] == true || next.is_some(),
    });
    Ok(())
}

fn read(relayed: &mut Value, result: Value, arguments: &Value) -> Result<()> {
    expect(
        &result,
        "explorer.file",
        "Explorer returned an unexpected protected file.",
    )?;
    let maximum = bounded_integer(
        &arguments["maxChars"],
        100_000,
        1.0,
        200_000.0,
        "maxChars is invalid.",
    )?;
    let mut file = result["value"].clone();
    let content = file["content"]
        .as_js_string()
        .context("Explorer file content")?;
    let truncated = content.len() > maximum;
    if truncated {
        file["content"] = json!(JsString::new(content.units()[..maximum].to_vec()));
    }
    file["truncated"] = json!(truncated);
    let suffix = if truncated {
        " (content truncated)."
    } else {
        "."
    };
    relayed["summary"] = file_summary("Read ", &file["path"], suffix);
    relayed["data"] = file;
    Ok(())
}

fn file_summary(prefix: &str, path: &Value, suffix: &str) -> Value {
    let path = path.as_js_string().expect("validated Explorer file path");
    json!(JsString::new(
        prefix
            .encode_utf16()
            .chain(path.units().iter().copied())
            .chain(suffix.encode_utf16())
            .collect()
    ))
}
