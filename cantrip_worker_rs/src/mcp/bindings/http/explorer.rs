use super::{Authorized, Inner};
use crate::explorer_operations::view;
use anyhow::{Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn explorer(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let (tool, request_type) = match operation {
            "explorer.list" => ("explorer_list", "explorer.directory.list"),
            "explorer.read" => ("explorer_read", "explorer.file.read"),
            "explorer.write" => ("explorer_write", "explorer.file.write"),
            _ => unreachable!("registered Explorer operation"),
        };
        let arguments = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let target = &arguments["target"];
        let surface = self.resolve_surface(authorization, target).await?;
        let writing = operation == "explorer.write";
        let mut request = json!({"type":request_type,"path":arguments["path"]});
        if writing {
            request["content"] = arguments["content"].clone();
            request["version"] = arguments["version"].clone();
        }
        let (result, opened) = surface
            .exchange(
                operation,
                "request",
                "explorerOperationRequestContentSchema",
                &request,
            )
            .await?;
        let (summary, data) = match operation {
            "explorer.list" => directory_page(&opened, &arguments)?,
            "explorer.read" => file_read(&opened, &arguments)?,
            "explorer.write" => file_receipt(&opened)?,
            _ => unreachable!("registered Explorer operation"),
        };
        let response = json!({
            "summary":summary,"target":target,"data":data,"mutated":writing,
            "worktreeId":if writing { surface.worktree() } else { &result["worktreeId"] },
            "continuationScheduled":false,
        });
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&response)).map_err(response_error)
    }
}

fn directory_page(result: &Value, arguments: &Value) -> Result<(Value, Value)> {
    ensure!(
        result["type"] == "explorer.directory.list",
        "Explorer returned an unexpected protected result."
    );
    let cursor = arguments["cursor"].as_u64().expect("validated cursor") as usize;
    let limit = arguments["limit"].as_u64().expect("validated limit") as usize;
    let page = view::directory_page(&result["value"], cursor, limit);
    let count = page["entries"]
        .as_array()
        .expect("Explorer page entries")
        .len();
    let noun = if count == 1 { "entry" } else { "entries" };
    Ok((json!(format!("Found {count} Explorer {noun}.")), page))
}

fn file_read(result: &Value, arguments: &Value) -> Result<(Value, Value)> {
    ensure!(
        result["type"] == "explorer.file",
        "Explorer returned an unexpected protected file."
    );
    let maximum = arguments["maxChars"].as_u64().expect("validated maxChars") as usize;
    Ok(view::text_preview(result["value"].clone(), maximum))
}

fn file_receipt(result: &Value) -> Result<(Value, Value)> {
    ensure!(
        result["type"] == "explorer.file",
        "Explorer returned an unexpected protected write result."
    );
    let mut file = result["value"]
        .as_object()
        .expect("validated Explorer file")
        .clone();
    file.shift_remove("content");
    Ok((
        view::file_summary("Saved ", &result["value"]["path"], "."),
        Value::Object(file),
    ))
}
