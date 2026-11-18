//! Protected direct Task rounds use the same physical turn runner as host Chat.
use super::{Emit, Key};
use crate::{
    encryption::{BoundComponentKey, Service},
    http::checked,
    native_items::concat,
    task_content::{fingerprint, opaque, seal_message},
};
use anyhow::{Context, Result, bail};
use cantrip_crypto::content::{Communication, decrypt_communication, encrypt_communication};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use subtle::ConstantTimeEq;

pub(super) fn direct(command: &Value) -> bool {
    command["resultMode"]["kind"] == "task-encrypted"
        && command["resultMode"]["operation"]["classification"]["kind"] == "direct"
        && command["taskInferenceInput"].is_object()
        && command["taskInferenceInput"]["kind"].is_null()
        && command["taskResumption"].is_null()
}

pub(super) struct Round {
    service: Arc<Service>,
    binding: BoundComponentKey,
    context: Value,
    input: Value,
    authorship: Value,
    request: Value,
    output: Mutex<Output>,
}

#[derive(Default)]
struct Output {
    ids: HashMap<JsString, String>,
    final_message: Option<FinalMessage>,
}

struct FinalMessage {
    turn: Value,
    thread: Value,
    text: Value,
    cipher: Value,
}

impl Round {
    pub(super) fn open(service: Arc<Service>, command: &Value, key: &Key) -> Result<Self> {
        let binding = service.bound_component("task-content", None)?;
        if binding.owner_id != key.0 || binding.server_id.as_js_string() != Some(&key.1) {
            bail!("The worker binding changed before Task preparation.");
        }
        let request = &command["resultMode"]["operation"];
        let receipt = &command["taskInferenceInput"];
        if request["operationId"] != receipt["dispatch"]["operationId"]
            || request["chatId"] != command["chatId"]
            || request["userMessage"]["id"] != command["clientMessageId"]
        {
            bail!("The encrypted Task input does not match the admitted round.");
        }
        let context = json!({
            "ownerId": key.0, "keyRevision": binding.component.key_revision,
            "roundId": request["operationId"], "chatId": request["chatId"],
            "messageId": request["userMessage"]["id"],
        });
        let secret = &binding.component.key;
        let input = decrypt_communication(
            Communication::TaskPlanningRound,
            secret,
            &context,
            &request["protectedInput"],
            request.get("classification"),
        )?;
        let task = decrypt_communication(
            Communication::Task,
            secret,
            &context,
            &request["task"]["protectedContent"],
            request["task"].get("classification"),
        )?;
        let message = &request["userMessage"];
        decrypt_communication(
            Communication::TaskMessage,
            secret,
            &context,
            &message["protectedContent"],
            message.get("classification"),
        )?;
        let expected = fingerprint(secret, &context, &input, &task, message)?;
        let actual = request["fingerprint"].as_str().unwrap_or_default();
        if !bool::from(expected.as_bytes().ct_eq(actual.as_bytes())) {
            bail!("The encrypted Task operation fingerprint is invalid.");
        }
        Ok(Self {
            service,
            binding,
            context,
            input,
            authorship: task["classification"]["planAuthorship"].clone(),
            request: request.clone(),
            output: Mutex::new(Output::default()),
        })
    }

    pub(super) fn prompt(&self) -> Result<JsString> {
        self.input["inputBriefMarkdown"]
            .as_js_string()
            .cloned()
            .context("Missing Task brief.")
    }

    pub(super) fn events(self: &Arc<Self>, emit: Emit) -> Emit {
        let round = self.clone();
        Arc::new(move |event| {
            // Direct Task events carry protected agent messages. Chat-specific
            // plan updates have a different contract and must stay private.
            if event["type"] != "agent.message" {
                return Ok(());
            }
            round.publish(&event["message"], &emit)
        })
    }

    fn assert_bound(&self) -> Result<()> {
        let (owner, server) = self.service.bound_identity()?;
        if owner != self.binding.owner_id || server != self.binding.server_id {
            bail!("The worker binding changed during the Task.");
        }
        Ok(())
    }

