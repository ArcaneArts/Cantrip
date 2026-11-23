//! Reviewed PR lifecycle. Tokens are the Source JSON digest, not a local
//! approximation; apply refreshes the preview before accepting remote effects.
use super::{Client, api, helpers, pull_path};
use crate::{error::WireError, filesystem::Scope, github::process};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};

fn token(detail: &Value, action: &Value) -> String {
    let input = json!({"action":action,"number":detail["number"],"state":detail["state"],"draft":detail["draft"],"merged":detail["merged"],"headSha":detail["headSha"],"baseSha":detail["baseSha"],"mergeable":detail["mergeable"],"mergeableState":detail["mergeableState"],"checksState":detail["checksState"],"reviewDecision":detail["reviewDecision"],"autoMerge":detail["autoMerge"],"mergeQueueEntry":detail["mergeQueueEntry"]});
    Sha256::digest(input.stringify().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn text(value: &Value) -> JsString {
    value.as_js_string().unwrap().clone()
}
impl Client {
    pub(in crate::github) async fn preview_pull(
        &self,
        command: &Value,
        action: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let detail = self.pull_all(command, scope).await?;
        let number = api::text(Some(&detail["number"]))?.lossy().into_owned();
        let mut warnings: Vec<JsString> = Vec::new();
        let mut destructive = false;
        let mut confirmation = Value::Null;
        match action["type"].as_str().unwrap() {
            "close" => {
                if detail["state"] != "open" || detail["merged"] == true { bail!("Only an open, unmerged pull request can be closed."); }
                destructive = true; confirmation = json!(format!("close #{number}"));
                warnings.push(helpers::join(&[format!("This closes #{number} without merging ").into(),text(&detail["headRef"])," into ".into(),text(&detail["baseRef"]),".".into()],""));
            }
            "reopen" => {
                if detail["state"] != "closed" || detail["merged"] == true { bail!("Only a closed, unmerged pull request can be reopened."); }
            }
            "mark-ready" => {
                if detail["state"] != "open" || detail["draft"] != true || detail["merged"] == true { bail!("Only an open draft pull request can be marked ready."); }
                warnings.push("GitHub will notify requested reviewers that this draft is ready for review.".into());
            }
            "convert-draft" => warnings.push("Requested reviewers will no longer be expected to review this pull request until it is marked ready again.".into()),
            "update-branch" => warnings.push(helpers::join(&["GitHub will update ".into(),text(&detail["headRef"])," with the latest changes from ".into(),text(&detail["baseRef"])," and may run checks again.".into()],"")),
            "merge" => {
                if detail["state"] != "open" || detail["draft"] == true || detail["merged"] == true { bail!("Only an open, non-draft pull request can be merged."); }
                if detail["mergeable"].is_null() { bail!("GitHub is still calculating mergeability. Refresh and try again."); }
                if detail["mergeable"] != true {
                    return Err(WireError(helpers::join(&["GitHub reports this pull request is not mergeable (".into(),text(&detail["mergeableState"]),").".into()],"")).into());
                }
                let method = action["method"].as_str().unwrap();
                destructive = true; confirmation = json!(format!("{method} #{number}"));
                warnings.push(helpers::join(&[format!("{method} will integrate ").into(),text(&detail["headRef"]),format!(" ({}) into ",&detail["headSha"].as_str().unwrap()[..7]).into(),text(&detail["baseRef"]),format!(" at {}.",&detail["baseSha"].as_str().unwrap()[..7]).into()],""));
                if detail["checksState"] != "success" && detail["checksState"] != "none" {
                    warnings.push(helpers::join(&["Checks currently report ".into(),text(&detail["checksState"]),".".into()],""));
                }
                match detail["reviewDecision"].as_str().unwrap() {
                    "changes-requested" => warnings.push("At least one latest review requests changes.".into()),
                    "review-required" => warnings.push("Requested reviews are still outstanding.".into()), _ => {},
                }
            }
            "enable-auto-merge" => {
                destructive = true; confirmation = json!(format!("auto-merge #{number}"));
                warnings.push(format!("GitHub will {} this pull request automatically once repository requirements are satisfied.",action["method"].as_str().unwrap()).into());
            }
            "disable-auto-merge" => {},
            "enqueue-merge-queue" => {
                destructive = true; confirmation = json!(format!("queue #{number}"));
                warnings.push("The pull request will merge when it reaches the front of GitHub's merge queue and required checks pass.".into());
            }
            "dequeue-merge-queue" => warnings.push("Removing this pull request from the merge queue may discard its current queue position.".into()),
            _ => unreachable!("validated lifecycle action"),
        }
        let mut result = json!({"action":action,"destructive":destructive,"confirmationPhrase":confirmation,"warnings":warnings,"token":token(&detail,action)});
        for field in [
            "number",
            "title",
            "state",
            "draft",
            "headRef",
            "headSha",
            "baseRef",
            "baseSha",
            "mergeable",
            "mergeableState",
            "checksState",
            "reviewDecision",
        ] {
            result[field] = detail[field].clone();
        }
        checked("githubPullRequestLifecyclePreviewSchema", &result)
    }
    pub(in crate::github) async fn apply_pull(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let request = &command["request"];
        let action = &request["action"];
        let preview = self.preview_pull(command, action, scope).await?;
        if preview["token"] != request["token"] {
            bail!("The pull request no longer matches this preview. Review the action again.");
        }
        if !preview["confirmationPhrase"].is_null()
            && request["confirmation"] != preview["confirmationPhrase"]
        {
            bail!(
                "Type {} to confirm this action.",
                preview["confirmationPhrase"].as_str().unwrap()
            );
        }
        let path = pull_path(command)?;
        match action["type"].as_str().unwrap() {
            "close" | "reopen" => {
                let state = json!(if action["type"] == "close" {
                    "closed"
                } else {
                    "open"
                });
                self.api(&path, &helpers::form("PATCH", &[("state", &state)])?, scope)
                    .await?;
            }
            "mark-ready" => {
                process::run_values(
                    &[
                        "pr".into(),
                        "ready".into(),
                        api::text(Some(&command["number"]))?,
                        "--repo".into(),
                        text(&command["repository"]),
                    ],
                    4 * 1024 * 1024,
                    scope,
                )
                .await?;
            }
            "update-branch" => {
                self.api(
                    &format!("{path}/update-branch"),
                    &helpers::form("PUT", &[("expected_head_sha", &preview["headSha"])])?,
                    scope,
                )
                .await?;
            }
            "merge" => {
                let mut args = helpers::form(
                    "PUT",
                    &[
                        ("merge_method", &action["method"]),
                        ("sha", &preview["headSha"]),
                    ],
                )?;
                for (key, field) in [
                    ("commit_title", "commitTitle"),
                    ("commit_message", "commitMessage"),
                ] {
                    if cantrip_wire::coercion::truthy(Some(&action[field])) {
                        args.extend([
                            "-f".into(),
                            api::prefix(&format!("{key}="), &text(&action[field])),
                        ]);
                    }
                }
                let response = self.api(&format!("{path}/merge"), &args, scope).await?;
                if api::member(&response, "merged")? != Some(&json!(true)) {
                    return Err(WireError(
                        response
                            .get("message")
                            .and_then(Value::as_js_string)
                            .cloned()
                            .unwrap_or_else(|| "GitHub did not merge the pull request.".into()),
                    )
                    .into());
                }
            }
            kind => {
                let context = self.pull_context(command, scope).await?;
                let id = &context["nodeId"];
                match kind {
                    "convert-draft" => {
                        self.pull_graphql(
                            include_str!("convert-draft.graphql"),
                            &[("pullRequestId", id)],
                            scope,
                        )
                        .await?;
                    }
                    "enable-auto-merge" => {
                        self.pull_graphql(
                            include_str!("enable-auto-merge.graphql"),
                            &[
                                ("pullRequestId", id),
                                ("head", &preview["headSha"]),
                                (
                                    "method",
                                    &json!(action["method"].as_str().unwrap().to_uppercase()),
                                ),
                                ("title", &action["commitTitle"]),
                                ("body", &action["commitMessage"]),
                            ],
                            scope,
                        )
                        .await?;
                    }
                    "disable-auto-merge" => {
                        self.pull_graphql(
                            include_str!("disable-auto-merge.graphql"),
                            &[("pullRequestId", id)],
                            scope,
                        )
                        .await?;
                    }
                    "enqueue-merge-queue" => {
                        self.pull_graphql(
                            include_str!("enqueue.graphql"),
                            &[("pullRequestId", id), ("head", &preview["headSha"])],
                            scope,
                        )
                        .await?;
                    }
                    "dequeue-merge-queue" => {
                        self.pull_graphql(
                            include_str!("dequeue.graphql"),
                            &[("pullRequestId", id)],
                            scope,
                        )
                        .await?;
                    }
                    _ => unreachable!("validated lifecycle action"),
                }
            }
        }
        self.pull_all(command, scope).await
    }
}
