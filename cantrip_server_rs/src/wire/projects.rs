use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "project-wire-summary"
            | "private-label-envelope"
            | "execution-placement-replica"
            | "execution-target-title"
            | "chat-title-kind"
            | "github-agent-workflow-context"
    ) {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut custom = |suffix: &[&str], message: String| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|p| json!(p)));
        result.issue(json!({"code":"custom"}), &at, message, false);
    };
    if tag == "github-agent-workflow-context" {
        if value["kind"] == "issue" && value["intent"] != "start-work" {
            custom(
                &["intent"],
                "Issues only support the start-work agent workflow.".into(),
            );
        }
        if value["kind"] == "pull-request" && value["intent"] == "start-work" {
            custom(
                &["intent"],
                "Pull requests support review and failed-check workflows.".into(),
            );
        }
        return Ok(true);
    }
    if tag == "chat-title-kind" {
        if value["titleProtection"]["classification"]["recordKind"] != "chat" {
            custom(&[], "Chat title classification must be chat.".into());
        }
        return Ok(true);
    }
    if tag == "execution-placement-replica" {
        if !value["worktreeId"].is_null() && value["projectReplicaId"].is_null() {
            custom(
                &["projectReplicaId"],
                "A worktree placement requires a project replica.".into(),
            );
        }
        return Ok(true);
    }
    if tag == "execution-target-title" {
        let resource = value["resourceKind"]
            .as_str()
            .ok_or(ValidationError::Operation)?;
        let expected = match resource {
            "chat" => Some("chat"),
            "terminal" => Some("terminal"),
            "explorer" => Some("explorer"),
            "code" => Some("code-tab"),
            "browser" => Some("browser"),
            "remote-desktop" => Some("project-view"),
            "remote-surface" => Some("remote-surface"),
            _ => None,
        };
        let protected = expected.is_some();
        if protected == value["titleProtection"].is_null() || protected != value["title"].is_null()
        {
            custom(&["titleProtection"], "Surface execution targets require an opaque title; placement targets require a plaintext title.".into());
        }
        if !value["titleProtection"].is_null()
            && value["titleProtection"]["classification"]["recordKind"].as_str() != expected
        {
            custom(
                &["titleProtection", "classification", "recordKind"],
                "Execution-target title classification must match its resource kind.".into(),
            );
        }
        if protected && value["target"]["kind"] != "surface" {
            custom(
                &["target"],
                "Protected execution targets must identify a surface.".into(),
            );
        }
        if protected
            && value["target"]["kind"] == "surface"
            && value["target"]["surfaceKind"] != resource
        {
            custom(
                &["target", "surfaceKind"],
                "Execution-target resource and surface kinds must describe the same surface."
                    .into(),
            );
        }
        if protected && value["placement"]["surface"]["kind"] != resource {
            custom(
                &["placement", "surface"],
                "Execution-target placement must point at the protected surface.".into(),
            );
        }
        return Ok(true);
    }
    if tag == "private-label-envelope" {
        if value["envelope"]["version"] != value["formatVersion"]
            || value["envelope"]["keyRevision"] != value["keyRevision"]
        {
            custom(
                &["envelope"],
                "Protected display-label envelope metadata must match its outer metadata.".into(),
            );
        }
        return Ok(true);
    }
    let origin = value["originKind"]
        .as_str()
        .ok_or(ValidationError::Operation)?;
    if (origin == "github" && value.get("folderManagement").is_some_and(|v| !v.is_null()))
        || (origin == "managed-folder" && value.get("folderManagement").is_some_and(Value::is_null))
    {
        custom(
            &["folderManagement"],
            "folder management must match the project origin".into(),
        );
    }
    let expected = Value::from_serialize(&crate::projects::capabilities(
        origin,
        value["capabilities"]["git"]
            .as_bool()
            .ok_or(ValidationError::Operation)?,
        value["capabilities"]["github"]
            .as_bool()
            .ok_or(ValidationError::Operation)?,
    ));
    for capability in ["git", "github", "worktrees", "replicas", "relocation"] {
        if value["capabilities"][capability] != expected[capability] {
            custom(
                &["capabilities", capability],
                format!("{capability} capability does not match {origin} origin"),
            );
        }
    }
    if value["capabilities"]["github"] == Value::Bool(true)
        && value["capabilities"]["git"] == Value::Bool(false)
    {
        custom(
            &["capabilities", "github"],
            "github capability requires git capability".into(),
        );
    }
    if value["nameProtection"]["classification"]["recordKind"] != "project" {
        custom(
            &["nameProtection", "classification", "recordKind"],
            "Project display-label classification must be project.".into(),
        );
    }
    Ok(true)
}
