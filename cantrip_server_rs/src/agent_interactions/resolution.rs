use super::*;
use mapping::map_as;

impl Repository<'_, '_> {
    async fn validated(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
        protected: bool,
    ) -> Result<Option<Value>> {
        self.expire(None).await?;
        // get() expires again, matching the source collaborator boundaries.
        let Some(existing) = self.get(owner, id).await? else {
            return Ok(None);
        };
        if protected {
            if existing.get("protectedPayload").is_none() {
                return Err(conflict(
                    "Visible interaction requests require a visible response.",
                ));
            }
            if existing["classification"]["kind"] != input["classification"]["kind"] {
                return Err(conflict(
                    "Response kind does not match the pending request.",
                ));
            }
        } else {
            if existing.get("payload").is_none() {
                return Err(conflict(
                    "Protected interaction requests require a protected response.",
                ));
            }
            responses::validate(&existing["payload"], &input["response"])?;
        }
        Ok(Some(existing))
    }
    pub async fn validate_resolution(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
        protected: bool,
    ) -> Result<Option<Value>> {
        self.validated(owner, id, input, protected).await
    }
    pub async fn resolve(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
        protected: bool,
        accepted_native_reply: bool,
    ) -> Result<Option<Value>> {
        let Some(existing) = self.validated(owner, id, input, protected).await? else {
            return Ok(None);
        };
        let stored = if protected {
            input["protectedResponse"].clone()
        } else {
            responses::stored(&existing["payload"], &input["response"])?
        };
        if existing["status"] != "pending" {
            let row = self.raw_id(id).await?.context(if protected {
                "Database returned no row after reading a resolved protected interaction request."
            } else {
                "Database returned no row after reading a resolved interaction request."
            })?;
            if row["resolution_idempotency_key"] == input["idempotencyKey"]
                && (protected || row["response"].stringify() == stored.stringify())
                || accepted_native_reply && row["status"] == "resolved"
            {
                return map_as(&row, protected).map(Some);
            }
            return Err(conflict(&format!(
                "Interaction request is already {}.",
                text(&existing["status"])?
            )));
        }
        let column = if protected {
            "protected_response"
        } else {
            "response"
        };
        let now = crate::auth::now();
        let rows = self.rows(&format!("UPDATE agent_interaction_requests SET status='resolved',{column}=$1::text::jsonb,resolution_idempotency_key=$2,resolved_by_user_id=$3,resolved_at=$4,updated_at=$4 WHERE id=$5 AND status='pending' RETURNING to_jsonb(agent_interaction_requests)::text"), &[&stored.stringify(),&text(&input["idempotencyKey"])?,&owner,&now,&id]).await?;
        let Some(row) = rows.first() else {
            if accepted_native_reply
                && let Some(saved) = self.raw_id(id).await?
                && saved["status"] == "resolved"
            {
                return map_as(&saved, protected).map(Some);
            }
            return Err(conflict("Interaction request was resolved concurrently."));
        };
        if row["interaction_owner"] == "codex" && truthy(row.get("chat_id")) {
            self.restore(&text(&row["chat_id"])?).await?;
        }
        map_as(row, protected).map(Some)
    }
}
