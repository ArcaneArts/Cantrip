use super::{Authorized, Inner, Rejected};
use crate::protected_content::{EffectivePolicies, open_policy_detail};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn policy(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let encryption = self
            .encryption
            .as_deref()
            .context("Policy encryption is unavailable.")?;
        let reading = operation == "policy.read";
        let tool = if reading {
            "policy_read"
        } else {
            "policy_list"
        };
        let arguments = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let binding = &authorization.active.binding;
        let request_id = uuid::Uuid::new_v4();
        let mut response = self
            .server
            .invoke(
                binding.clone(),
                authorization.version,
                authorization.legacy_root.as_ref(),
                json!({"operation":"policy.list","arguments":json!({})}),
                &format!("{request_id}:policy-list"),
            )
            .await?;
        verify_current(self, authorization)?;
        let policies = EffectivePolicies::open(encryption, &response["data"])?;
        if reading {
            let key = &arguments["key"];
            let text = key.as_str().context("Policy key")?;
            let id = policies.identifier(key).ok_or_else(|| Rejected {
                status: 404,
                code: Some("not-found".into()),
                message: format!("Policy {text} is not effective for the current project.").into(),
            })?;
            response = self
                .server
                .invoke(
                    binding.clone(),
                    authorization.version,
                    authorization.legacy_root.as_ref(),
                    json!({"operation":"policy.read","arguments":json!({"policyId":id})}),
                    &format!("{request_id}:policy-read"),
                )
                .await?;
            verify_current(self, authorization)?;
            response["summary"] = json!(format!("Read policy {text}."));
            response["data"] = open_policy_detail(encryption, id, key, &response["data"])?;
        } else {
            response["summary"] = json!(policies.summary());
            response["data"] = policies.into_view();
        }
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&response)).map_err(response_error)
    }
}

fn verify_current(service: &Inner, authorization: &Authorized) -> Result<()> {
    ensure!(
        !*authorization.active.stopped.borrow()
            && (service.identity)().as_ref().ok() == Some(&authorization.identity),
        "The managed policy attachment was replaced."
    );
    Ok(())
}
