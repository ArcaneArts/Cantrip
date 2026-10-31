use super::Repository;
use crate::database::Executor;
use crate::wire::{Value, coercion::truthy, value::json};
use anyhow::{Result, bail};

fn nullable(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}
fn nullish(value: Option<&Value>, fallback: Value) -> Value {
    value.filter(|v| !v.is_null()).cloned().unwrap_or(fallback)
}
fn primitive_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    !matches!(a, Some(Value::Array(_) | Value::Object(_)))
        && !matches!(b, Some(Value::Array(_) | Value::Object(_)))
        && a == b
}
pub(super) use crate::wire::property;
fn permission_projection(state: &Value, source: Value) -> Result<Value> {
    let policy = state.get("permissionPolicy");
    let mut retained = false;
    if truthy(policy) && !source["threadId"].is_null() {
        retained = true;
        for (key, expected) in source.as_object().unwrap() {
            if property(policy.unwrap().get("source"), key.as_str().unwrap())? != Some(expected) {
                retained = false;
                break;
            }
        }
    }
    let mut confirmed = false;
    if retained && truthy(state.get("binding")) {
        let policy = policy.unwrap();
        let generation = property(policy.get("source"), "runtimeGeneration")?;
        let binding = &state["binding"];
        if primitive_equal(generation, binding.get("runtimeGeneration")) {
            confirmed = primitive_equal(
                property(policy.get("settingsVersion"), "epoch")?,
                binding.get("nativeEpoch"),
            );
        }
    }
    Ok(
        json!({"nativePermissionPolicy":if retained{policy.unwrap().clone()}else{Value::Null},"nativePermissionPolicyConfirmed":confirmed}),
    )
}

impl Repository {
    pub async fn execution_context(&self, owner: &str, chat_id: &str) -> Result<Option<Value>> {
        Self::execution_context_with(Executor::Database(&self.database), owner, chat_id).await
    }
    pub(crate) async fn execution_context_with(
        executor: Executor<'_, '_>,
        owner: &str,
        chat_id: &str,
    ) -> Result<Option<Value>> {
        let identity = executor
            .query(
                "SELECT context_kind FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&chat_id, &owner],
            )
            .await?;
        let standalone = identity
            .first()
            .map(|r| r.get::<String>(0))
            .transpose()?
            .as_deref()
            == Some("standalone");
        let sql = if standalone {
            "SELECT jsonb_build_object('chat',to_jsonb(c),'lane',to_jsonb(l),'settings',to_jsonb(s),'nativeSettings',to_jsonb(n),'root',to_jsonb(root),'runtime',to_jsonb(r))::text FROM chats c LEFT JOIN native_settings_states n ON n.chat_id=c.id INNER JOIN standalone_chat_roots root ON root.id=c.active_scratch_root_id AND root.chat_id=c.id AND root.owner_id=c.owner_id AND root.worker_id=c.active_worker_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=root.worker_id AND r.scratch_root_id=root.id LEFT JOIN chat_execution_lanes l ON l.chat_id=c.id AND l.state='active' LEFT JOIN user_settings s ON s.user_id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2 AND c.context_kind='standalone' AND c.archived_at IS NULL LIMIT 1"
        } else {
            "SELECT jsonb_build_object('chat',to_jsonb(c),'lane',to_jsonb(l),'project',to_jsonb(p),'settings',to_jsonb(s),'nativeSettings',to_jsonb(n),'root',to_jsonb(w),'runtime',to_jsonb(r))::text FROM chats c LEFT JOIN native_settings_states n ON n.chat_id=c.id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$2 LEFT JOIN user_settings s ON s.user_id=p.owner_id INNER JOIN project_worktrees w ON w.id=c.active_worktree_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=w.worker_id AND r.worktree_id=w.id LEFT JOIN chat_execution_lanes l ON l.chat_id=c.id AND l.state='active' WHERE c.id=$1 AND c.archived_at IS NULL LIMIT 1"
        };
        let rows = executor.query(sql, &[&chat_id, &owner]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let row: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let (chat, settings, root, runtime) = (
            &row["chat"],
            &row["settings"],
            &row["root"],
            &row["runtime"],
        );
        let project_id = if standalone {
            Value::Null
        } else {
            chat["project_id"].clone()
        };
        if !standalone && !truthy(Some(&project_id)) {
            bail!("Project Chat operation received a standalone Chat.");
        }
        let model = crate::settings::parse_response(
            "modelConfigurationSchema",
            Some(&json!({
                "modelId":chat["model_id"],"reasoningEffort":chat["reasoning_effort"],
                "customSubagentModel":chat["custom_subagent_model"],"subagentModelId":chat["subagent_model_id"],
                "subagentReasoningEffort":chat["subagent_reasoning_effort"]
            })),
        )?;
        let thread = nullable(runtime.get("codex_thread_id"));
        let source = json!({"threadId":thread,"workerId":root["worker_id"],"placementId":root["id"],"modelRouteId":nullable(runtime.get("model_route_id")),"providerAccountId":nullable(runtime.get("provider_account_id")),"contextKind":if standalone{"standalone"}else{"project"},"projectId":project_id});
        let permission = permission_projection(&row["nativeSettings"]["state"], source)?;
        let mut context = json!({
            "contextKind":if standalone{"standalone"}else{"project"},
            "automationPaused":chat["automation_paused"],"chatId":chat_id,
            "computerUseEnabled":settings["computer_use_enabled"]==Value::Bool(true),
            "computerUseAuthorityGeneration":chat["computer_use_authority_generation"],
            "managedInputRevision":chat["managed_input_revision"],
            "cwd":if standalone{nullish(root.get("protected_path_handle"),json!("standalone-root-unavailable"))}else{root["absolute_path"].clone()},
            "experience":if standalone{json!("agent")}else{chat["experience"].clone()},
            "defaultPermissionProfileId":nullish(settings.get(if standalone{"default_chat_permission_profile_id"}else{"default_permission_profile_id"}),json!(":workspace")),
            "executionLaneId":nullable(row["lane"].get("id")),
            "isPrimary":if standalone{Value::Bool(true)}else{root["is_primary"].clone()},
            "modelId":chat["model_id"],"reasoningEffort":chat["reasoning_effort"],"modelConfiguration":model,
            "modelRouteId":nullable(runtime.get("model_route_id")),"providerAccountId":nullable(runtime.get("provider_account_id")),
            "permissionProfileId":chat["permission_profile_id"],
            "nativePermissionPolicy":permission["nativePermissionPolicy"],"nativePermissionPolicyConfirmed":permission["nativePermissionPolicyConfirmed"],
            "planMode":if standalone{json!("default")}else{chat["plan_mode"].clone()},
            "projectId":project_id,"rootKind":if standalone{Value::Null}else{root["root_kind"].clone()},
            "scratchRootId":if standalone{root["id"].clone()}else{Value::Null},
            "status":if standalone && root["status"]!="ready"{if root["status"]=="failed"{json!("failed")}else{json!("offline")}}else{chat["status"].clone()},
            "threadId":thread,"workerId":root["worker_id"],"worktreeId":if standalone{Value::Null}else{root["id"].clone()},
            "worktreeMode":if standalone{Value::Null}else{chat["worktree_mode"].clone()},
            "worktreePolicy":if standalone{Value::Null}else{row["project"]["worktree_policy"].clone()}
        });
        if standalone {
            context["scratchRootStatus"] = root["status"].clone();
        }
        Ok(Some(context))
    }
}
