use super::*;
use crate::http::{agent_alerts, agent_operations};
use anyhow::Context as _;
use axum::{http::StatusCode, routing::post};

pub(super) async fn execute_agent_operation(
    repository: &Repository,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    let agent = context["chatId"]
        .as_str()
        .context("Council history identity")?;
    let data = if operation == "council.history.read" {
        let input = agent_operations::parse("councilHistoryReadInputSchema", arguments)?;
        let target = input["messageId"]
            .as_str()
            .context("Council message identity")?;
        crate::settings::parse_response(
            "councilHistorySourceRangeSchema",
            Some(
                &repository
                    .council_history_range(owner, agent, target)
                    .await?,
            ),
        )?
    } else {
        let input = agent_operations::parse("councilHistorySourceRequestSchema", arguments)?;
        search_source(repository, owner, agent, &input).await?
    };
    Ok(json!({"summary":"Loaded protected Council history records.","data":data}))
}

async fn search_source(
    repository: &Repository,
    owner: &str,
    agent: &str,
    input: &Value,
) -> Result<Value> {
    let (schema, data) = match input["kind"].as_str() {
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
    };
    crate::settings::parse_response(schema, Some(&data))
}

async fn search_handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(agent): Path<String>,
    request: Request,
) -> Response {
    let result = async {
        let owner = &context.principal.user.as_ref().expect("Council owner").id;
        let repository = Repository::new(service.repository.database.clone());
        let Some(worker) = repository.council_history_worker(owner, &agent).await? else {
            return Ok(error(404, "Council agent not found."));
        };
        let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(raw) => raw,
            Err(response) => return Ok(response),
        };
        let mut command = match parse("councilHistorySearchExchangeSchema", raw.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        command["type"] = json!("council.history.search");
        command["agentId"] = json!(agent);
        let reply = match service
            .workers
            .commands
            .request(&worker, command.clone(), None, None)
            .await
        {
            Ok(Some(reply)) => reply,
            Ok(None) => return Ok(error(502, "The Council worker returned no search results.")),
            Err(cause) => return Ok(error(cause.status(502), cause.message())),
        };
        if reply["requestId"] != command["requestId"] {
            return Ok(error(
                502,
                "The Council worker returned an unrelated search result.",
            ));
        }
        output(200, "councilHistorySearchReplySchema", &reply)
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &context.id, &cause))
}

async fn range_handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path((agent, message)): Path<(String, String)>,
) -> Response {
    let result = async {
        let owner = &context.principal.user.as_ref().expect("Council owner").id;
        let repository = Repository::new(service.repository.database.clone());
        if repository
            .council_history_worker(owner, &agent)
            .await?
            .is_none()
        {
            return Ok(error(404, "Council agent not found."));
        }
        output(
            200,
            "councilHistorySourceRangeSchema",
            &repository
                .council_history_range(owner, &agent, &message)
                .await?,
        )
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &context.id, &cause))
}

async fn source_handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let authorization = middleware::value(request.headers(), "authorization");
    let result = async {
        let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(raw) => raw,
            Err(response) => return Ok(response),
        };
        let input = match parse("councilHistoryWorkerSourceSchema", raw.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let worker = input["workerId"]
            .as_str()
            .context("Council history worker")?;
        let agent = input["agentId"].as_str().context("Council history agent")?;
        let Some(owner) =
            agent_alerts::authenticate(&service, worker, authorization.as_deref()).await?
        else {
            return Ok(error(401, "Unauthorized"));
        };
        let repository = Repository::new(service.repository.database.clone());
        if repository
            .council_history_worker(&owner, agent)
            .await?
            .as_deref()
            != Some(worker)
        {
            return Ok(error(404, "Council agent not found on this worker."));
        }
        let data = search_source(&repository, &owner, agent, &input["source"]).await?;
        Ok(super::super::json_response(StatusCode::OK, data))
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &context.id, &cause))
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/council/agents/{agentId}/history/search",
            post(search_handle),
        )
        .route(
            "/api/council/agents/{agentId}/history/{messageId}",
            get(range_handle),
        )
        .route("/api/internal/council-history/source", post(source_handle))
}
