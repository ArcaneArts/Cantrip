use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(tag, "project-wire-summary" | "private-label-envelope") {
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
