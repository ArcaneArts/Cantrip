use super::super::{api, common::*, issues};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
fn status(value: Option<&Value>) -> Result<Value> {
    let value = api::text(value)?.lowercase().lossy().replace('_', "-");
    Ok(json!(if [
        "queued",
        "in-progress",
        "completed",
        "waiting",
        "requested",
        "pending"
    ]
    .contains(&value.as_str())
    {
        value.as_str()
    } else {
        "pending"
    }))
}
pub(super) fn workflow(value: &Value) -> Result<Value> {
    checked(
        "githubActionsWorkflowSchema",
        &object([
            ("id", api::number(value, "id")?),
            ("name", fallback_string(value, "name", "Unnamed workflow")?),
            ("path", fallback_string(value, "path", ".github/workflows")?),
            ("state", fallback_string(value, "state", "unknown")?),
            ("url", api::string(value, "html_url")?),
            ("badgeUrl", url(value.get("badge_url"))),
        ]),
    )
}
fn url(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_js_string)
        .filter(|s| {
            s.units()
                .starts_with(&"http://".encode_utf16().collect::<Vec<_>>())
                || s.units()
                    .starts_with(&"https://".encode_utf16().collect::<Vec<_>>())
        })
        .cloned()
        .map(Value::String)
        .unwrap_or(Value::Null)
}
pub(super) fn run(value: &Value) -> Result<Value> {
    api::member(value, "pull_requests")?;
    let mut number = Value::Null;
    for pull in array(&value["pull_requests"]) {
        if !pull.is_object() && !pull.is_array() {
            continue;
        }
        let n = api::number(pull, "number")?;
        if n.as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0 && n.fract() == 0.0)
        {
            number = n;
            break;
        }
    }
    let name = fallback_string(value, "name", "Workflow run")?;
    let display = if cantrip_wire::coercion::truthy(value.get("display_title")) {
        api::string(value, "display_title")?
    } else {
        name.clone()
    };
    checked(
        "githubActionsRunSchema",
        &object([
            ("id", api::number(value, "id")?),
            ("workflowId", api::number(value, "workflow_id")?),
            ("name", name),
            ("displayTitle", display),
            ("event", fallback_string(value, "event", "unknown")?),
            ("status", status(value.get("status"))?),
            ("conclusion", nullable(value.get("conclusion"))),
            (
                "headBranch",
                nullable(
                    value
                        .get("head_branch")
                        .filter(|v| cantrip_wire::coercion::truthy(Some(v))),
                ),
            ),
            (
                "headSha",
                Value::String(api::text(api::member(value, "head_sha")?)?.lowercase()),
            ),
            ("pullRequestNumber", number),
            ("runNumber", api::number(value, "run_number")?),
            ("runAttempt", fallback_number(value, "run_attempt", 1.0)?),
            ("actor", issues::login(value.get("actor"))),
            ("createdAt", api::string(value, "created_at")?),
            ("updatedAt", api::string(value, "updated_at")?),
            ("url", api::string(value, "html_url")?),
        ]),
    )
}
pub(super) fn job(value: &Value) -> Result<Value> {
    api::member(value, "steps")?;
    let steps = array(&value["steps"]);
    let mut parsed = Vec::new();
    for step in steps.iter().take(100) {
        parsed.push(object([
            ("number", fallback_number(step, "number", 0.0)?),
            ("name", fallback_string(step, "name", "Step")?),
            ("status", status(step.get("status"))?),
            ("conclusion", nullable(step.get("conclusion"))),
            ("startedAt", nullable(step.get("started_at"))),
            ("completedAt", nullable(step.get("completed_at"))),
        ]));
    }
    checked(
        "githubActionsJobSchema",
        &object([
            ("id", api::number(value, "id")?),
            ("name", fallback_string(value, "name", "Job")?),
            ("status", status(value.get("status"))?),
            ("conclusion", nullable(value.get("conclusion"))),
            ("url", api::string(value, "html_url")?),
            ("startedAt", nullable(value.get("started_at"))),
            ("completedAt", nullable(value.get("completed_at"))),
            (
                "runnerName",
                nullable(
                    value
                        .get("runner_name")
                        .filter(|v| cantrip_wire::coercion::truthy(Some(v))),
                ),
            ),
            (
                "runnerGroupName",
                nullable(
                    value
                        .get("runner_group_name")
                        .filter(|v| cantrip_wire::coercion::truthy(Some(v))),
                ),
            ),
            ("steps", Value::Array(parsed)),
            ("stepsTruncated", json!(steps.len() > 100)),
        ]),
    )
}
pub(super) fn runner(value: &Value) -> Result<Value> {
    let labels = array(&value["labels"])
        .iter()
        .filter_map(|label| {
            label
                .get("name")
                .filter(|name| name.is_string() && cantrip_wire::coercion::truthy(Some(name)))
                .cloned()
        })
        .take(100)
        .collect::<Vec<_>>();
    checked(
        "githubActionsRunnerSchema",
        &object([
            ("id", api::number(value, "id")?),
            ("name", fallback_string(value, "name", "Runner")?),
            ("os", fallback_string(value, "os", "unknown")?),
            (
                "status",
                json!(if value["status"] == "online" {
                    "online"
                } else {
                    "offline"
                }),
            ),
            ("busy", json!(value["busy"] == true)),
            ("labels", json!(labels)),
        ]),
    )
}
pub(super) fn artifact(value: &Value, repository: &str, run: &str) -> Result<Value> {
    let id = api::number(value, "id")?;
    let name = fallback_string(value, "name", "Artifact")?;
    let pattern =
        r"(?:^|[-_. ])(?:test|tests|junit|coverage|playwright|cypress|report)(?:$|[-_. ])";
    let regex = regress::Regex::with_flags(pattern, "iu").unwrap();
    checked(
        "githubActionsArtifactSchema",
        &object([
            ("id", id.clone()),
            ("name", name.clone()),
            ("sizeInBytes", fallback_number(value, "size_in_bytes", 0.0)?),
            ("expired", json!(value["expired"] == true)),
            ("createdAt", api::string(value, "created_at")?),
            ("expiresAt", api::string(value, "expires_at")?),
            (
                "url",
                json!(format!(
                    "https://github.com/{repository}/actions/runs/{run}/artifacts/{}",
                    api::text(Some(&id))?.lossy()
                )),
            ),
            (
                "testReport",
                json!(
                    regex
                        .find_from_utf16(name.as_js_string().unwrap().units(), 0)
                        .next()
                        .is_some()
                ),
            ),
        ]),
    )
}
