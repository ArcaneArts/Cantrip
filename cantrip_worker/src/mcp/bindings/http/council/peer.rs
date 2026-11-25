use super::{Authorized, Inner, open_title};
use crate::{chat_content, http::checked};
use anyhow::{Context, Result, ensure};
use cantrip_history::content::Encryption;
use cantrip_protocol::external_mcp::orchestration::resource_id;
use cantrip_wire::{Value, value::json};
use uuid::Uuid;

impl Inner {
    pub(super) async fn send_council_peer(
        &self,
        authorization: &Authorized,
        input: &Value,
        request: &str,
    ) -> Result<Value> {
        let encryption = self
            .encryption
            .clone()
            .context("Council encryption is unavailable")?;
        let sender = &authorization.active.binding["chatId"];
        let recipient = &input["recipientAgentId"];
        let response = self
            .relay_project(
                authorization,
                json!({"operation":"council.peer.send",
            "arguments":json!({"kind":"resolve","recipientAgentId":recipient})}),
                request,
            )
            .await?;
        let target = checked("councilPeerTargetWireSchema", &response["data"])?;
        ensure!(
            target["senderAgentId"] == *sender && target["recipientAgentId"] == *recipient,
            "Cantrip returned another Council pair."
        );
        let sender_title = open_title(&encryption, authorization, sender, &target["senderTitle"])?;
        let recipient_title = open_title(
            &encryption,
            authorization,
            recipient,
            &target["recipientTitle"],
        )?;
        let scope = chat_content::Scope::new(encryption)?;
        let (owner, server) = scope.identity()?;
        ensure!(
            owner == authorization.identity.0 && server == authorization.identity.1,
            "The worker binding changed while preparing the Council handoff."
        );
        let operation = Uuid::parse_str(
            input["operationId"]
                .as_str()
                .context("Council delivery ID")?,
        )?;
        let owner = owner.as_str().context("Council owner")?;
        let source = sender.as_str().context("Council sender")?;
        let id = |kind| resource_id(owner, source, operation, kind).to_string();
        let operation_id = operation.to_string();
        let routing = json!({"senderAgentId":sender,"recipientAgentId":recipient,"operationId":operation_id});
        let communication = json!({"deliveryId":operation_id,"sourceChatId":sender,"sourceTitle":sender_title,
            "targetChatId":recipient,"targetTitle":recipient_title,"direction":"received","senderKind":"council"});
        let key = format!("council-peer:{source}:{operation}");
        let mut draft = target["configuration"].clone();
        draft["messageId"] = json!(id("council-peer-input"));
        draft["promptId"] = json!(id("council-peer-prompt"));
        draft["idempotencyKey"] = json!(format!("{key}:input"));
        draft["mode"] = json!("default");
        draft["text"] = input["message"].clone();
        draft["councilPeerMessage"] = routing.clone();
        let turn = chat_content::turn_with_communication(&scope, &draft, &communication)?;
        let sent = scope.protect(&json!({
            "id":id("council-peer-message"),"idempotencyKey":format!("{key}:sent"),"role":"assistant","mode":"default",
            "content":[json!({"type":"text","text":input["message"],"phase":"commentary","councilPeerMessage":routing})],
        }))?;
        scope.identity()?;
        self.relay_project(
            authorization,
            json!({"operation":"council.peer.send",
            "arguments":json!({"kind":"send","source":routing,"turn":turn,"sentMessage":sent})}),
            request,
        )
        .await
    }
}
