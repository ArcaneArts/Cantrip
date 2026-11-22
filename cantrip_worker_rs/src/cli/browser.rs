use super::server::Relay;
use crate::{encryption::Service, http::checked, protected_content::protect_private_state};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::content::encrypt_private_label;
use cantrip_wire::{Value, value::json};
use url::Url;

pub(super) async fn open(
    server: &Relay<'_>,
    encryption: &Service,
    request: &Value,
    id: &str,
) -> Result<Value> {
    let input = &request["arguments"];
    let url = input["url"]
        .as_js_string()
        .filter(|url| url.len() <= 4096)
        .and_then(|url| Url::parse(&url.lossy()).ok())
        .context("Browser navigation needs a valid URL.")?;
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Browser navigation requires HTTP or HTTPS."
    );
    let context = &request["context"];
    let mut selector = json!({});
    if let Some(target) = input["target"].as_js_string() {
        selector["target"] = json!(target);
    }
    let resolved = server
        .execute(
            json!({"command":"target.resolve-browser","context":context,"arguments":selector}),
            &format!("{id}:resolve-browser"),
        )
        .await?;
    let target = checked("executionTargetSchema", &resolved["target"])?;
    let (owner, server_id) = encryption.bound_identity()?;
    ensure!(
        resolved["data"]["serverId"] == server_id,
        "The browser target belongs to another server."
    );
    let (command, request_id, mut arguments, surface_id, revision) = if target["kind"] == "surface"
        && target["surfaceKind"] == "browser"
    {
        let current = resolved["data"]["stateRevision"]
            .as_u64()
            .filter(|revision| *revision > 0)
            .context("The browser target has no usable encrypted state.")?;
        let next = current
            .checked_add(1)
            .context("The browser target has no usable encrypted state.")?;
        let surface_id = target["surfaceId"].clone();
        (
            "browser.open",
            id.to_owned(),
            json!({"target":surface_id,"expectedStateRevision":current}),
            surface_id,
            next,
        )
    } else {
        let surface_id = json!(uuid::Uuid::new_v4().to_string());
        let grant = encryption.bound_component("private-surface-metadata", None)?;
        ensure!(
            grant.owner_id == owner && grant.server_id == server_id,
            "The browser encryption binding changed."
        );
        let title = encrypt_private_label(
            &grant.component.key,
            &json!({"ownerId":owner,"rowId":surface_id,"recordKind":"browser","keyRevision":grant.component.key_revision}),
            &json!("Browser"),
        )?;
        (
            "browser.create",
            format!("{id}:create-browser"),
            json!({"id":surface_id,"target":target,"titleProtection":title}),
            surface_id,
            1,
        )
    };
    arguments["stateProtection"] = protect_private_state(
        encryption,
        &owner,
        &json!({
            "serverId":server_id,"resource":"browser-row","resourceId":surface_id,
            "operationId":Value::Null,"recordKind":"browser-state",
        }),
        &json!({
            "version":1,"classification":json!({"recordKind":"browser-state"}),
            "revision":revision,"url":url.as_str(),
        }),
    )?;
    ensure!(
        encryption.bound_identity()? == (owner, server_id),
        "The browser encryption binding changed."
    );
    let result = server
        .execute(
            json!({"command":command,"context":context,"arguments":arguments}),
            &request_id,
        )
        .await?;
    ensure!(
        result["target"]
            == json!({"kind":"surface","projectId":target["projectId"],"surfaceKind":"browser","surfaceId":surface_id}),
        "Cantrip returned a different Browser target."
    );
    let browser = checked("browserWireSummarySchema", &result["data"])
        .map_err(|_| anyhow!("Cantrip returned invalid Browser state."))?;
    ensure!(
        browser["id"] == surface_id
            && browser["projectId"] == target["projectId"]
            && browser["stateRevision"].as_u64() == Some(revision),
        "Cantrip returned stale Browser state."
    );
    Ok(result)
}
