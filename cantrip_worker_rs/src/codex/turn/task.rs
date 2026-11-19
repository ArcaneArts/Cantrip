//! Protected Task rounds use the same physical turn runner as host Chat.
pub(super) mod checkpoint;
pub(in crate::codex) mod cycle;
pub(super) mod first_input;
mod structured;
use super::{Emit, Key};
use crate::{
    encryption::{BoundComponentKey, Service},
    http::checked,
    native_items::{concat, join},
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

pub(super) fn is_goal(command: &Value) -> bool {
    command["resultMode"]["kind"] == "task-message-encrypted"
        && command["taskInferenceInput"]["kind"] == "goal"
        && command["threadId"].is_string()
        && command["taskResumption"].is_null()
}

pub(super) enum Turn {
    Round(Round),
    Goal(Goal),
}

impl Turn {
    pub(super) fn open(service: Arc<Service>, command: &Value, key: &Key) -> Result<Self> {
        if is_goal(command) {
            Goal::open(service, command, key).map(Self::Goal)
        } else {
            Round::open(service, command, key).map(Self::Round)
        }
    }

    pub(super) fn prompt(&self) -> JsString {
        match self {
            Self::Goal(goal) => goal.prompt.clone(),
            Self::Round(round) => round.kind.prompt(&round.input),
        }
    }

    pub(super) fn output_schema(&self) -> Option<&'static Value> {
        match self {
            Self::Goal(_) => None,
            Self::Round(round) => round.kind.output_schema(),
        }
    }

    pub(super) fn events(&self, emit: Emit) -> Emit {
        match self {
            Self::Goal(goal) => goal.messages.events(emit),
            Self::Round(round) if !round.kind.is_structured() => round.messages.events(emit),
            // Structured responses are published only after endpoint validation.
            Self::Round(_) => Arc::new(|_| Ok(())),
        }
    }

    pub(super) fn finish(&self, result: Value) -> Result<Value> {
        match self {
            Self::Goal(goal) => goal.finish(result),
            Self::Round(round) => round.finish(result),
        }
    }
}

pub(super) fn is_structured(command: &Value) -> bool {
    is_round(command) && command["resultMode"]["operation"]["classification"]["kind"] != "direct"
}

pub(super) struct Round {
    messages: Arc<Messages>,
    input: Value,
    kind: structured::Kind,
    authorship: Value,
    request: Value,
}

pub(super) struct Goal {
    messages: Arc<Messages>,
    prompt: JsString,
    response: Value,
}

struct Messages {
    service: Arc<Service>,
    binding: BoundComponentKey,
    context: Value,
    mode: &'static str,
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
        let binding = task_key(&service, key)?;
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
            messages: Arc::new(Messages {
                service,
                binding,
                context,
                mode: "default",
                output: Mutex::new(Output::default()),
            }),
            kind: structured::Kind::parse(&input["classification"]["kind"])?,
            input,
            authorship: task["classification"]["planAuthorship"].clone(),
            request: request.clone(),
        })
    }
}

fn task_key(service: &Service, key: &Key) -> Result<BoundComponentKey> {
    let binding = service.bound_component("task-content", None)?;
    if binding.owner_id != key.0 || binding.server_id.as_js_string() != Some(&key.1) {
        bail!("The worker binding changed before Task preparation.");
    }
    Ok(binding)
}

