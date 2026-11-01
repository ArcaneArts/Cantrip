use super::*;
use crate::native_commands::receipt::iso;

pub(super) async fn one(
    ex: Executor<'_, '_>,
    sql: &str,
    parameters: Parameters<'_>,
) -> Result<Option<Value>> {
    ex.query(sql, parameters)
        .await?
        .first()
        .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
        .transpose()
}
pub(super) async fn owned(
    ex: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    lock: bool,
) -> Result<Option<Value>> {
    one(ex, &format!("SELECT to_jsonb(t)::text FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE p.owner_id=$1 AND t.chat_id=$2 LIMIT 1{}", if lock { " FOR UPDATE" } else { "" }), &[&owner, &chat]).await
}
pub(super) async fn lock_user(tx: &Transaction<'_>, owner: &str) -> Result<bool> {
    Ok(!tx
        .query(
            "SELECT id FROM users WHERE id=$1 LIMIT 1 FOR UPDATE",
            &[&owner],
        )
        .await?
        .is_empty())
}
pub(super) fn task_columns(content: &Value) -> Value {
    let mut out = json!({"protected_content":content["protectedContent"]});
    for (name, column) in classification_columns() {
        out[column] = content["classification"][name].clone();
    }
    out
}
fn classification_columns() -> [(&'static str, &'static str); 10] {
    [
        ("state", "state"),
        ("stableStateBeforeFailure", "stable_state_before_failure"),
        ("activeOperationKind", "active_operation_kind"),
        ("planAuthorship", "plan_authorship"),
        ("planningRound", "planning_round"),
        ("hasPlan", "has_plan"),
        ("hasQuestions", "has_questions"),
        ("hasFinalPlan", "has_final_plan"),
        ("hasGoalPrompt", "has_goal_prompt"),
        ("lastError", "last_error"),
    ]
}
pub(super) fn task_content(row: &Value) -> Value {
    let mut classification = Value::object([] as [(&str, Value); 0]);
    for (name, column) in classification_columns() {
        classification[name] = row[column].clone();
    }
    json!({"classification":classification,"protectedContent":row["protected_content"]})
}
pub(super) fn round_columns(classification: &Value, protected: &Value) -> Value {
    let mut out = json!({"protected_content":protected});
    for (name, column) in [
        ("ordinal", "ordinal"),
        ("kind", "kind"),
        ("status", "status"),
        ("hasOutputPlan", "has_output_plan"),
        ("hasOutputQuestions", "has_output_questions"),
        ("hasOutputGoalPrompt", "has_output_goal_prompt"),
        ("error", "error"),
    ] {
        out[column] = classification[name].clone();
    }
    out
}
pub(super) fn summary(row: &Value, dispatch: Option<&Value>) -> Result<Value> {
    let mut out = task_content(row)["classification"].clone();
    for (name, column) in [
        ("chatId", "chat_id"),
        ("planGoalEnabled", "plan_goal_enabled"),
        ("priority", "priority"),
        ("requestedTaskWorkerId", "requested_task_worker_id"),
        ("continuityFamily", "continuity_family"),
        ("lastTaskWorkerId", "last_task_worker_id"),
        ("activeOperationId", "active_operation_id"),
        ("draftAttachmentIds", "draft_attachment_ids"),
        ("protectedContent", "protected_content"),
        ("schedulerRevision", "scheduler_revision"),
        ("rowVersion", "row_version"),
    ] {
        out[name] = row[column].clone();
    }
    out["automaticRetry"] = policy::retry_summary(
        &row["automatic_retry"],
        crate::auth::now().timestamp_millis(),
    )?;
    out["dispatch"] = dispatch
        .map(crate::task_dispatch::summary)
        .transpose()?
        .unwrap_or(Value::Null);
    for (name, column) in [
        ("implementationStartedAt", "implementation_started_at"),
        ("completedAt", "completed_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ] {
        out[name] = if row[column].is_null() {
            Value::Null
        } else {
            iso(&row[column])?
        };
    }
    parse("taskOpaqueSummarySchema", &out)
}
pub(super) fn round_summary(row: &Value) -> Result<Value> {
    let mut out = Value::object([] as [(&str, Value); 0]);
    for (name, column) in [
        ("id", "id"),
        ("chatId", "chat_id"),
        ("ordinal", "ordinal"),
        ("kind", "kind"),
        ("status", "status"),
        ("hasOutputPlan", "has_output_plan"),
        ("hasOutputQuestions", "has_output_questions"),
        ("hasOutputGoalPrompt", "has_output_goal_prompt"),
        ("error", "error"),
        ("protectedContent", "protected_content"),
        ("userMessageId", "user_message_id"),
        ("assistantMessageId", "assistant_message_id"),
        ("executionLaneId", "execution_lane_id"),
        ("turnId", "turn_id"),
    ] {
        out[name] = row[column].clone();
    }
    out["startedAt"] = iso(&row["started_at"])?;
    out["completedAt"] = if row["completed_at"].is_null() {
        Value::Null
    } else {
        iso(&row["completed_at"])?
    };
    parse("taskPlanningRoundOpaqueSummarySchema", &out)
}
pub(super) fn context(task: &Value, round: &Value) -> Result<Value> {
    Ok(
        json!({"task":summary(task,None)?,"round":round_summary(round)?,"relayRequest":round["relay_request"],"relayResult":round["relay_result"]}),
    )
}
pub(super) enum Table {
    Task,
    Round,
}
impl Table {
    fn names(&self) -> (&'static str, &'static str) {
        match self {
            Self::Task => ("tasks", "chat_id"),
            Self::Round => ("task_planning_rounds", "id"),
        }
    }
}
/// Only explicitly supplied columns are updated, retaining the source's
/// transaction boundaries and column-trigger behavior.
pub(super) async fn update(
    tx: &Transaction<'_>,
    table: Table,
    id: &str,
    fields: &Value,
    guard: Option<(&str, &Value)>,
) -> Result<Option<Value>> {
    let (table, key) = table.names();
    let assignments = fields
        .as_object()
        .context("Task update columns")?
        .keys()
        .map(|k| format!("{k}=d.{k}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "UPDATE {table} t SET {assignments} FROM jsonb_populate_record(NULL::{table},$2::text::jsonb) d WHERE t.{key}=$1"
    );
    let fields = fields.stringify();
    if let Some((column, value)) = guard {
        // Preserve the source column's SQL type, including an actual database
        // range error for wire-valid revisions outside PostgreSQL int4.
        let (cast, value) = match column {
            "row_version" => ("integer", value.stringify()),
            "active_operation_id" => ("text", text(value)?),
            _ => unreachable!("Task repository guard column"),
        };
        one(
            Executor::Transaction(tx),
            &format!("{sql} AND t.{column}=$3::text::{cast} RETURNING to_jsonb(t)::text"),
            &[&id, &fields, &value],
        )
        .await
    } else {
        one(
            Executor::Transaction(tx),
            &format!("{sql} RETURNING to_jsonb(t)::text"),
            &[&id, &fields],
        )
        .await
    }
}
pub(super) async fn locked_round(
    tx: &Transaction<'_>,
    chat: &str,
    operation: &str,
) -> Result<Option<Value>> {
    one(Executor::Transaction(tx), "SELECT to_jsonb(r)::text FROM task_planning_rounds r WHERE r.id=$1 AND r.chat_id=$2 LIMIT 1 FOR UPDATE", &[&operation,&chat]).await
}
pub(super) async fn locked_task(tx: &Transaction<'_>, chat: &str) -> Result<Option<Value>> {
    one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(t)::text FROM tasks t WHERE t.chat_id=$1 LIMIT 1 FOR UPDATE",
        &[&chat],
    )
    .await
}
