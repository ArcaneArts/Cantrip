use super::*;
use crate::{
    computer_use::{Activity, publications::Scope},
    workers::command_bus::RequestTimeout,
};
use std::sync::Mutex;

#[derive(Default)]
struct State {
    accepting: bool,
    chunks: Vec<Value>,
    approval: Option<String>,
    terminal: bool,
}
struct Accumulator(Arc<Mutex<State>>);
impl Drop for Accumulator {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.accepting = false;
        state.chunks.clear();
    }
}
pub(super) async fn run(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
    input: Option<Value>,
) -> Result<Response> {
    let input = match wire::parse("computerUseRequestSchema", input.as_ref()) {
        Ok(value) => value,
        Err(_) => return Ok(error(400, "Invalid computer-use request.")),
    };
    if input.get("previewLeaseId").is_none() {
        return Ok(error(400, "A computer-use preview lease is required."));
    }
    let context = match Repository::new(service.repository.database.clone())
        .execution_context(owner, chat)
        .await
    {
        Ok(Some(context)) => context,
        Ok(None) => return Ok(error(404, "Chat not found.")),
        Err(_) => return Ok(error(503, "Chat context is unavailable.")),
    };
    if context["computerUseEnabled"] != true && input["operation"] != "session.close" {
        return Ok(error(403, "Computer use is not enabled."));
    }
    let authority = match computer_use_authority::preview(owner, &service.server_id, &context) {
        Ok(value) => value,
        Err(_) => return Ok(error(403, "Computer use is not authorized.")),
    };
    let state = Arc::new(Mutex::new(State {
        accepting: true,
        ..Default::default()
    }));
    let _accumulator = Accumulator(state.clone());
    let scope: Scope = (
        owner.into(),
        text(&context["workerId"])?.into(),
        text(&context["chatId"])?.into(),
    );
    let activity = Arc::new(Activity::new(
        service.computer_use.clone(),
        owner.into(),
        scope.2.clone(),
        text(&input["operationId"])?.into(),
        Some(if context["experience"] == "task" {
            "task"
        } else {
            "chat"
        }),
    ));
    let result: Result<Response> = async {
        service.computer_use.subscribe(&scope.1);
        let _command = service.computer_use.publications.begin(scope.clone())?;
        let (retained, collected, bound, request) = (service.clone(), state.clone(), context.clone(), input.clone());
        let event: EventHandler = Arc::new(move |event| {
            let (service, state, context, input, activity, scope) = (retained.clone(), collected.clone(), bound.clone(), request.clone(), activity.clone(), scope.clone());
            async move { async move {
                if !state.lock().unwrap().accepting { return Ok(()); }
                if event["type"] == "computer-use.activity" { return activity.publish(&event).await; }
                if event["type"] == "computer-use.approval.request" {
                    let approval = crate::settings::parse_response("cuaApprovalRequestEventSchema", Some(&event))?;
                    let p = &approval["request"]["provenance"];
                    {
                        let mut state = state.lock().unwrap();
                        ensure!(state.approval.is_none() && state.chunks.is_empty()
                            && approval["operationId"] == input["operationId"]
                            && p["owner"] == "computer-use" && p["chatId"] == context["chatId"]
                            && p["workerId"] == context["workerId"] && approval["request"]["projectId"] == context["projectId"]
                            && ["threadId", "turnId", "itemId", "executionLaneId"].iter().all(|key| p[*key] == Value::Null)
                            && input["operation"] != "session.close", "Invalid computer-use approval request.");
                        state.approval = Some(text(&approval["request"]["requestKey"])?.into());
                    }
                    service.computer_use.publish_approval(scope, approval["request"].clone())?.await?;
                    return Ok(());
                }
                if event["type"] == "computer-use.approval.terminal" {
                    let terminal = crate::settings::parse_response("cuaApprovalTerminalSchema", Some(&event))?;
                    {
                        let mut state = state.lock().unwrap();
                        ensure!(!state.terminal && terminal["chatId"] == context["chatId"] && terminal["requestKey"].as_str() == state.approval.as_deref(), "Invalid computer-use approval terminal event.");
                        state.terminal = true;
                    }
                    service.chat_mutations.terminalize_interaction(&scope.0, text(&terminal["requestKey"])?, &scope.2, &scope.1, text(&terminal["status"])?, None).await?;
                    return Ok(());
                }
                let chunk = crate::settings::parse_response("computerUseChunkEventSchema", Some(&event))?;
                let mut state = state.lock().unwrap();
                ensure!(state.approval.is_none() && matches!(input["operation"].as_str(), Some("observation.snapshot" | "agent.observation.get"))
                    && chunk["operationId"] == input["operationId"] && chunk["sequence"].as_u64() == Some(state.chunks.len() as u64)
                    && state.chunks.len() < 64, "Invalid computer-use snapshot response.");
                state.chunks.push(chunk);
                Ok(())
            }.await.map_err(|cause: anyhow::Error| crate::workers::bridge::CommandError { message: cause.to_string().into(), code: None, unavailable: false, request_id: None, encoding_error: None, inference: None }) }.boxed()
        });
        let raw = service.workers.commands.request_with_timeout(text(&context["workerId"])?, json!({"type":"computer-use.operation","serverId":service.server_id,"chatId":context["chatId"],"executionLaneId":Value::Null,"request":input,"preview":json!({"leaseId":input["previewLeaseId"],"authority":authority})}), if input["operation"] == "input.perform" { RequestTimeout::Disabled } else { RequestTimeout::After(Duration::from_secs(30)) }, Some(event)).await?;
        state.lock().unwrap().accepting = false;
        let response = crate::settings::parse_response("computerUseResponseSchema", raw.as_ref())?;
        ensure!(response["operationId"] == input["operationId"], "Invalid computer-use response.");
        let value = json!({"response":response,"chunks":state.lock().unwrap().chunks.clone()});
        let value = crate::settings::parse_response("computerUseHttpResultSchema", Some(&value))?;
        Ok(super::super::json_response(StatusCode::OK, value))
    }.await;
    Ok(result.unwrap_or_else(|_| error(502, "Computer-use request failed.")))
}
