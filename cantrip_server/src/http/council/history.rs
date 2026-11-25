use super::*;
use crate::http::agent_operations;

pub(super) async fn execute_agent_operation(
    repository: &Repository,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    use anyhow::Context as _;
    let agent = context["chatId"]
        .as_str()
        .context("Council history identity")?;
    let (schema, data) = if operation == "council.history.read" {
        let input = agent_operations::parse("councilHistoryReadInputSchema", arguments)?;
        let target = input["messageId"]
            .as_str()
            .context("Council message identity")?;
        (
            "councilHistorySourceRangeSchema",
            repository
                .council_history_range(owner, agent, target)
                .await?,
        )
    } else {
        let input = agent_operations::parse("councilHistorySourceRequestSchema", arguments)?;
        match input["kind"].as_str() {
            Some("head") => (
                "councilHistoryHeadSchema",
                repository.council_history_head(owner, agent).await?,
            ),
            Some("page") => {
                let after = input["afterSequence"]
                    .as_i64()
                    .context("Council history page cursor")?;
                let through = input["throughSequence"]
                    .as_i64()
                    .context("Council history page end")?;
                (
                    "councilHistorySourcePageSchema",
                    repository
                        .council_history_page(owner, agent, after, through)
                        .await?,
                )
            }
            _ => {
                let after = (
                    input["afterRevision"]
                        .as_i64()
                        .context("Council history revision cursor")?,
                    input["afterSequence"]
                        .as_i64()
                        .context("Council history change cursor")?,
                );
                let through = input["throughRevision"]
                    .as_i64()
                    .context("Council history change end")?;
                (
                    "councilHistorySourceChangesSchema",
                    repository
                        .council_history_changes(owner, agent, after, through)
                        .await?,
                )
            }
        }
    };
    let data = crate::settings::parse_response(schema, Some(&data))?;
    Ok(json!({"summary":"Loaded protected Council history records.","data":data}))
}
