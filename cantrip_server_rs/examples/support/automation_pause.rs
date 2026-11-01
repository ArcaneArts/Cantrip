//! Controlled boundary receipts use actual native admission/dispatch/settlement.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository,
        automation_pause::{PauseError, Service},
    },
    database::Database,
    native_commands,
    wire::{JsString, Value},
};
use std::sync::{Arc, Mutex};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
#[derive(Debug)]
pub struct PeerMessage(pub JsString);
impl std::fmt::Display for PeerMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.lossy())
    }
}
impl std::error::Error for PeerMessage {}
pub struct Peer {
    pub index: usize,
    pub trace: Arc<Mutex<Vec<Value>>>,
    pub gate: Arc<super::turn_execution::WorkerGate>,
}
fn text(v: &Value) -> Result<&str> {
    v.as_str().context("Pause fixture identifier")
}
pub async fn reply(
    database: Arc<Database>,
    input: &Value,
    owner: &str,
    worker: &str,
    command: &Value,
    peer: Peer,
) -> Result<Value> {
    let paused = command["control"]
        .get("paused")
        .unwrap_or(&command["paused"]);
    let context = Repository::new(database.clone())
        .execution_context(owner, text(&command["chatId"])?)
        .await?
        .unwrap_or(Value::Null);
    peer.trace.lock().unwrap().push(json!({"kind":"pause-boundary","chat":command["chatId"],"paused":context["automationPaused"]}));
    let chat_key = text(&command["chatId"])?;
    let at = |key: &str| {
        input["pauseByChat"][chat_key]
            .get(key)
            .or_else(|| input[key].as_array().and_then(|a| a.get(peer.index)))
    };
    if let Some(message) = at("pauseErrors").and_then(Value::as_js_string) {
        return Err(PeerMessage(message.clone()).into());
    }
    let repository = native_commands::Repository::new(database.clone());
    let admission = if command["type"] == "chat.native-control" {
        let request = json!({"workerId":worker,"operationId":format!("{}:{}",input["pausePrefix"].as_str().unwrap_or("fixture-pause"),peer.index),"origin":"gui","method":"turn/pause","session":json!({"chatId":context["chatId"],"threadId":context["threadId"],"contextKind":context["contextKind"],"projectId":context["projectId"],"placementId":context.get("worktreeId").filter(|v|!v.is_null()).unwrap_or(&context["scratchRootId"]),"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"runtimeGeneration":command["nativeRuntimeGeneration"],"connectionId":"pause-connection"}),"payloadDigest":"d".repeat(64),"protectedPayload":input["pauseProtectedPayload"],"expectedActivationGeneration":command["nativeActivationGeneration"],"intent":json!({"scope":"thread","settingKeys":Vec::<Value>::new(),"expectedTurnId":Value::Null,"paused":paused,"resumeAutonomy":paused!=&json!(true)})});
        let grant = repository
            .admit(owner, &request, &Value::object([] as [(&str, Value); 0]))
            .await?;
        anyhow::ensure!(
            grant["receipt"]["status"] == "accepted",
            "Fixture native pause admission rejected: {}",
            grant["receipt"]["rejectionCode"].as_str().unwrap_or("null")
        );
        repository.dispatch(owner,&json!({"workerId":worker,"operationId":request["operationId"],"operationGeneration":grant["receipt"]["operationGeneration"],"payloadDigest":request["payloadDigest"],"session":request["session"]})).await?;
        peer.trace.lock().unwrap().push(
            json!({"kind":"native-pause-dispatched","chat":command["chatId"],"paused":paused}),
        );
        Some((request, grant))
    } else {
        None
    };
    if let Some(statements) = at("pauseBeforeReplySQL") {
        for sql in statements
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_else(|| std::slice::from_ref(statements))
        {
            database.query(text(sql)?, &[]).await?;
        }
    }
    if (input["holdPauseFirst"] == true && peer.index == 0)
        || input["holdPauseChats"]
            .as_array()
            .is_some_and(|chats| chats.contains(&command["chatId"]))
    {
        peer.gate.wait().await;
    }
    if let Some(message) = at("pauseErrorsAfterDispatch").and_then(Value::as_js_string) {
        return Err(PeerMessage(message.clone()).into());
    }
    if let Some((request, grant)) = admission {
        repository.settle(owner,&json!({"workerId":worker,"operationId":request["operationId"],"operationGeneration":grant["receipt"]["operationGeneration"],"status":"applied","resultDigest":Value::Null,"protectedResult":Value::Null,"rejectionCode":Value::Null,"executionComplete":false})).await?;
    }
    Ok(at("pauseReplies")
        .cloned()
        .unwrap_or_else(|| json!({"paused":paused,"active":Value::Null})))
}
pub async fn run(
    service: Arc<Service>,
    input: &Value,
    trace: Arc<Mutex<Vec<Value>>>,
    gate: Arc<super::turn_execution::WorkerGate>,
) -> Result<Value> {
    let owner = text(&input["owner"])?;
    let chat = text(&input["chat"])?;
    let paused = input["paused"] == true;
    let resume = input["resumeAutomation"] != false;
    let result: Result<Value> = async {
        let older = service.set(owner, chat, paused, resume);
        if input["detached"] == true {
            drop(older);
            return Ok(Value::Null);
        }
        if input["overlap"] != true {
            return older.await;
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if trace
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["kind"] == "native-pause-dispatched")
            {
                break;
            }
            anyhow::ensure!(
                tokio::time::Instant::now() < deadline,
                "Native pause dispatch observation timed out"
            );
            tokio::task::yield_now().await;
        }
        let newer = service.set(owner, chat, !paused, resume).await?;
        gate.release();
        Ok(json!({"older":older.await?,"newer":newer}))
    }
    .await;
    gate.release();
    service.drained().await;
    let mut output = json!({"result":result.as_ref().ok().cloned().unwrap_or(Value::Null)});
    if let Err(error) = result {
        let mut details = json!({"message":error.to_string()});
        if let Some(error) = error.downcast_ref::<PauseError>() {
            details["message"] = Value::String(error.message.clone());
            details["statusCode"] = json!(error.status_code);
        }
        output["error"] = details;
    }
    Ok(output)
}
