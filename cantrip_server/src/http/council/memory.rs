use super::*;
use crate::http::agent_operations::{self, OperationError};

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
        .context("Council memory identity")?;
    let mut result = match operation {
        "council.memory.read" => {
            let memory = repository
                .council_memory(owner, agent)
                .await
                .map_err(tool_error)?;
            json!({"summary":"Loaded your Council memory.","data":memory})
        }
        "council.memory.write" => {
            let input = agent_operations::parse("councilMemoryUpdateSchema", arguments)?;
            let memory = repository
                .update_council_memory(owner, agent, input)
                .await
                .map_err(tool_error)?;
            json!({"summary":"Updated your Council memory.","mutated":true,"data":memory})
        }
        _ => return Err(OperationError::new(400, "invalid", "Unknown Council operation.").into()),
    };
    result["data"] =
        crate::settings::parse_response("councilMemoryWireSchema", result.get("data"))?;
    Ok(result)
}

fn tool_error(error: anyhow::Error) -> anyhow::Error {
    match error.downcast_ref::<council::RosterError>() {
        Some(council::RosterError::NotFound) => {
            OperationError::new(404, "not-found", error.to_string()).into()
        }
        Some(council::RosterError::Conflict) => OperationError::new(
            409,
            "conflict",
            "Council memory changed. Read the current memory before writing again.",
        )
        .into(),
        _ => error,
    }
}

pub(super) async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(agent): Path<String>,
    request: Request,
) -> Response {
    let result = request_memory(&service, &context, &agent, request).await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &context.id, &cause))
}

async fn request_memory(
    service: &AuthService,
    context: &Context,
    agent: &str,
    request: Request,
) -> Result<Response> {
    let owner = &context.principal.user.as_ref().expect("Council owner").id;
    let repository = Repository::new(service.repository.database.clone());
    let result = if *request.method() == Method::PUT {
        let input = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let input = match parse("councilMemoryUpdateSchema", input.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        repository.update_council_memory(owner, agent, input).await
    } else {
        repository.council_memory(owner, agent).await
    };
    match result {
        Ok(memory) => output(200, "councilMemoryWireSchema", &memory),
        Err(cause) => match cause.downcast_ref::<council::RosterError>() {
            Some(council::RosterError::NotFound) => Ok(error(404, cause.to_string())),
            Some(council::RosterError::Conflict) => Ok(error(
                409,
                "Council memory changed. Reopen it to read the current version.",
            )),
            _ => Err(cause),
        },
    }
}
