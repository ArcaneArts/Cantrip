mod lineage;

use crate::{
    chats::{Repository, agent_delivery::DeliveryError, managed_console, message_writes},
    native_commands::transaction::TransactionRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result, ensure};

pub(crate) fn peer_target(context: Option<Value>) -> Result<Value> {
    context
        .filter(|current| current.get("councilAgent").is_some())
        .ok_or_else(|| DeliveryError::ReceiverUnavailable.into())
}

impl Repository {
    pub(crate) async fn deliver_council_peer(
        &self,
        owner: &str,
        source: &Value,
        target: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let owner = owner.to_owned();
        let source = source.clone();
        let target = target.to_owned();
        let input = input.clone();
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let sender = source["chatId"].as_str().context("Council sender ID")?;
                    let operation = input["source"]["operationId"]
                        .as_str()
                        .context("Council handoff operation ID")?;
                    tx.query(
                        "SELECT id FROM chats WHERE owner_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
                        &[&owner, &vec![sender.to_owned(), target.clone()]],
                    )
                    .await?;
                    let repository = TransactionRepository::new(tx);
                    let current = repository.execution_context(&owner, sender).await?;
                    if !current.is_some_and(|current| {
                        current.get("councilAgent").is_some()
                            && current["workerId"] == source["workerId"]
                            && current["executionLaneId"] == source["executionLaneId"]
                            && current["threadId"] == source["threadId"]
                            && managed_console::permission_profile(&current)["effectiveId"]
                                != ":read-only"
                            && matches!(
                                current["status"].as_str(),
                                Some("running" | "waiting-for-approval")
                            )
                    }) {
                        return Err(DeliveryError::SenderUnavailable.into());
                    }
                    let earlier = tx
                        .query(
                            "SELECT recipient_chat_id FROM council_peer_deliveries
                             WHERE sender_chat_id=$1 AND operation_id=$2::text::uuid",
                            &[&sender, &operation],
                        )
                        .await?;
                    if let Some(earlier) = earlier.first() {
                        if earlier.get::<&str>(0)? != target {
                            return Err(DeliveryError::OperationConflict.into());
                        }
                        return Ok(None);
                    }

                    let lineage = lineage::admit(tx, &owner, sender, &source, operation).await?;

                    let current = peer_target(repository.execution_context(&owner, &target).await?)?;
                    let configuration = &current["modelConfiguration"];
                    if configuration["modelId"].is_null() {
                        return Err(DeliveryError::ModelRequired.into());
                    }
                    let mut pending = input["turn"]["message"].clone();
                    pending["reasoningEffort"] = configuration["reasoningEffort"].clone();
                    let mut prompt = input["turn"]["queuedPrompt"].clone();
                    for (key, value) in configuration.as_object().context("Recipient model configuration")? {
                        prompt[key.as_str().context("Model configuration key")?] = value.clone();
                    }
                    prompt["pendingMessage"] = pending;
                    let queued = repository
                        .add_gui_prompt(
                            &owner,
                            &current,
                            &prompt,
                            &json!({"operationId":format!("council-peer:queue:{sender}:{operation}"),"resumeAutonomy":false}),
                        )
                        .await?;
                    ensure!(
                        !queued["acceptedItem"].is_null(),
                        "The receiving Council agent could not queue the message."
                    );

                    let sent = message_writes::append_for_mcp(tx, &owner, sender, &input["sentMessage"])
                        .await?
                        .context("Council handoff history could not be saved.")?;
                    let message = input["sentMessage"]["id"].as_str().context("Council handoff ID")?;
                    let input_id = input["turn"]["message"]["id"]
                        .as_str()
                        .context("Council handoff input ID")?;
                    let queued_id = prompt["id"].as_str().context("Council handoff queue ID")?;
                    tx.query(
                        "INSERT INTO council_peer_deliveries
                         (sender_chat_id,recipient_chat_id,operation_id,sent_message_id,input_message_id,
                          chain_id,depth,sender_input_message_id,queued_prompt_id)
                         VALUES($1,$2,$3::text::uuid,$4,$5,$6,$7,$8,$9)",
                        &[&sender, &target, &operation, &message, &input_id, &lineage.chain, &lineage.depth, &lineage.sender_input, &queued_id],
                    )
                    .await?;
                    Ok(Some(sent))
                })
            })
            .await
    }
}

