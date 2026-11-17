//! Pull-request inspection with bounded sections and partial-data warnings.
mod parse;
mod review;
use super::{Client, api, issues};
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
pub use review::{context as parse_review_context, group as group_review_threads};
const CONTEXT: &str = include_str!("../review-context.graphql");
const VIEWED: &str = include_str!("../file-states.graphql");
fn arguments() -> Vec<JsString> {
    ["--method", "GET", "-f", "per_page=100"]
        .into_iter()
        .map(JsString::from)
        .collect()
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
fn selection(value: &Value, parser: fn(&Value) -> Result<Value>) -> Result<Vec<Value>> {
    array(value).iter().take(100).map(parser).collect()
}
fn pull_path(command: &Value) -> Result<String> {
    Ok(format!(
        "{}/pulls/{}",
        api::repository_path(command["repository"].as_js_string().unwrap())?,
        api::text(Some(&command["number"]))?.lossy()
    ))
}
async fn verify(command: &Value, scope: &Scope) -> Result<()> {
    crate::git::verify_worktree(
        &paths::native(command["cwd"].as_js_string().unwrap()),
        scope,
    )
    .await
}
impl Client {
    pub(super) async fn pull_request(&self, command: &Value, scope: &Scope) -> Result<Value> {
        match command["section"].as_str().unwrap() {
            "overview" => self.pull_overview(command, scope).await,
            "files" => self.pull_files(command, scope).await,
            "commits" => self.pull_commits(command, scope).await,
            "checks" => self.pull_checks(command, scope).await,
            _ => self.pull_all(command, scope).await,
        }
    }
    async fn pull_overview(&self, command: &Value, scope: &Scope) -> Result<Value> {
        verify(command, scope).await?;
        let path = pull_path(command)?;
        let raw = self.api(&path, &[], scope).await?;
        let mut result = parse::summary(&raw)?;
        let issue_path = format!(
            "{}/issues/{}/comments",
            api::repository_path(command["repository"].as_js_string().unwrap())?,
            api::text(Some(&command["number"]))?.lossy()
        );
        let review_path = format!("{path}/reviews");
        let comments_path = format!("{path}/comments");
        let args = arguments();
        let (comments, reviews, comments_review, context) = tokio::join!(
            self.api(&issue_path, &args, scope),
            self.api(&review_path, &args, scope),
            self.api(&comments_path, &args, scope),
            async {
                review::context(
                    &review::query(
                        CONTEXT,
                        command["repository"].as_js_string().unwrap(),
                        &command["number"],
                        scope,
                    )
                    .await?,
                )
            }
        );
        let mut warnings = Vec::new();
        for (section, value) in [
            ("conversation", &comments),
            ("reviews", &reviews),
            ("review-threads", &comments_review),
            ("review-threads", &context),
        ] {
            if let Err(error) = value {
                warnings.push(review::warning(section, error));
            }
        }
        let empty = json!(Vec::<Value>::new());
        let raw_comments = comments.as_ref().unwrap_or(&empty);
        let raw_reviews = reviews.as_ref().unwrap_or(&empty);
        let raw_review_comments = comments_review.as_ref().unwrap_or(&empty);
        let parsed_reviews = selection(raw_reviews, parse::review)?;
        let parsed_comments = selection(raw_review_comments, parse::review_comment)?;
        let fallback = review::group(&parsed_comments)?;
        let context = context.as_ref().ok();
        let threads = context.map_or_else(|| fallback.clone(), |v| v["reviewThreads"].clone());
        let mut requested = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for value in array(&raw["requested_reviewers"]) {
            let value = issues::login(Some(value));
            if seen.insert(value.as_js_string().unwrap().clone()) {
                requested.push(value);
            }
        }
        result["nodeId"] = context
            .map(|v| v["nodeId"].clone())
            .unwrap_or_else(|| issues::nullable_string(raw.get("node_id")));
        for field in [
            "viewerLogin",
            "pendingReview",
            "autoMerge",
            "mergeQueueEntry",
        ] {
            result[field] = context.map_or(Value::Null, |v| v[field].clone());
        }
        result["mergeQueueEnabled"] =
            context.map_or(json!(false), |v| v["mergeQueueEnabled"].clone());
        result["comments"] = json!(selection(raw_comments, issues::parse_comment)?);
        result["commentsTruncated"] =
            json!(result["commentCount"].as_f64().unwrap() > array(raw_comments).len() as f64);
        result["reviewDecision"] = json!(if reviews.is_ok() {
            parse::review_decision(&parsed_reviews, &requested)
        } else {
            "unknown"
        });
        result["requestedReviewers"] = json!(requested);
        result["mergeableState"] = raw
            .get("mergeable_state")
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or_else(|| json!("unknown"));
        for (target, field) in [
            ("additions", "additions"),
            ("deletions", "deletions"),
            ("changedFileCount", "changed_files"),
            ("commitCount", "commits"),
        ] {
            result[target] = issues::count_field(&raw, field)?;
        }
        result["reviews"] = json!(parsed_reviews);
        result["reviewsTruncated"] = json!(array(raw_reviews).len() >= 100);
        result["reviewThreadsTruncated"] = context.map_or_else(
            || json!(array(raw_review_comments).len() >= 100 || array(&threads).len() >= 100),
            |v| v["reviewThreadsTruncated"].clone(),
        );
        result["reviewThreads"] = threads;
        result["warnings"] = json!(warnings);
        checked("githubPullRequestOverviewSchema", &result)
    }
    async fn pull_files(&self, command: &Value, scope: &Scope) -> Result<Value> {
        verify(command, scope).await?;
        let path = format!("{}/files", pull_path(command)?);
        let repository = command["repository"].as_js_string().unwrap().clone();
        let number = command["number"].clone();
        let left_scope = scope.clone();
        let right_scope = scope.clone();
        let (values, states) = self
            .join_reads(
                async move { api::request(&path, &arguments(), &left_scope).await },
                async move {
                    let result = async {
                        review::viewed(
                            &review::query(VIEWED, &repository, &number, &right_scope).await?,
                        )
                    }
                    .await;
                    Ok(match result {
                        Ok(value) => json!({"ok":true,"value":value}),
                        Err(error) => json!({"ok":false,"error":crate::error::message(&error)}),
                    })
                },
            )
            .await?;
        if !values.is_array() {
            bail!("GitHub returned an invalid pull request files response.");
        }
        let mut files = selection(&values, parse::file)?;
        if states["ok"] == true {
            for file in &mut files {
                file["viewed"] = states["value"]
                    .as_object()
                    .unwrap()
                    .get(file["path"].as_js_string().unwrap())
                    .cloned()
                    .unwrap_or(Value::Null);
            }
        }
        let warnings = if states["ok"] == true {
            Vec::new()
        } else {
            vec![review::warning_text(
                "files",
                states["error"].as_js_string().unwrap(),
            )]
        };
        checked(
            "githubPullRequestFilesSchema",
            &json!({"files":files,"filesTruncated":array(&values).len()>=100,"warnings":warnings}),
        )
    }
    async fn pull_commits(&self, command: &Value, scope: &Scope) -> Result<Value> {
        verify(command, scope).await?;
        let values = self
            .api(
                &format!("{}/commits", pull_path(command)?),
                &arguments(),
                scope,
            )
            .await?;
        if !values.is_array() {
            bail!("GitHub returned an invalid pull request commits response.");
        }
        checked(
            "githubPullRequestCommitsSchema",
            &json!({"commits":selection(&values,parse::commit)?,"commitsTruncated":array(&values).len()>=100,"warnings":Vec::<Value>::new()}),
        )
    }
    async fn pull_checks(&self, command: &Value, scope: &Scope) -> Result<Value> {
        verify(command, scope).await?;
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let pull = parse::summary(&self.api(&pull_path(command)?, &[], scope).await?)?;
        let runs_path = format!(
            "{repository}/commits/{}/check-runs",
            pull["headSha"].as_str().unwrap()
        );
        let status_path = format!(
            "{repository}/commits/{}/status",
            pull["headSha"].as_str().unwrap()
        );
        let args = arguments();
        let (runs, statuses) = tokio::join!(
            self.api(&runs_path, &args, scope),
            self.api(&status_path, &args, scope)
        );
        if let (Err(error), Err(_)) = (&runs, &statuses) {
            return Err(crate::error::WireError(api::prefix(
                "GitHub checks are unavailable: ",
                review::warning("checks", error)["message"]
                    .as_js_string()
                    .unwrap(),
            ))
            .into());
        }
        let mut warnings = Vec::new();
        for result in [&runs, &statuses] {
            if let Err(error) = result {
                warnings.push(review::warning("checks", error));
            }
        }
        let empty = json!({});
        let raw_runs = runs.as_ref().unwrap_or(&empty);
        let raw_statuses = statuses.as_ref().unwrap_or(&empty);
        api::member(raw_runs, "check_runs")?;
        let mut checks = selection(&raw_runs["check_runs"], parse::check_run)?;
        api::member(raw_statuses, "statuses")?;
        checks.extend(selection(&raw_statuses["statuses"], parse::status)?);
        let truncated = parse::numeric(raw_runs.get("total_count"))?
            > array(&raw_runs["check_runs"]).len().min(100) as f64
            || array(&raw_statuses["statuses"]).len() >= 100;
        checked(
            "githubPullRequestChecksSchema",
            &json!({"checksState":parse::checks_state(&checks),"checks":checks,"checksTruncated":truncated,"warnings":warnings}),
        )
    }
    async fn pull_all(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let mut result = self.pull_overview(command, scope).await?;
        let (files, commits, checks) = tokio::join!(
            self.pull_files(command, scope),
            self.pull_commits(command, scope),
            self.pull_checks(command, scope)
        );
        let mut warnings = array(&result["warnings"]).to_vec();
        for (section, value) in [
            ("files", &files),
            ("commits", &commits),
            ("checks", &checks),
        ] {
            if let Err(error) = value {
                warnings.push(review::warning(section, error));
            }
        }
        for (field, value) in [
            ("files", &files),
            ("commits", &commits),
            ("checks", &checks),
        ] {
            result[field] = value
                .as_ref()
                .map_or_else(|_| json!(Vec::<Value>::new()), |value| value[field].clone());
            result[&format!("{field}Truncated")] = value.as_ref().map_or(json!(true), |value| {
                value[&format!("{field}Truncated")].clone()
            });
        }
        result["checksState"] = checks
            .as_ref()
            .map_or(json!("unknown"), |value| value["checksState"].clone());
        for value in [&files, &commits, &checks].into_iter().flatten() {
            warnings.extend_from_slice(array(&value["warnings"]));
        }
        result["warnings"] = json!(warnings);
        checked("githubPullRequestDetailSchema", &result)
    }
}
