use super::*;

// Construct the Run-specific future only for Run requests. Otherwise even SQL
// fixture setup inherits its largest branch in the shared dispatch frame.
pub fn run<'a>(
    database: &'a Arc<Database>,
    request: &'a Value,
) -> futures::future::BoxFuture<'a, Result<Value>> {
    Box::pin(async move {
        let repo = cantrip_server::run_configurations::Repository::new(database.clone());
        let owner = request["owner"].as_str().context("Runtime owner")?;
        let project = request["project"].as_str().context("Runtime project")?;
        match request["op"].as_str() {
            Some("run-runtime-observation-race") => {
                let inputs = request["inputs"]
                    .as_array()
                    .context("Runtime observations")?;
                let worker = request["worker"].as_str().context("Runtime worker")?;
                let values = futures::future::try_join_all(
                    inputs
                        .iter()
                        .map(|input| repo.observe(owner, worker, input)),
                )
                .boxed()
                .await?;
                Ok(Value::Array(
                    values
                        .into_iter()
                        .map(|value| value.unwrap_or(Value::Null))
                        .collect(),
                ))
            }
            Some("run-runtime-race") => {
                let inputs = request["inputs"].as_array().context("Runtime inputs")?;
                Ok(Value::Array(
                    futures::future::try_join_all(
                        inputs
                            .iter()
                            .map(|input| repo.request_operation(owner, input)),
                    )
                    .boxed()
                    .await?,
                ))
            }
            Some("run-runtime-request") => {
                repo.request_operation(owner, &request["input"])
                    .boxed()
                    .await
            }
            Some("run-runtime-get") => Ok(repo
                .get(
                    owner,
                    project,
                    request["configuration"]
                        .as_str()
                        .context("Runtime configuration")?,
                    request["worktree"].as_str().context("Runtime worktree")?,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null)),
            Some("run-runtime-list") => Ok(Value::Array(
                repo.list(
                    owner,
                    project,
                    request["configuration"].as_str(),
                    request["worktree"].as_str(),
                    request["limit"].as_f64().unwrap_or(256.0) as i64,
                )
                .boxed()
                .await?,
            )),
            Some("run-runtime-identities") => Ok(Value::Array(
                repo.active_identities(
                    owner,
                    request["worker"].as_str().context("Runtime worker")?,
                )
                .boxed()
                .await?,
            )),
            Some("run-runtime-observe") => Ok(repo
                .observe(
                    owner,
                    request["worker"].as_str().context("Runtime worker")?,
                    &request["observation"],
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null)),
            Some("run-runtime-delete") => {
                let ids = request["ids"]
                    .as_array()
                    .context("Runtime ids")?
                    .iter()
                    .map(|id| id.as_str().map(str::to_owned).context("Runtime id"))
                    .collect::<Result<Vec<_>>>()?;
                Ok(Value::Number(
                    repo.delete(owner, project, &ids).boxed().await? as f64,
                ))
            }
            _ => anyhow::bail!("Unknown runtime operation"),
        }
    })
}
