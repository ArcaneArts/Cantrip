use super::{Authorized, Inner};
use crate::{
    http::checked, mcp::bindings::server::TargetInspection, protected_content::BoundSurfaceContent,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{Value, value::json};

pub(super) struct Surface<'a> {
    broker: &'a Inner,
    authorization: &'a Authorized,
    target: &'a Value,
    id: String,
    inspection: TargetInspection,
}

impl Inner {
    pub(super) async fn resolve_surface<'a>(
        &'a self,
        authorization: &'a Authorized,
        target: &'a Value,
    ) -> Result<Surface<'a>> {
        let binding = &authorization.active.binding;
        let kind = target["surfaceKind"]
            .as_str()
            .context("Missing surface kind.")?;
        ensure!(
            binding["contextKind"] == "project" && target["projectId"] == binding["projectId"],
            "The {kind} target cannot receive protected operations."
        );
        let id = uuid::Uuid::new_v4().to_string();
        let inspected = self
            .relay_project(
                authorization,
                json!({"operation":"target.inspect","arguments":json!({"target":target})}),
                &format!("{id}:inspect-target"),
            )
            .await?;
        let inspection = TargetInspection::parse(&inspected)?;
        ensure!(
            &inspected["target"] == target
                && &inspection.resolution["target"] == target
                && inspection.resolution["availability"] == "available"
                && inspection.resolution["placement"]["projectId"] == binding["projectId"]
                && inspection.server_id.as_js_string() == Some(&authorization.identity.1),
            "The {kind} target cannot receive protected operations."
        );
        Ok(Surface {
            broker: self,
            authorization,
            target,
            id,
            inspection,
        })
    }
}

impl Surface<'_> {
    pub(super) fn server_id(&self) -> &Value {
        &self.inspection.server_id
    }

    pub(super) fn state_revision(&self) -> Option<u64> {
        self.inspection.state_revision.as_u64()
    }

    pub(super) fn worktree(&self) -> &Value {
        &self.inspection.resolution["placement"]["worktreeId"]
    }

    pub(super) async fn invoke(&self, operation: &str, mut arguments: Value) -> Result<Value> {
        arguments["target"] = self.target.clone();
        let result = self
            .broker
            .relay_project(
                self.authorization,
                json!({"operation":operation,"arguments":arguments}),
                &self.id,
            )
            .await?;
        ensure!(
            &result["target"] == self.target,
            "Cantrip returned a different surface target."
        );
        Ok(result)
    }

    pub(super) async fn exchange(
        &self,
        operation: &str,
        direction: &str,
        schema: &str,
        request: &Value,
    ) -> Result<(Value, Value)> {
        let cipher = BoundSurfaceContent {
            service: self
                .broker
                .encryption
                .as_deref()
                .context("Surface stream encryption is unavailable.")?,
            owner_id: &self.authorization.identity.0,
        };
        let mut binding = json!({
            "serverId":self.inspection.server_id,"surfaceKind":self.target["surfaceKind"],"surfaceId":self.target["surfaceId"],
            "operationId":self.id,"direction":direction,"sequence":0,
        });
        let protected = cipher.seal(&binding, request, schema)?;
        let result = self
            .invoke(
                operation,
                json!({
                    "operationId":self.id,"sequence":0,"protectedRequest":protected,
                }),
            )
            .await?;
        let wire = checked("surfaceStreamWireResponseSchema", &result["data"])?;
        ensure!(
            wire["operationId"] == binding["operationId"]
                && wire["sequence"] == binding["sequence"],
            "The protected surface response is stale."
        );
        binding["direction"] = json!("response");
        let outcome = cipher.open(
            &binding,
            &wire["protectedResponse"],
            "surfaceOperationOutcomeContentSchema",
        )?;
        if outcome["ok"] == false {
            bail!(
                "{}",
                outcome["error"]
                    .as_js_string()
                    .expect("validated surface error")
            );
        }
        Ok((result, outcome["result"].clone()))
    }
}
