use super::{CommandError, Repository};
use crate::wire::{Value, value::json};
use anyhow::Result;

impl Repository {
    /// One primary-state snapshot authorizes an issued helper. Later resource
    /// deletion revokes its already-registered worker owner through the outbox.
    pub async fn authorize_inference_resource(&self, owner: &str, input: &Value) -> Result<Value> {
        let worker = input["workerId"].as_str().unwrap();
        let target = &input["target"];
        let (query, resource) = if target["kind"] == "project" {
            (
                "SELECT p.id FROM projects p JOIN workers w ON w.id=$3 AND w.owner_id=$1 WHERE p.id=$2 AND p.owner_id=$1 LIMIT 1",
                target["projectId"].as_str().unwrap(),
            )
        } else {
            (
                "SELECT c.id FROM chats c JOIN workers w ON w.id=$3 AND w.owner_id=$1 WHERE c.id=$2 AND c.owner_id=$1 AND c.archived_at IS NULL AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=c.project_id AND p.owner_id=$1)) LIMIT 1",
                target["chatId"].as_str().unwrap(),
            )
        };
        if self
            .database
            .query(query, &[&owner, &resource, &worker])
            .await?
            .is_empty()
        {
            return Err(CommandError::new(
                "inference-resource-unavailable",
                Some("The inference resource is unavailable."),
                410,
            )
            .into());
        }
        let mut result = input.clone();
        result["ownerId"] = json!(owner);
        result["authorized"] = json!(true);
        Ok(result)
    }
}
