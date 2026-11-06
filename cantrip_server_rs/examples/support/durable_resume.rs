//! Controlled boundary uses actual fresh observer admission and epoch-fenced Resume.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::Repository as Chats, database::Database, native_commands::Repository, wire::Value,
};
use std::sync::Arc;
macro_rules! json {
    ({})=>{Value::object([] as [(&str, Value); 0])};
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
pub async fn reply(
    database: Arc<Database>,
    input: &Value,
    owner: &str,
    worker: &str,
    command: &Value,
) -> Result<Value> {
    if input["coldResumeError"].as_str().is_some() {
        anyhow::bail!("Controlled saved-source failure");
    }
    let state = Chats::new(database.clone())
        .native_suspension(owner, command["chatId"].as_str().context("Saved chat")?)
        .await?
        .context("Saved suspension")?;
    if input["coldResumeNoAck"] == true {
        return Ok(json!({"paused":false,"active":state["active"]}));
    }
    let native = Repository::new(database);
    let session = json!({"chatId":command["chatId"],"threadId":command["threadId"],"contextKind":command["session"]["contextKind"],"projectId":command["session"]["projectId"],"placementId":if command["session"]["worktreeId"].is_null(){&command["session"]["scratchRootId"]}else{&command["session"]["worktreeId"]},"modelRouteId":command["model"]["routeId"],"providerAccountId":command["provider"].get("accountId").unwrap_or(&Value::Null),"runtimeGeneration":"replacement-runtime","connectionId":"replacement-connection"});
    let prefix = input["pausePrefix"].as_str().context("Control prefix")?;
    let request = json!({"workerId":worker,"workerGeneration":"809cc8d8-4f56-4f61-ae0c-d21b621891c2","operationId":format!("{prefix}-observer"),"controlId":command["controlId"],"checkpoint":command["checkpoint"],"session":session,"payloadDigest":"a".repeat(64),"protectedPayload":input["pauseProtectedPayload"]});
    let grant = native.admit_suspended_execution(owner, &request).await?;
    async fn apply(
        native: &Repository,
        owner: &str,
        worker: &str,
        receipt: &Value,
        session: &Value,
        state: &Value,
        input: &Value,
    ) -> Result<()> {
        native.dispatch(owner, &json!({"workerId":worker,"workerGeneration":"809cc8d8-4f56-4f61-ae0c-d21b621891c2","operationId":receipt["operationId"],"operationGeneration":receipt["operationGeneration"],"payloadDigest":receipt["payloadDigest"],"session":session})).await?;
        let mut ack = json!({"workerId":worker,"workerGeneration":"809cc8d8-4f56-4f61-ae0c-d21b621891c2","operationId":receipt["operationId"],"operationGeneration":receipt["operationGeneration"],"status":"applied","resultDigest":"b".repeat(64),"protectedResult":input["pauseProtectedPayload"],"rejectionCode":Value::Null,"executionComplete":false});
        if receipt["method"] == "turn/pause" {
            ack["durableSuspension"] = json!(true);
        } else {
            ack["reconciliation"] = json!({"nativeTurnId":state["active"]["turnId"],"runtimeGeneration":session["runtimeGeneration"]});
        }
        native.settle(owner, &ack).await?;
        Ok(())
    }
    apply(
        &native,
        owner,
        worker,
        &grant["receipt"],
        &session,
        &state,
        input,
    )
    .await?;
    let resume = json!({"workerId":worker,"operationId":format!("{prefix}-resume"),"origin":"gui","method":"turn/pause","session":session,"payloadDigest":"c".repeat(64),"protectedPayload":input["pauseProtectedPayload"],"expectedActivationGeneration":grant["receipt"]["activationGeneration"],"intent":json!({"scope":"thread","durableSuspension":true,"workerGeneration":"809cc8d8-4f56-4f61-ae0c-d21b621891c2","expectedTurnId":state["active"]["turnId"],"expectedSuspensionControlId":command["controlId"],"paused":false,"resumeAutonomy":true})});
    let resumed = native.admit(owner, &resume, &json!({})).await?;
    anyhow::ensure!(
        resumed["receipt"]["status"] == "accepted",
        "Resume admission rejected"
    );
    apply(
        &native,
        owner,
        worker,
        &resumed["receipt"],
        &session,
        &state,
        input,
    )
    .await?;
    Ok(json!({"paused":false,"active":state["active"]}))
}
