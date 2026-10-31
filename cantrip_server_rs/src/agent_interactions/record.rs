use super::*;
use mapping::{iso, map_as, optional_text};
impl Repository<'_, '_> {
    async fn owner(&self, input: &Value) -> Result<String> {
        let worker = text(&input["provenance"]["workerId"])?;
        let rows = if truthy(input["provenance"].get("chatId")) {
            self.executor.query("SELECT c.owner_id FROM chats c INNER JOIN workers w ON w.id=$1 AND w.owner_id=c.owner_id WHERE c.id=$2 LIMIT 1", &[&worker,&text(&input["provenance"]["chatId"])?]).await?
        } else if truthy(input.get("projectId")) {
            self.executor.query("SELECT p.owner_id FROM projects p INNER JOIN workers w ON w.id=$1 AND w.owner_id=p.owner_id WHERE p.id=$2 LIMIT 1", &[&worker,&text(&input["projectId"])?]).await?
        } else {
            Vec::new()
        };
        rows.first()
            .map(|r| r.get::<String>(0))
            .transpose()?
            .ok_or_else(|| {
                conflict("Interaction worker does not belong to the owning Chat or project.")
            })
    }
    pub async fn record(&self, input: &Value, protected: bool) -> Result<Value> {
        let input = parse(
            if protected {
                "encryptedAgentInteractionRequestCreateSchema"
            } else {
                "agentInteractionRequestCreateSchema"
            },
            input,
        )?;
        let owner = self.owner(&input).await?;
        let p = &input["provenance"];
        let chat = optional_text(&p["chatId"])?;
        if truthy(p.get("chatId")) {
            let rows = self
                .executor
                .query(
                    "SELECT project_id FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",
                    &[&chat, &owner],
                )
                .await?;
            let project = rows
                .first()
                .map(|r| r.get::<Option<String>>(0))
                .transpose()?;
            if project.is_none() || json!(project.unwrap()) != input["projectId"] {
                return Err(conflict(
                    "Interaction provenance does not match the project chat.",
                ));
            }
        }
        let now = crate::auth::now();
        let expires = if truthy(input.get("expiresAt")) {
            optional_text(&iso(&input["expiresAt"])?)?
        } else {
            None
        };
        let expired = input["expiresAt"]
            .as_js_string()
            .and_then(crate::wire::date_milliseconds)
            .is_some_and(|t| t <= now.timestamp_millis());
        let resolved = expired.then_some(now);
        let status = if expired { "expired" } else { "pending" };
        let interaction_owner = p
            .get("owner")
            .filter(|v| !v.is_null())
            .map(text)
            .transpose()?
            .unwrap_or_else(|| "codex".into());
        let kind = if protected {
            &input["classification"]["kind"]
        } else {
            &input["payload"]["kind"]
        };
        let payload = (!protected).then(|| input["payload"].stringify());
        let opaque = protected.then(|| input["protectedPayload"].stringify());
        let rows = self.rows("INSERT INTO agent_interaction_requests(id,request_key,interaction_owner,owner_id,project_id,chat_id,worker_id,execution_lane_id,thread_id,turn_id,item_id,kind,status,payload,protected_payload,expires_at,resolved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text::jsonb,$15::text::jsonb,$16::text::timestamptz,$17) ON CONFLICT(request_key) DO NOTHING RETURNING to_jsonb(agent_interaction_requests)::text", &[&uuid::Uuid::new_v4().to_string(),&text(&input["requestKey"])?,&interaction_owner,&owner,&optional_text(&input["projectId"])?,&chat,&text(&p["workerId"])?,&optional_text(&p["executionLaneId"])?,&optional_text(&p["threadId"])?,&optional_text(&p["turnId"])?,&optional_text(&p["itemId"])?,&text(kind)?,&status,&payload,&opaque,&expires,&resolved]).await?;
        let inserted = !rows.is_empty();
        let row = if let Some(row) = rows.into_iter().next() {
            row
        } else {
            self.rows("SELECT to_jsonb(r)::text FROM agent_interaction_requests r WHERE request_key=$1 LIMIT 1", &[&text(&input["requestKey"])?]).await?.into_iter().next().with_context(|| if protected { "Database returned no row after reading a protected interaction request." } else { "Database returned no row after reading an interaction request." })?
        };
        let result = map_as(&row, protected)?;
        let mut canonical = p.clone();
        if canonical["owner"] == "codex"
            && let Value::Object(fields) = &mut canonical
        {
            fields.shift_remove(&crate::wire::JsString::from("owner"));
        }
        let content_matches = if protected {
            result["classification"].stringify() == input["classification"].stringify()
                && result["protectedPayload"].stringify() == input["protectedPayload"].stringify()
        } else {
            result["payload"].stringify() == input["payload"].stringify()
        };
        if !inserted
            && (result["projectId"] != input["projectId"]
                || result["provenance"].stringify() != canonical.stringify()
                || !content_matches
                || result["expiresAt"] != json!(expires))
        {
            return Err(conflict(
                "Interaction request key was reused with different request data.",
            ));
        }
        if row["interaction_owner"] == "codex"
            && truthy(p.get("chatId"))
            && row["status"] == "pending"
        {
            self.executor
                .query(
                    "UPDATE chats SET status='waiting-for-approval',updated_at=$1 WHERE id=$2",
                    &[&crate::auth::now(), &chat],
                )
                .await?;
        }
        Ok(result)
    }
}