impl Repository {
    pub(crate) async fn council_peer_titles(
        &self,
        owner: &str,
        sender: &str,
        recipient: &str,
    ) -> Result<Option<(Value, Value)>> {
        let rows = self.database.query(
            "SELECT source.protected_label::text, target.protected_label::text
             FROM council_agents s
             JOIN chats source ON source.id=s.chat_id AND source.owner_id=s.owner_id AND source.archived_at IS NULL
             JOIN council_agents r ON r.chat_id=$3 AND r.owner_id=s.owner_id
             JOIN chats target ON target.id=r.chat_id AND target.owner_id=r.owner_id AND target.archived_at IS NULL
             WHERE s.owner_id=$1 AND s.chat_id=$2",
            &[&owner, &sender, &recipient],
        ).await?;
        rows.first()
            .map(|row| {
                Ok((
                    serde_json::from_str(row.get::<&str>(0)?)?,
                    serde_json::from_str(row.get::<&str>(1)?)?,
                ))
            })
            .transpose()
    }

    pub(crate) async fn council_peer_page(
        &self,
        owner: &str,
        agent: &str,
        peer: &str,
        before: Option<&str>,
    ) -> Result<Option<Value>> {
        let (first, second) = if agent < peer {
            (agent, peer)
        } else {
            (peer, agent)
        };
        // Scope the cursor and page to the same unordered pair. The cursor
        // remains usable when its corresponding history message is deleted.
        let rows = self.database.query(
            "WITH pair AS (
                 SELECT a.chat_id AS first_id, b.chat_id AS second_id
                 FROM council_agents a JOIN council_agents b ON b.owner_id=a.owner_id
                 JOIN chats ac ON ac.id=a.chat_id AND ac.owner_id=a.owner_id AND ac.archived_at IS NULL
                 JOIN chats bc ON bc.id=b.chat_id AND bc.owner_id=b.owner_id AND bc.archived_at IS NULL
                 WHERE a.owner_id=$1 AND a.chat_id=$2 AND b.chat_id=$3 AND a.chat_id<>b.chat_id
             ), cursor_row AS (
                 SELECT d.created_at,d.sent_message_id FROM council_peer_deliveries d
                 JOIN pair p ON LEAST(d.sender_chat_id,d.recipient_chat_id)=p.first_id
                            AND GREATEST(d.sender_chat_id,d.recipient_chat_id)=p.second_id
                 WHERE d.sent_message_id=$4
             )
             SELECT coalesce((
               SELECT jsonb_agg(messages.record ORDER BY messages.created_at DESC,messages.sent_message_id DESC)
               FROM (
                 SELECT d.created_at,d.sent_message_id,jsonb_build_object(
                   'id',m.id,'senderAgentId',d.sender_chat_id,'recipientAgentId',d.recipient_chat_id,
                   'operationId',d.operation_id,'createdAt',d.created_at,'protectedContent',m.protected_content,
                   'role',m.role,'mode',m.mode,'attachmentIds',m.attachment_ids,
                   'senderHistoryId',coalesce(sender_input.id,m.id),'recipientHistoryId',recipient_input.id
                 ) AS record
                 FROM council_peer_deliveries d
                 JOIN chat_messages m ON m.id=d.sent_message_id AND m.chat_id=d.sender_chat_id
                 LEFT JOIN chat_messages sender_input ON sender_input.id=d.sender_input_message_id
                   AND sender_input.chat_id=d.sender_chat_id
                 LEFT JOIN chat_messages recipient_input ON recipient_input.id=d.input_message_id
                   AND recipient_input.chat_id=d.recipient_chat_id
                 LEFT JOIN cursor_row c ON true
                 WHERE LEAST(d.sender_chat_id,d.recipient_chat_id)=pair.first_id
                   AND GREATEST(d.sender_chat_id,d.recipient_chat_id)=pair.second_id
                   AND m.protected_content IS NOT NULL
                   AND ($4::text IS NULL OR (d.created_at,d.sent_message_id)<(c.created_at,c.sent_message_id))
                 ORDER BY d.created_at DESC,d.sent_message_id DESC LIMIT 31
               ) messages
             ),'[]'::jsonb)::text FROM pair
             WHERE $4::text IS NULL OR EXISTS (SELECT 1 FROM cursor_row)",
            &[&owner, &first, &second, &before],
        ).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let mut messages = super::super::catalog::raw(row)?
            .as_array()
            .context("Council peer messages")?
            .to_vec();
        let next = if messages.len() > 30 {
            messages.pop();
            messages.last().context("Council peer page cursor")?["id"].clone()
        } else {
            Value::Null
        };
        for message in &mut messages {
            message["createdAt"] = crate::chats::catalog::iso(&message["createdAt"])?;
        }
        Ok(Some(json!({"messages":messages,"nextBefore":next})))
    }
}
