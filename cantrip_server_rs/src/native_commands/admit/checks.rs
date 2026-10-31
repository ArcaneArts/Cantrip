use super::{Admission, includes, optional, raw_one, reject, text};
use crate::{
    chats::{
        execution_lanes,
        guard::{self, Access},
        managed_console,
    },
    database::{Executor, Transaction},
    native_commands::{
        context, permissions,
        policy::{self, Kind},
        settings_persistence,
    },
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
use futures::FutureExt;

impl Admission<'_> {
    pub(super) async fn check(&mut self, tx: &Transaction<'_>) -> Result<()> {
        let input = self.input;
        let intent = &input["intent"];
        let session = &input["session"];
        let chat = text(&session["chatId"])?;
        let method = text(&input["method"])?;
        if let Some(expected) = self.options.get("expectedInputRevision")
            && Some(expected) != self.context.get("managedInputRevision")
        {
            return reject("cancelled-before-admission");
        }
        let runtime = optional(&session["runtimeGeneration"])?;
        guard::assert_runtime_writable(
            tx,
            &chat,
            runtime.as_deref(),
            None,
            if policy::classify(&method) == Some(Kind::Attach) {
                Access::Attach
            } else {
                Access::Write
            },
        )
        .await?;
        if managed_console::session_context(&self.context).is_none() {
            return reject("managed-session-ineligible");
        }
        if (method == "turn/pause"
            && (!intent["paused"].is_boolean()
                || truthy(intent.get("resumeAutonomy")) == truthy(intent.get("paused"))))
            || (method != "turn/pause" && intent.get("paused").is_some())
        {
            return reject("invalid-pause-intent");
        }
        if truthy(intent.get("resumeAutonomy"))
            && !matches!(
                method.as_str(),
                "thread/queue/add" | "thread/queue/start" | "thread/goal/set" | "turn/pause"
            )
        {
            return reject("invalid-autonomy-resume");
        }
        self.check_queue(tx).boxed().await?;
        let policy = policy::classify_admission(input)?;
        if truthy(intent.get("settingsBindingId")) {
            settings_persistence::assert_write_binding(
                tx,
                self.owner,
                &chat,
                &intent["settingsBindingId"],
                Some(input),
            )
            .await?;
        }
        self.row["kind"] = Value::from_serialize(&policy.kind);
        self.starts = policy.kind == Kind::Start;
        if self.starts && input["origin"] == "gui" {
            self.row["logical_operation_id"] = input["operationId"].clone();
        }
        let security = [
            "approvalPolicy",
            "approvalsReviewer",
            "sandboxPolicy",
            "permissions",
            "permissionProfile",
            "permissionProfileId",
        ];
        if !truthy(intent.get("permissionTransition"))
            && security.iter().any(|k| includes(&intent["settingKeys"], k))
            && intent.get("permissionProfileId")
                != Some(&managed_console::permission_profile(&self.context)["effectiveId"])
        {
            return reject("permission-profile-mismatch");
        }
        if truthy(intent.get("permissionTransition")) {
            let state =
                settings_persistence::get(Executor::Transaction(tx), self.owner, &chat).await?;
            let Some(state) = state else {
                return reject("chat-not-found");
            };
            permissions::assert_transition(&self.context, &state, input)?;
        }
        if (method.starts_with("fs/") || includes(&intent["settingKeys"], "cwd"))
            && intent["pathsWithinPlacement"] != true
        {
            return reject("path-scope-mismatch");
        }
        if self.context.get("threadId") != session.get("threadId")
            || (!truthy(session.get("threadId"))
                && (input["origin"] != "gui"
                    || (!self.starts && !truthy(self.options.get("canonicalQueueMutation")))))
        {
            return reject("thread-identity-mismatch");
        }
        if !context::same_runtime_route(Some(&self.context), Some(session))? {
            return reject("runtime-route-mismatch");
        }
        let activation = raw_one(
            tx,
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&chat],
        )
        .await?
        .unwrap_or(Value::Null);
        if self.starts {
            if input["expectedActivationGeneration"] != Value::Null {
                return reject("stale-activation");
            }
            let actor = self
                .options
                .get("acquiringActor")
                .filter(|v| !v.is_null())
                .map(text)
                .transpose()?
                .unwrap_or_else(|| "user".into());
            let purpose = self
                .options
                .get("purpose")
                .filter(|v| !v.is_null())
                .map(text)
                .transpose()?
                .unwrap_or_else(|| "Managed native command".into());
            self.context =
                execution_lanes::start_in_transaction(tx, self.owner, &chat, &actor, &purpose)
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null);
            if !truthy(self.context.get("executionLaneId")) {
                return reject("execution-unavailable");
            }
            self.row["activation_generation"] = json!(uuid::Uuid::new_v4().to_string());
            self.row["execution_lane_id"] = self.context["executionLaneId"].clone();
        } else {
            let active = matches!(
                self.context["status"].as_str(),
                Some("running" | "waiting-for-approval")
            );
            let discovery = policy::contains("sessionDiscoveryMethods", &method);
            if policy.active || (active && !discovery) {
                if !truthy(activation.get("active"))
                    || !active
                    || input.get("expectedActivationGeneration") != activation.get("generation")
                    || activation.get("worker_id") != input.get("workerId")
                    || activation.get("execution_lane_id") != self.context.get("executionLaneId")
                    || activation.get("runtime_generation") != session.get("runtimeGeneration")
                {
                    return reject("stale-activation");
                }
                self.row["activation_generation"] = activation["generation"].clone();
                self.row["execution_lane_id"] = activation["execution_lane_id"].clone();
                if truthy(intent.get("expectedTurnId"))
                    && activation.get("native_turn_id") != intent.get("expectedTurnId")
                {
                    return reject("stale-native-turn");
                }
                if truthy(input.get("reply")) {
                    let pending=raw_one(tx,"SELECT to_jsonb(n)::text FROM native_pending_requests n WHERE chat_id=$1 AND runtime_generation=$2 AND native_request_id=$3",&[&chat,&runtime,&text(&input["reply"]["nativeRequestId"])?]).await?;
                    if !pending.is_some_and(|p| {
                        !truthy(p.get("resolution_operation_id"))
                            && p.get("activation_generation") == activation.get("generation")
                            && p.get("request_method") == input["reply"].get("requestMethod")
                            && p.get("turn_id") == input["reply"].get("turnId")
                    }) {
                        return reject("stale-native-reply");
                    }
                    self.consume_reply = true;
                }
            } else if !discovery && input["expectedActivationGeneration"] != Value::Null {
                return reject("stale-activation");
            }
        }
        Ok(())
    }
}
