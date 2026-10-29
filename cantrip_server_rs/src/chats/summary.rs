use crate::wire::{self, Value, coercion::truthy, value::json};
use anyhow::{Result, bail};

pub(super) fn wire_summary(raw: &Value) -> Result<Value> {
    let standalone = raw["context_kind"] == "standalone";
    let fields = [
        ("id", "id"),
        ("contextKind", "context_kind"),
        ("projectId", "project_id"),
        ("titleProtection", "protected_label"),
        ("experience", "experience"),
        ("position", "position"),
        ("status", "status"),
        ("activeWorkerId", "active_worker_id"),
        ("activeWorktreeId", "active_worktree_id"),
        ("activeScratchRootId", "active_scratch_root_id"),
        ("placementRevision", "placement_revision"),
        ("worktreeMode", "worktree_mode"),
        ("modelId", "model_id"),
        ("reasoningEffort", "reasoning_effort"),
        ("customSubagentModel", "custom_subagent_model"),
        ("subagentModelId", "subagent_model_id"),
        ("subagentReasoningEffort", "subagent_reasoning_effort"),
        ("permissionProfileId", "permission_profile_id"),
        ("planMode", "plan_mode"),
        ("hasPendingPlanQuestion", "has_pending_plan_question"),
        ("hasUnreadCompletion", "has_unread_completion"),
        ("automationPaused", "automation_paused"),
    ];
    let mut value = Value::object(
        fields
            .into_iter()
            .map(|(target, source)| (target, raw[source].clone())),
    );
    if standalone {
        for (key, field) in [
            ("contextKind", json!("standalone")),
            ("projectId", Value::Null),
            ("experience", json!("agent")),
            ("activeWorktreeId", Value::Null),
            ("worktreeMode", Value::Null),
            ("customSubagentModel", json!(false)),
            ("subagentModelId", Value::Null),
            ("subagentReasoningEffort", Value::Null),
            ("planMode", json!("default")),
            ("hasPendingPlanQuestion", json!(false)),
        ] {
            value[key] = field;
        }
    } else {
        value["githubAgentContext"] = if [
            "github_item_kind",
            "github_item_number",
            "github_agent_intent",
            "github_head_sha",
        ]
        .into_iter()
        .all(|key| truthy(raw.get(key)))
        {
            json!({"kind":raw["github_item_kind"],"number":raw["github_item_number"],"intent":raw["github_agent_intent"],"headSha":raw["github_head_sha"]})
        } else {
            Value::Null
        };
    }
    for (target, source) in [("createdAt", "created_at"), ("updatedAt", "updated_at")] {
        let Some(parsed) = raw[source].as_js_string().and_then(wire::date_milliseconds) else {
            bail!("Invalid time value")
        };
        let Some(iso) = wire::date_iso_milliseconds(parsed) else {
            bail!("Invalid time value")
        };
        value[target] = json!(iso);
    }
    let value = crate::settings::parse_response(
        if standalone {
            "standaloneChatWireSummarySchema"
        } else {
            "chatWireSummarySchema"
        },
        Some(&value),
    )?;
    crate::settings::parse_response("contextualChatWireSummarySchema", Some(&value))
}