    fn publish(&self, message: &Value, emit: &Emit) -> Result<()> {
        self.assert_bound()?;
        let turn = &message["correlation"]["turnId"];
        let key = concat(&[
            "agent-message:root:".into(),
            turn.as_js_string()
                .cloned()
                .unwrap_or_else(|| "turn".into()),
            ":".into(),
            message["id"]
                .as_js_string()
                .cloned()
                .context("Invalid native Task message identity.")?,
        ]);
        let mut output = self.output.lock().unwrap();
        let id = output
            .ids
            .entry(key.clone())
            .or_insert_with(|| uuid::Uuid::new_v4().to_string());
        let mut context = self.context.clone();
        context["messageId"] = json!(id.as_str());
        let mut content = json!({
            "type":"text","text":message["text"],"phase":message["phase"],
            "correlation":message["correlation"],
        });
        let mut telemetry = json!({"kind":"message","phase":message["phase"],"turnId":turn});
        if message["streaming"] == true {
            content["streaming"] = json!(true);
            telemetry["streaming"] = json!(true);
        }
        let cipher = seal_message(
            &self.binding.component.key,
            &context,
            "assistant",
            "default",
            &json!(key),
            content,
        )?;
        emit(
            json!({"type":"agent.protected-task-message","message":cipher,"telemetry":telemetry}),
        )?;
        if message["phase"] != "commentary" && message["streaming"] != true {
            output.final_message = Some(FinalMessage {
                turn: turn.clone(),
                thread: message["correlation"]["threadId"].clone(),
                text: message["text"].clone(),
                cipher,
            });
        }
        Ok(())
    }

    pub(super) fn finish(&self, mut result: Value) -> Result<Value> {
        self.assert_bound()?;
        let ordinal = &self.input["classification"]["ordinal"];
        let task = json!({
            "version": 1,
            "classification": json!({
                "state":"complete","stableStateBeforeFailure":Value::Null,"activeOperationKind":Value::Null,
                "planAuthorship":self.authorship,"planningRound":ordinal,
                "hasPlan":false,"hasQuestions":false,"hasFinalPlan":false,"hasGoalPrompt":false,"lastError":Value::Null,
            }),
            "briefMarkdown": self.input["inputBriefMarkdown"], "planMarkdown": Value::Null,
            "currentQuestions": Vec::<Value>::new(), "currentAnswers": Vec::<Value>::new(),
            "additionalDirection":"", "finalPlanMarkdown":Value::Null,"goalPrompt":Value::Null,"lastError":Value::Null,
        });
        let mut round = self.input.clone();
        round["classification"]["status"] = json!("completed");
        let published = self.output.lock().unwrap().final_message.take();
        let assistant = match published {
            Some(message)
                if message.turn == result["turnId"]
                    && message.thread == result["threadId"]
                    && message.text == result["text"] =>
            {
                message.cipher
            }
            _ => {
                let mut context = self.context.clone();
                context["messageId"] = json!(uuid::Uuid::new_v4().to_string());
                let text = result["text"]
                    .as_js_string()
                    .context("Invalid Task result text.")?;
                let text = if text.is_empty() {
                    json!("The Task completed without a message.")
                } else {
                    json!(text)
                };
                let idempotency = json!(format!(
                    "task-result:{}",
                    self.request["operationId"].as_str().unwrap()
                ));
                seal_message(
                    &self.binding.component.key,
                    &context,
                    "assistant",
                    "default",
                    &idempotency,
                    json!({"type":"text","phase":"final_answer","text":text}),
                )?
            }
        };
        let secret = &self.binding.component.key;
        result["text"] = json!("");
        result["structuredResult"] = checked(
            "taskOperationRelayResultSchema",
            &json!({
                "chatId":self.request["chatId"],"operationId":self.request["operationId"],"fingerprint":self.request["fingerprint"],
                "classification":round["classification"],
                "protectedResult":encrypt_communication(Communication::TaskPlanningRound, secret, &self.context, &round)?,
                "task":opaque(Communication::Task, secret, &self.context, &task)?,
                "assistantMessage":assistant,"goal":Value::Null,
            }),
        )?;
        checked("agentTurnResultSchema", &result)
    }
}
