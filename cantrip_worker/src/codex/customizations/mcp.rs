use super::{TIMEOUT, Target, entries, integer, nonempty, optional};
use anyhow::{Result, ensure};
use cantrip_wire::{Value, value::json};
use std::collections::HashSet;

const RESOURCE_LIMIT: usize = 5_000_000;

pub(super) async fn inventory(target: &Target<'_>) -> Result<Vec<Value>> {
    let mut cursor = Value::Null;
    let mut seen = HashSet::new();
    let mut servers = Vec::new();
    loop {
        let response = target
            .runtime
            .request(
                "mcpServerStatus/list".into(),
                Some(json!({
                    "cursor":cursor,"limit":100,"detail":"full","threadId":target.thread,
                })),
                Some(TIMEOUT),
                None,
            )
            .await?
            .unwrap_or(Value::Null);
        servers.extend(entries(&response, "data").filter_map(server));
        let Some(next) = nonempty(&response["nextCursor"]) else {
            return Ok(servers);
        };
        ensure!(
            seen.insert(next.clone()),
            "Codex returned a repeated MCP status cursor."
        );
        cursor = json!(next);
    }
}

fn server(raw: &Value) -> Option<Value> {
    let name = nonempty(&raw["name"])?;
    let info = &raw["serverInfo"];
    let info = nonempty(&info["name"]).map(|name| json!({
        "name":name,"title":optional(&info["title"]),"description":optional(&info["description"]),
        "version":info["version"].as_js_string().cloned().unwrap_or_else(|| "".into()),"websiteUrl":optional(&info["websiteUrl"]),
    }));
    let tools = raw["tools"].as_object().into_iter().flat_map(|entries| entries.values()).filter_map(|tool| {
        let name = nonempty(&tool["name"])?;
        let schema = tool.get("inputSchema").filter(|schema| !schema.is_null()).cloned().unwrap_or_else(|| json!({}));
        Some(json!({"name":name,"title":optional(&tool["title"]),"description":optional(&tool["description"]),
            "inputSchema":schema,"outputSchema":tool["outputSchema"],
        }))
    }).collect::<Vec<_>>();
    let resources = entries(raw, "resources")
        .filter_map(|resource| {
            let mut row = resource_summary(resource, "uri")?;
            row["size"] = json!(integer(&resource["size"]));
            Some(row)
        })
        .collect::<Vec<_>>();
    let templates = entries(raw, "resourceTemplates")
        .filter_map(|entry| resource_summary(entry, "uriTemplate"))
        .collect::<Vec<_>>();
    Some(
        json!({"name":name,"serverInfo":info,"authStatus":raw["authStatus"].as_str().unwrap_or("unsupported"),
            "tools":tools,"resources":resources,"resourceTemplates":templates,
        }),
    )
}

fn resource_summary(raw: &Value, key: &str) -> Option<Value> {
    let uri = nonempty(&raw[key])?;
    let name = nonempty(&raw["name"])?;
    let mut row = json!({"name":name,"title":optional(&raw["title"]),"description":optional(&raw["description"]),"mimeType":optional(&raw["mimeType"])});
    row[key] = json!(uri);
    Some(row)
}

pub(super) async fn read(target: &Target<'_>, input: &Value) -> Result<Value> {
    let response = target
        .runtime
        .request(
            "mcpServer/resource/read".into(),
            Some(json!({
                "threadId":target.thread,"server":input["server"],"uri":input["uri"],
            })),
            Some(TIMEOUT),
            None,
        )
        .await?
        .unwrap_or(Value::Null);
    let mut contents = Vec::new();
    let mut length = 0;
    for entry in entries(&response, "contents") {
        let Some(uri) = nonempty(&entry["uri"]) else {
            continue;
        };
        let (kind, payload) = if let Some(text) = entry["text"].as_js_string() {
            ("text", text)
        } else if let Some(blob) = entry["blob"].as_js_string() {
            ("blob", blob)
        } else {
            continue;
        };
        length += payload.units().len();
        ensure!(
            length <= RESOURCE_LIMIT,
            "The MCP resource exceeds Cantrip's 5 MB transport limit."
        );
        let mut item = json!({"type":kind,"uri":uri,"mimeType":optional(&entry["mimeType"])});
        item[kind] = json!(payload);
        contents.push(item);
    }
    Ok(json!({"contents":contents}))
}

pub(super) async fn reload(target: &Target<'_>) -> Result<Value> {
    target.operation.assert_current()?;
    target
        .runtime
        .request("config/mcpServer/reload".into(), None, Some(TIMEOUT), None)
        .await?;
    Ok(json!({"reloaded":true}))
}
