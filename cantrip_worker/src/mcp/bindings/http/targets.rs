use super::{Authorized, Inner};
use crate::{encryption::Service, http::checked, mcp::bindings::server::TargetInspection};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::decrypt_private_label;
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{JsString, Value, value::json};

impl Inner {
    pub(super) async fn target(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let list = operation == "target.list";
        let tool = if list {
            "target_list"
        } else {
            "target_inspect"
        };
        let arguments = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let mut result = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":arguments}),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        if list {
            let encryption = self
                .encryption
                .as_deref()
                .context("Target title encryption is unavailable.")?;
            result["data"] = open_catalog(encryption, authorization, &result["data"])?;
        } else {
            let inspection = TargetInspection::parse(&result)?;
            ensure!(
                result["target"] == arguments["target"]
                    && inspection.resolution["target"] == arguments["target"],
                "Cantrip returned an unrelated execution target."
            );
            result["data"] = inspection.resolution;
            result["data"]["stateRevision"] = inspection.state_revision;
        }
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&result)).map_err(response_error)
    }
}

fn open_catalog(encryption: &Service, authorization: &Authorized, raw: &Value) -> Result<Value> {
    let catalog = checked(
        "executionTargetWireCatalogSchema",
        &json!({"projectId":raw["projectId"],"targets":raw["targets"],"truncated":raw["truncated"]}),
    )?;
    ensure!(
        catalog["projectId"] == authorization.active.binding["projectId"],
        "Cantrip returned targets from another project."
    );
    let targets = catalog["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| open_target(encryption, authorization, target))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({
        "projectId":catalog["projectId"],"targets":targets,
        "cursor":raw["cursor"],"nextCursor":raw["nextCursor"],"total":raw["total"],
        "truncated":catalog["truncated"],
    }))
}

fn open_target(encryption: &Service, authorization: &Authorized, target: &Value) -> Result<Value> {
    let mut descriptor = target.as_object().unwrap().clone();
    let protection = descriptor
        .shift_remove(&JsString::from("titleProtection"))
        .unwrap();
    if !protection.is_null() {
        let revision = protection["protectedLabel"]["keyRevision"]
            .as_u64()
            .unwrap();
        let grant = encryption.bound_component("private-surface-metadata", Some(revision))?;
        ensure!(
            grant.owner_id == authorization.identity.0
                && grant.server_id.as_js_string() == Some(&authorization.identity.1),
            "The worker binding changed during protected target discovery."
        );
        let title = decrypt_private_label(
            &grant.component.key,
            &json!({"ownerId":grant.owner_id,"keyRevision":revision,
                "recordKind":protection["classification"]["recordKind"],"rowId":target["target"]["surfaceId"]}),
            &protection,
        )?;
        descriptor.insert("title".into(), title);
    }
    Ok(Value::Object(descriptor))
}
