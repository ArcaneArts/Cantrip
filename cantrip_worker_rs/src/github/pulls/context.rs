//! Bounded agent evidence; reading failed-step logs never starts hosted work.
use super::{Client, api, helpers, parse};
use crate::{filesystem::Scope, github::process};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;

fn run_id(value: &Value) -> Option<String> {
    let url = url::Url::parse(&value.as_js_string()?.lossy()).ok()?;
    if url.host_str()? != "github.com" {
        return None;
    }
    url.path()
        .match_indices("/actions/runs/")
        .find_map(|(index, prefix)| {
            let digits: String = url.path()[index + prefix.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            (!digits.is_empty()).then_some(digits)
        })
}
fn failed(value: &Value) -> bool {
    matches!(
        value["conclusion"].as_str(),
        Some("failure" | "error" | "timed_out" | "cancelled" | "action_required")
    )
}
async fn logs(id: String, repository: JsString, scope: Scope) -> (String, Value) {
    let args = [
        "run".into(),
        "view".into(),
        id.clone().into(),
        "--repo".into(),
        repository,
        "--log-failed".into(),
    ];
    let result = process::run_output(
        "gh",
        &args,
        4 * 1024 * 1024,
        Some(std::time::Duration::from_secs(30)),
        &scope,
    )
    .await;
    let log = match result {
        Ok((stdout, stderr)) => {
            let output = helpers::join(&[stdout.into(), stderr.into()], "").trim();
            if output.is_empty() {
                json!({"excerpt":Value::Null,"unavailableReason":"GitHub returned no failed-step log output for this run."})
            } else {
                json!({"excerpt":JsString::new(output.units()[output.len().saturating_sub(100_000)..].to_vec()),"unavailableReason":Value::Null})
            }
        }
        Err(error) => {
            json!({"excerpt":Value::Null,"unavailableReason":parse::crop(&api::prefix("Failed-step logs could not be loaded: ",&crate::error::message(&error)),2000)})
        }
    };
    (id, log)
}
impl Client {
    pub(in crate::github) async fn agent_pull(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let pull = self.pull_all(command, scope).await?;
        let intent = &command["request"]["intent"];
        let failed_checks = super::array(&pull["checks"])
            .iter()
            .filter(|check| failed(check))
            .take(20)
            .collect::<Vec<_>>();
        let mut log_map = IndexMap::new();
        if *intent == "fix-checks" {
            for check in &failed_checks {
                if let Some(id) = run_id(&check["url"]) {
                    log_map.entry(id).or_insert(Value::Null);
                }
            }
            let keys = log_map.keys().take(5).cloned().collect::<Vec<_>>();
            log_map.clear();
            for (id, log) in futures::future::join_all(keys.into_iter().map(|id| {
                logs(
                    id,
                    command["repository"].as_js_string().unwrap().clone(),
                    scope.clone(),
                )
            }))
            .await
            {
                log_map.insert(id, log);
            }
        }
        let mut evidence = Vec::new();
        if *intent == "fix-checks" {
            for check in failed_checks {
                let id = run_id(&check["url"]);
                let log = id.as_ref().and_then(|id| log_map.get(id));
                let reason = log
                    .map(|log| log["unavailableReason"].clone())
                    .unwrap_or_else(|| {
                        json!(if id.is_some() {
                            "This run was outside the bounded log-fetch window."
                        } else {
                            "This check does not expose GitHub Actions run logs."
                        })
                    });
                evidence.push(json!({"checkId":check["id"],"name":check["name"],"url":check["url"],"summary":check["summary"],"logExcerpt":log.map(|log|log["excerpt"].clone()).unwrap_or(Value::Null),"logUnavailableReason":reason}));
            }
        }
        let threads = if *intent == "address-review" {
            super::array(&pull["reviewThreads"])
                .iter()
                .filter(|thread| thread["resolved"] != true)
                .cloned()
                .collect()
        } else {
            Vec::<Value>::new()
        };
        checked(
            "githubPullRequestAgentContextSchema",
            &json!({"intent":intent,"pullRequest":pull,"activeReviewThreads":threads,"failedChecks":evidence}),
        )
    }
}
