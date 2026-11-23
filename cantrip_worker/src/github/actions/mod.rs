mod checkout;
mod commands;
mod parse;
use super::{Client, api, common::*};
use crate::filesystem::Scope;
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
fn page_args(limit: &Value, page: Option<&Value>) -> Result<Vec<cantrip_wire::JsString>> {
    let mut result = vec![
        "--method".into(),
        "GET".into(),
        "-f".into(),
        api::prefix("per_page=", &api::text(Some(limit))?),
    ];
    if let Some(page) = page {
        result.extend(["-f".into(), api::prefix("page=", &api::text(Some(page))?)]);
    }
    Ok(result)
}
impl Client {
    pub(super) async fn actions_overview(&self, command: &Value, scope: &Scope) -> Result<Value> {
        verify(command, scope).await?;
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let left_scope = scope.clone();
        let right_scope = scope.clone();
        let left_path = format!("{repository}/actions/workflows");
        let right_path = format!("{repository}/actions/runs");
        let args = page_args(&command["limit"], Some(&command["page"]))?;
        let (workflows, runs) = self
            .join_reads(
                async move {
                    api::request(&left_path, &page_args(&json!(100), None)?, &left_scope).await
                },
                async move { api::request(&right_path, &args, &right_scope).await },
            )
            .await?;
        let mut warnings = Vec::new();
        let mut access = "available";
        let runners = async {
            let raw = self
                .api(
                    &format!("{repository}/actions/runners"),
                    &page_args(&json!(100), None)?,
                    scope,
                )
                .await?;
            api::member(&raw, "runners")?;
            let runners = array(&raw["runners"]).to_vec();
            let count = api::number(&raw, "total_count")?.as_f64().unwrap();
            Ok::<_, anyhow::Error>((runners, count))
        }
        .await;
        let runners = match runners {
            Ok((runners, count)) => {
                if count > runners.len() as f64 {
                    warnings.push(json!(
                        "Only the first 100 repository self-hosted runners are shown."
                    ));
                }
                runners
            }
            Err(_) => {
                access = "unavailable";
                warnings.push(json!(
                    "GitHub requires repository administration access to list self-hosted runners."
                ));
                Vec::new()
            }
        };
        api::member(&workflows, "workflows")?;
        api::member(&runs, "workflow_runs")?;
        let workflow_values = array(&workflows["workflows"]);
        let run_values = array(&runs["workflow_runs"]);
        let total = fallback_number(&runs, "total_count", run_values.len() as f64)?;
        let page = command["page"].as_f64().unwrap();
        let limit = command["limit"].as_f64().unwrap();
        // Source parses workflows/runs/runners before validating the aggregate.
        let workflow_values = workflow_values
            .iter()
            .take(100)
            .map(parse::workflow)
            .collect::<Result<Vec<_>>>()?;
        let workflows_truncated = api::number(&workflows, "total_count")?.as_f64().unwrap() > 100.0
            || array(&workflows["workflows"]).len() > 100;
        let runs_parsed = run_values
            .iter()
            .take(limit as usize)
            .map(parse::run)
            .collect::<Result<Vec<_>>>()?;
        let runners = runners
            .iter()
            .take(100)
            .map(parse::runner)
            .collect::<Result<Vec<_>>>()?;
        checked(
            "githubActionsOverviewSchema",
            &object([
                ("workflows", json!(workflow_values)),
                ("workflowsTruncated", json!(workflows_truncated)),
                ("runs", json!(runs_parsed)),
                ("totalRunCount", total.clone()),
                (
                    "nextPage",
                    if page * limit < total.as_f64().unwrap() {
                        json!(page + 1.0)
                    } else {
                        Value::Null
                    },
                ),
                ("runners", json!(runners)),
                ("runnerAccess", json!(access)),
                ("warnings", json!(warnings)),
            ]),
        )
    }
    pub(super) async fn actions_run(&self, command: &Value, scope: &Scope) -> Result<Value> {
        verify(command, scope).await?;
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let id = api::text(Some(&command["runId"]))?;
        let path = format!("{repository}/actions/runs/{}", id.lossy());
        let raw = self.api(&path, &[], scope).await?;
        let args = page_args(&json!(100), None)?;
        let jobs_path = format!("{path}/jobs");
        let artifacts_path = format!("{path}/artifacts");
        let (jobs, artifacts) = tokio::join!(
            self.api(&jobs_path, &args, scope),
            self.api(&artifacts_path, &args, scope)
        );
        let mut warnings = Vec::new();
        // Fulfilled null responses throw before rejected-endpoint warnings.
        if let Ok(value) = &jobs {
            api::member(value, "jobs")?;
        }
        if let Ok(value) = &artifacts {
            api::member(value, "artifacts")?;
        }
        for (prefix, result) in [
            ("Jobs could not be loaded: ", &jobs),
            ("Artifacts could not be loaded: ", &artifacts),
        ] {
            if let Err(error) = result {
                warnings.push(crop(
                    &api::prefix(prefix, &crate::error::message(error)),
                    2000,
                ));
            }
        }
        let empty = json!({});
        let job_values = jobs.as_ref().unwrap_or(&empty);
        let artifact_values = artifacts.as_ref().unwrap_or(&empty);
        let run = parse::run(&raw)?;
        let jobs_parsed = array(&job_values["jobs"])
            .iter()
            .take(100)
            .map(parse::job)
            .collect::<Result<Vec<_>>>()?;
        let jobs_truncated = jobs.is_ok()
            && (api::number(job_values, "total_count")?.as_f64().unwrap() > 100.0
                || array(&job_values["jobs"]).len() > 100);
        let artifacts_parsed = array(&artifact_values["artifacts"])
            .iter()
            .take(100)
            .map(|value| {
                parse::artifact(value, command["repository"].as_str().unwrap(), &id.lossy())
            })
            .collect::<Result<Vec<_>>>()?;
        let artifacts_truncated = artifacts.is_ok()
            && (api::number(artifact_values, "total_count")?
                .as_f64()
                .unwrap()
                > 100.0
                || array(&artifact_values["artifacts"]).len() > 100);
        checked(
            "githubActionsRunDetailSchema",
            &json!({"run":run,"jobs":jobs_parsed,"jobsTruncated":jobs_truncated,"artifacts":artifacts_parsed,"artifactsTruncated":artifacts_truncated,"warnings":warnings}),
        )
    }
}
