use super::*;
use crate::{chats::routing::NoProviderRoutes, native_commands::Repository as Commands};

impl Service {
    pub(super) async fn recover_council_provider(
        &self,
        owner: &str,
        context: &Value,
    ) -> Result<bool> {
        let commands = Commands::new(self.dependencies.database.clone());
        let chat = text(&context["chatId"])?;
        let Some(mut recovery) = commands
            .pending_council_provider_recovery(owner, &chat)
            .await?
        else {
            return Ok(false);
        };
        if recovery["sourceReady"] != true || context["threadId"] != recovery["sourceThreadId"] {
            return Ok(true);
        }

        if recovery["phase"] != "switching" {
            let model = text(&recovery["modelId"])?;
            let routes = match self
                .dependencies
                .routing
                .available_runtimes(owner, context, &model)
                .await
            {
                Ok(routes) => routes,
                Err(error) if error.is::<NoProviderRoutes>() => Vec::new(),
                Err(error) => return Err(error),
            };
            let exhausted = recovery["exhaustedRoutes"]
                .as_array()
                .context("Council recovery routes")?;
            let target = routes.iter().find(|candidate| {
                !exhausted.iter().any(|source| {
                    source["routeId"] == candidate["routeId"]
                        && source["accountId"].as_str()
                            == candidate["provider"]["accountId"].as_str()
                })
            });
            let updated = commands
                .set_council_provider_route(
                    owner,
                    &chat,
                    &text(&recovery["sourceOperationId"])?,
                    target,
                )
                .await?;
            if updated {
                self.dependencies.live.publish_summary(
                    owner,
                    &context["chatId"],
                    &context["projectId"],
                );
            }
            if target.is_none() {
                return Ok(true);
            }
            let Some(current) = commands
                .pending_council_provider_recovery(owner, &chat)
                .await?
            else {
                return Ok(true);
            };
            recovery = current;
        }
        self.dependencies
            .account_failover
            .transfer_council_provider(owner, context, &recovery)
            .await?;
        if let Some(current) = self.chats.execution_context(owner, &chat).await? {
            self.queue_provider_continuation(&commands, owner, &current, &recovery)
                .await?;
        }
        Ok(true)
    }

    async fn queue_provider_continuation(
        &self,
        commands: &Commands,
        owner: &str,
        current: &Value,
        recovery: &Value,
    ) -> Result<()> {
        let chat = text(&current["chatId"])?;
        let run = text(&recovery["runId"])?;
        let worker = text(&current["workerId"])?;
        let source_message = recovery["sourceMessageId"].as_str();
        let rows = self.dependencies.database.query(
            "SELECT jsonb_build_object(
                'id',m.id,
                'classification',jsonb_build_object('role',m.role,'mode',m.mode,'attachmentIds',m.attachment_ids),
                'protectedContent',m.protected_content)::text
             FROM chat_messages m INNER JOIN chats c ON c.id=m.chat_id AND c.owner_id=$1
             WHERE m.chat_id=$2 AND m.protected_content IS NOT NULL
               AND (m.id=$4 OR (octet_length(m.protected_content::text)<=32768 AND EXISTS (
                  SELECT 1 FROM council_provider_recoveries r JOIN native_commands s ON s.operation_id=r.source_operation_id
                  WHERE r.chat_id=m.chat_id AND r.run_id=$3 AND s.execution_lane_id=m.execution_lane_id
               ) AND NOT EXISTS (
                  SELECT 1 FROM council_provider_recoveries r
                  WHERE r.chat_id=m.chat_id AND r.run_id=$3 AND r.continuation_message_id=m.id
               )))
             ORDER BY COALESCE(m.id=$4,false) DESC,m.sequence DESC LIMIT 17",
            &[&owner,&chat,&run,&source_message],
        ).await?;
        let mut original = Value::Null;
        let mut progress = Vec::new();
        let mut ids = Vec::new();
        for row in rows {
            let message: Value = serde_json::from_str(row.get::<&str>(0)?)?;
            if message["id"] == recovery["sourceMessageId"] {
                ids.push(text(&message["id"])?);
                original = message;
            } else if progress.len() < 16 {
                ids.push(text(&message["id"])?);
                progress.push(message);
            }
        }
        progress.reverse();
        let pending = self
            .dependencies
            .database
            .query(
                "SELECT DISTINCT r.id FROM agent_interaction_requests r
             LEFT JOIN council_project_interactions i ON i.request_id=r.id
             WHERE r.owner_id=$1 AND (r.chat_id=$2 OR i.council_chat_id=$2) AND r.status='pending'
             ORDER BY r.id LIMIT 16",
                &[&owner, &chat],
            )
            .await?
            .iter()
            .map(|row| row.get::<String>(0))
            .collect::<Result<Vec<_>>>()?;
        let msg = uuid::Uuid::new_v4().to_string();
        let prompt = uuid::Uuid::new_v4().to_string();
        let key = format!("council-provider:{}", text(&recovery["sourceOperationId"])?);
        let draft = json!({
            "type":"council.provider-continuation.prepare","chatId":chat,
            "messageId":msg,"promptId":prompt,"idempotencyKey":key,
            "configuration":current["modelConfiguration"],
            "source":json!({"runId":run,"turnId":recovery["sourceTurnId"],"messageId":recovery["sourceMessageId"]}),
            "original":original,"progress":progress,"pendingDecisions":pending,
        });
        let prepared = self
            .dependencies
            .commands
            .request(&worker, draft, None, None)
            .await?;
        let prepared =
            crate::settings::parse_response("encryptedChatTurnCreateSchema", prepared.as_ref())?;
        anyhow::ensure!(
            prepared["message"]["id"] == msg
                && prepared["queuedPrompt"]["id"] == prompt
                && prepared["queuedPrompt"]["idempotencyKey"] == key,
            "The Worker returned a different Council continuation."
        );
        if commands
            .enqueue_council_provider_continuation(owner, recovery, current, &prepared, ids)
            .await?
        {
            self.dependencies.live.publish_summary(
                owner,
                &current["chatId"],
                &current["projectId"],
            );
            self.dependencies
                .live
                .publish_invalidation(owner, &chat, "chat-queue", None);
            drop(self.dispatch(owner, &chat));
        }
        Ok(())
    }
}
