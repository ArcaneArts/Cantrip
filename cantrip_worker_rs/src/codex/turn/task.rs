//! Protected Task rounds use the same physical turn runner as host Chat.
mod structured;
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

pub(super) fn is_round(command: &Value) -> bool {
    command["resultMode"]["kind"] == "task-encrypted"
        && command["taskInferenceInput"].is_object()
        && command["taskInferenceInput"]["kind"].is_null()
        && command["taskResumption"].is_null()
}

pub(super) fn is_structured(command: &Value) -> bool {
    is_round(command) && command["resultMode"]["operation"]["classification"]["kind"] != "direct"
}

pub(super) struct Round {
    service: Arc<Service>,
    binding: BoundComponentKey,
    context: Value,
    input: Value,
    kind: structured::Kind,
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
            kind: structured::Kind::parse(&input["classification"]["kind"])?,
            input,
            authorship: task["classification"]["planAuthorship"].clone(),
            request: request.clone(),
            output: Mutex::new(Output::default()),
        })
    }

    pub(super) fn prompt(&self) -> JsString {
        self.kind.prompt(&self.input)
    }

    pub(super) fn output_schema(&self) -> Option<&'static Value> {
        self.kind.output_schema()
    }

    pub(super) fn events(self: &Arc<Self>, emit: Emit) -> Emit {
        let round = self.clone();
        Arc::new(move |event| {
            // Structured responses are published only after endpoint validation.
            if round.kind.is_structured() || event["type"] != "agent.message" {
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
        let completed = self.kind.complete(&self.input, &result["text"])?;
        let direct = !self.kind.is_structured();
        let finalizing = completed.objective.is_some();
        let state = if direct {
            "complete"
        } else if finalizing {
            "implementing"
        } else {
            "review"
        };
        let authorship = if state == "review" {
            json!("agent")
        } else {
            self.authorship.clone()
        };
        let has_questions = !completed.questions.is_empty();
        let task = json!({
            "version": 1,
            "classification": json!({
                "state":state,"stableStateBeforeFailure":Value::Null,"activeOperationKind":Value::Null,
                "planAuthorship":authorship,"planningRound":self.input["classification"]["ordinal"],
                "hasPlan":!direct,"hasQuestions":has_questions,"hasFinalPlan":finalizing,
                "hasGoalPrompt":finalizing,"lastError":Value::Null,
            }),
            "briefMarkdown": self.input["inputBriefMarkdown"], "planMarkdown": completed.plan,
            "currentQuestions": completed.questions,
            "currentAnswers": if finalizing { self.input["inputAnswers"].clone() } else { json!(Vec::<Value>::new()) },
            "additionalDirection": if finalizing { self.input["additionalDirection"].clone() } else { json!("") },
            "finalPlanMarkdown": if finalizing { completed.plan.clone() } else { Value::Null },
            "goalPrompt":completed.objective, "lastError":Value::Null,
        });
        let mut round = self.input.clone();
        round["classification"]["status"] = json!("completed");
        round["classification"]["hasOutputPlan"] = json!(!direct);
        round["classification"]["hasOutputQuestions"] = json!(has_questions);
        round["classification"]["hasOutputGoalPrompt"] = json!(finalizing);
        round["outputPlanMarkdown"] = completed.plan;
        round["outputQuestions"] = json!(completed.questions);
        round["outputGoalPrompt"] = json!(completed.objective);
        let goal = match completed.objective.as_ref() {
            Some(objective) => self.goal_payload(&result["threadId"], &task, objective)?,
            None => Value::Null,
        };

        let published = self.output.lock().unwrap().final_message.take();
        let assistant = match published {
            Some(message)
                if message.turn == result["turnId"]
                    && message.thread == result["threadId"]
                    && message.text == result["text"] =>
            {
                message.cipher
            }
            _ => self.message(
                "assistant",
                if direct { "default" } else { "plan" },
                "task-result",
                &completed.assistant,
            )?,
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
                "assistantMessage":assistant,"goal":goal,
            }),
        )?;
        checked("agentTurnResultSchema", &result)
    }

    fn message(&self, role: &str, mode: &str, key: &str, text: &JsString) -> Result<Value> {
        let mut context = self.context.clone();
        context["messageId"] = json!(uuid::Uuid::new_v4().to_string());
        let idempotency = json!(format!(
            "{key}:{}",
            self.request["operationId"].as_str().unwrap()
        ));
        seal_message(
            &self.binding.component.key,
            &context,
            role,
            mode,
            &idempotency,
            json!({"type":"text","phase":"final_answer","text":text}),
        )
    }

    fn goal_payload(&self, thread: &Value, task: &Value, objective: &JsString) -> Result<Value> {
        let mut context = self.context.clone();
        context["threadId"] = thread.clone();
        let classification =
            json!({"chatId":self.context["chatId"],"threadId":thread,"status":"active"});
        let mut failed = task.clone();
        let occurred_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut error = json!({"code":"task-goal-start-failed","operationKind":"finalize","occurredAt":occurred_at});
        failed["classification"]["state"] = json!("failed");
        failed["classification"]["stableStateBeforeFailure"] = json!("review");
        failed["classification"]["lastError"] = error.clone();
        error["message"] = json!(
            "Goal startup failed. Implementation has not started. You can retry implementation without regenerating the saved plan."
        );
        failed["lastError"] = error;
        let prompt = concat(&[
            objective.clone(),
            "\n\n## Final implementation plan\n\n".into(),
            task["finalPlanMarkdown"].as_js_string().unwrap().clone(),
        ]);
        let secret = &self.binding.component.key;
        Ok(json!({
            "classification":classification,
            "failureTask":opaque(Communication::Task, secret, &self.context, &failed)?,
            "protectedObjective":encrypt_communication(Communication::TaskGoalObjective, secret, &context,
                &json!({"version":1,"classification":classification,"objective":objective}))?,
            "startMessage":self.message("user", "goal", "task-goal", &prompt)?,
        }))
    }
}