impl Messages {
    fn events(self: &Arc<Self>, emit: Emit) -> Emit {
        let messages = self.clone();
        Arc::new(move |event| {
            if event["type"] != "agent.message" {
                return Ok(());
            }
            messages.publish(&event["message"], &emit)
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
            self.mode,
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

    fn final_message(&self, result: &Value) -> Option<Value> {
        self.output
            .lock()
            .unwrap()
            .final_message
            .take()
            .filter(|message| {
                message.turn == result["turnId"]
                    && message.thread == result["threadId"]
                    && message.text == result["text"]
            })
            .map(|message| message.cipher)
    }

    fn seal(
        &self,
        message_id: &Value,
        idempotency: &Value,
        role: &str,
        mode: &str,
        text: &JsString,
    ) -> Result<Value> {
        self.assert_bound()?;
        let mut context = self.context.clone();
        context["messageId"] = message_id.clone();
        seal_message(
            &self.binding.component.key,
            &context,
            role,
            mode,
            idempotency,
            json!({"type":"text","phase":"final_answer","text":text}),
        )
    }
}

impl Goal {
    fn open(service: Arc<Service>, command: &Value, key: &Key) -> Result<Self> {
        let binding = task_key(&service, key)?;
        let prompt = &command["protectedTaskPrompt"];
        if prompt["id"] != command["clientMessageId"]
            || prompt["classification"]["mode"] != "goal"
            || !prompt["classification"]["attachmentIds"]
                .as_array()
                .is_some_and(Vec::is_empty)
        {
            bail!("Protected Goal input does not match its admitted host message.");
        }
        let context = json!({
            "ownerId":key.0, "chatId":key.2, "keyRevision":binding.component.key_revision, "messageId":prompt["id"],
        });
        let content = decrypt_communication(
            Communication::TaskMessage,
            &binding.component.key,
            &context,
            &prompt["protectedContent"],
            prompt.get("classification"),
        )?;
        let input = checked("chatMessageContentSchema", &content["content"])?;
        let text = join(
            input
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["type"] == "text")
                .filter_map(|item| item["text"].as_js_string().cloned()),
            "\n\n",
        )
        .trim();
        let prompt = if text.is_empty() {
            "Review the attached files and respond to the user.".into()
        } else {
            text
        };
        Ok(Self {
            messages: Arc::new(Messages {
                service,
                binding,
                context,
                mode: "goal",
                output: Mutex::new(Output::default()),
            }),
            prompt,
            response: command["resultMode"].clone(),
        })
    }

    fn finish(&self, result: Value) -> Result<Value> {
        finish_goal(
            &self.messages,
            result,
            &self.response["messageId"],
            &self.response["idempotencyKey"],
            self.response["reusePublishedResponse"] == true,
        )
    }
}

fn finish_goal(
    messages: &Messages,
    mut result: Value,
    message_id: &Value,
    idempotency: &Value,
    reuse_published: bool,
) -> Result<Value> {
    messages.assert_bound()?;
    let published = reuse_published
        .then(|| messages.final_message(&result))
        .flatten();
    let message = match published {
        Some(message) => message,
        None => {
            let text = result["text"]
                .as_js_string()
                .context("Missing native Goal output")?;
            let fallback = "The Task Goal completed without a message.".into();
            messages.seal(
                message_id,
                idempotency,
                "assistant",
                "goal",
                if text.is_empty() { &fallback } else { text },
            )?
        }
    };
    result["text"] = json!("");
    result["structuredResult"] =
        checked("taskMessageRelayResultSchema", &json!({"message":message}))?;
    checked("agentTurnResultSchema", &result)
}

impl Round {
    fn finish(&self, mut result: Value) -> Result<Value> {
        self.messages.assert_bound()?;
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

        let assistant = match self.messages.final_message(&result) {
            Some(message) => message,
            None => self.message(
                "assistant",
                if direct { "default" } else { "plan" },
                "task-result",
                &completed.assistant,
            )?,
        };
        let secret = &self.messages.binding.component.key;
        result["text"] = json!("");
        result["structuredResult"] = checked(
            "taskOperationRelayResultSchema",
            &json!({
                "chatId":self.request["chatId"],"operationId":self.request["operationId"],"fingerprint":self.request["fingerprint"],
                "classification":round["classification"],
                "protectedResult":encrypt_communication(Communication::TaskPlanningRound, secret, &self.messages.context, &round)?,
                "task":opaque(Communication::Task, secret, &self.messages.context, &task)?,
                "assistantMessage":assistant,"goal":goal,
            }),
        )?;
        checked("agentTurnResultSchema", &result)
    }

    fn message(&self, role: &str, mode: &str, key: &str, text: &JsString) -> Result<Value> {
        let id = json!(uuid::Uuid::new_v4().to_string());
        let idempotency = json!(format!(
            "{key}:{}",
            self.request["operationId"].as_str().unwrap()
        ));
        self.messages.seal(&id, &idempotency, role, mode, text)
    }

    fn goal_payload(&self, thread: &Value, task: &Value, objective: &JsString) -> Result<Value> {
        let mut context = self.messages.context.clone();
        context["threadId"] = thread.clone();
        let classification =
            json!({"chatId":self.messages.context["chatId"],"threadId":thread,"status":"active"});
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
        let secret = &self.messages.binding.component.key;
        Ok(json!({
            "classification":classification,
            "failureTask":opaque(Communication::Task, secret, &self.messages.context, &failed)?,
            "protectedObjective":encrypt_communication(Communication::TaskGoalObjective, secret, &context,
                &json!({"version":1,"classification":classification,"objective":objective}))?,
            "startMessage":self.message("user", "goal", "task-goal", &prompt)?,
        }))
    }
}
