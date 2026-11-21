use super::{Authorized, Inner};
use crate::{http::checked, protected_content::protect_private_state};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};
use url::Url;

impl Inner {
    pub(super) async fn browser(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let tool = if operation == "browser.services" {
            "browser_services"
        } else {
            "browser_navigate"
        };
        let arguments = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let target = &arguments["target"];
        let result = if operation == "browser.services" {
            let result = self
                .relay_project(
                    authorization,
                    json!({"operation":operation,"arguments":arguments}),
                    &uuid::Uuid::new_v4().to_string(),
                )
                .await?;
            ensure!(
                &result["target"] == target,
                "Cantrip returned browser services for another target."
            );
            result
        } else {
            self.navigate_browser(authorization, target, &arguments["url"])
                .await?
        };
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&result)).map_err(response_error)
    }

    async fn navigate_browser(
        &self,
        authorization: &Authorized,
        target: &Value,
        url: &Value,
    ) -> Result<Value> {
        let surface = self.resolve_surface(authorization, target).await?;
        let revision = surface
            .state_revision()
            .context("The browser target has no usable protected state.")?;
        let url = url.as_js_string().context("Invalid Browser URL.")?;
        let url = Url::parse(&url.lossy())?.to_string();
        let encryption = self
            .encryption
            .as_deref()
            .context("Browser state encryption is unavailable.")?;
        let protection = protect_private_state(
            encryption,
            &authorization.identity.0,
            &json!({
                "serverId":surface.server_id(),"resource":"browser-row","resourceId":target["surfaceId"],
                "operationId":Value::Null,"recordKind":"browser-state",
            }),
            &json!({
                "version":1,"classification":json!({"recordKind":"browser-state"}),
                "revision":revision+1,"url":url,
            }),
        )?;
        let result = surface
            .invoke(
                "browser.open",
                json!({
                    "expectedStateRevision":revision,"stateProtection":protection,
                }),
            )
            .await?;
        let browser = checked("browserWireSummarySchema", &result["data"])?;
        ensure!(
            browser["id"] == target["surfaceId"]
                && browser["projectId"] == target["projectId"]
                && browser["stateRevision"].as_u64() == Some(revision + 1),
            "Cantrip returned stale browser navigation state."
        );
        Ok(json!({
            "summary":format!("Navigated the browser to {url}."),
            "target":target,"worktreeId":surface.worktree(),"continuationScheduled":false,
            "mutated":true,"data":json!({"url":url,"stateRevision":browser["stateRevision"]}),
        }))
    }
}
