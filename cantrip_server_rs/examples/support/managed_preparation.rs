macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{cantrip_server::wire::Value::object([$(( $key,cantrip_server::wire::Value::from_serialize(&$value))),*])};
    ($value:expr)=>{cantrip_server::wire::Value::from_serialize(&$value)};
}
use anyhow::{Context, Result};
use cantrip_server::{chats::managed_preparation::Repository, database::Database, wire::Value};
use std::sync::Arc;
fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key].as_str().context("Preparation fixture identity")
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    if input["op"] == "preparation-run" {
        return runtime(database, input).await;
    }
    let jobs = Repository::new(database.clone());
    let (owner, chat) = (text(input, "owner")?, text(input, "chat")?);
    let result = match text(input, "op")? {
        "preparation-get" => jobs.get(owner, chat).await?,
        "preparation-request" => jobs.request(owner, chat, text(input, "worker")?).await?,
        "preparation-claim" => jobs.claim(owner, chat, text(input, "worker")?).await?,
        "preparation-update" => {
            jobs.update(
                owner,
                &input["state"],
                text(input, "phase")?,
                input["failedPhase"].as_str(),
                input["terminal"].as_str(),
            )
            .await?
        }
        "preparation-exit" => {
            jobs.console_exited(
                owner,
                text(input, "worker")?,
                text(input, "terminal")?,
                text(input, "generation")?,
            )
            .await?
        }
        "preparation-worker" => {
            return Ok(Value::Array(
                jobs.for_worker(owner, text(input, "worker")?)
                    .await?
                    .into_iter()
                    .map(|v| Value::String(v.into()))
                    .collect(),
            ));
        }
        "preparation-console" => {
            cantrip_server::terminals::Repository::new(database)
                .get_or_create_chat_console(owner, chat, &input["input"])
                .await?
        }
        _ => anyhow::bail!("Unknown preparation fixture operation"),
    };
    Ok(result.unwrap_or(Value::Null))
}

async fn runtime(database: Arc<Database>, input: &Value) -> Result<Value> {
    use cantrip_server::{
        chats::{
            managed_console::ManagedConsole,
            managed_preparation::{Request, Service},
            routing::ModelRouting,
        },
        workers::command_bus::RequestTimeout,
    };
    use futures::FutureExt;
    use std::sync::Mutex;
    use tokio::sync::{Notify, oneshot};
    let calls = Arc::new(Mutex::new(Vec::new()));
    let publications = Arc::new(Mutex::new(Vec::new()));
    let attachments = Arc::new(Mutex::new(std::collections::HashMap::<
        String,
        oneshot::Sender<()>,
    >::new()));
    let fail = Arc::new(Mutex::new(input["fail"].as_str().map(str::to_owned)));
    let (thread_gate, thread_seen, console_gate) = (
        Arc::new(Notify::new()),
        Arc::new(Notify::new()),
        Arc::new(Notify::new()),
    );
    let request: Request = {
        let (input, database, calls, attachments, fail, thread_gate, thread_seen, console_gate) = (
            input.clone(),
            database.clone(),
            calls.clone(),
            attachments.clone(),
            fail.clone(),
            thread_gate.clone(),
            thread_seen.clone(),
            console_gate.clone(),
        );
        Arc::new(move |_owner, worker, command, _timeout, event| {
            let (input, database, calls, attachments, fail, thread_gate, thread_seen, console_gate) = (
                input.clone(),
                database.clone(),
                calls.clone(),
                attachments.clone(),
                fail.clone(),
                thread_gate.clone(),
                thread_seen.clone(),
                console_gate.clone(),
            );
            async move {
                calls.lock().unwrap().push(json!({"worker":worker,"command":command}));
                let failure=fail.lock().unwrap().clone();
                match command["type"].as_str().unwrap_or_default(){
                    "chat.thread.ensure"=>{
                        thread_seen.notify_one();
                        if input["gate"]==true{thread_gate.notified().await;}
                        if let Some(sql)=input["ensureSql"].as_str(){database.execute(sql).await?;}
                        if failure.as_deref()==Some("thread"){anyhow::bail!("Controlled thread failure");}
                        Ok(Some(json!({"threadId":input.get("threadResult").or(command.get("threadId").filter(|v|!v.is_null())).cloned().unwrap_or_else(||json!("prepared-native-thread"))})))
                    }
                    "terminal.prepare-state"=>{
                        if failure.as_deref()==Some("state"){anyhow::bail!("Controlled state failure");}
                        let mut result=input["input"].clone();result["id"]=if input["changedIdentity"]==true{json!("88888888-8888-4888-8888-888888888888")}else{command["terminalId"].clone()};Ok(Some(result))
                    }
                    "terminal.open"=>{
                        if failure.as_deref()==Some("console"){anyhow::bail!("Controlled console failure");}
                        let (send,receive)=oneshot::channel();
                        attachments.lock().unwrap().insert(text(&command,"attachmentId")?.to_owned(),send);
                        if input["gate"]==true{console_gate.notified().await;}
                        if input["exitBeforeReady"]==true{return Ok(Some(json!({"status":"exited","exitCode":1,"signal":Value::Null})));}
                        if let Some(event)=event{event(json!({"type":"terminal.ready","terminalId":command["terminalId"]})).await?;}
                        if input["exitAfterReady"]==true{return Ok(Some(json!({"status":"exited","exitCode":1,"signal":Value::Null})));}
                        receive.await.context("Fixture console detach")?;Ok(Some(json!({"status":"detached"})))
                    }
                    "terminal.detach"=>{if let Some(send)=attachments.lock().unwrap().remove(text(&command,"attachmentId")?){let _=send.send(());}Ok(Some(json!({"status":"detached"})))},
                    _=>anyhow::bail!("Unexpected preparation worker command {}",command["type"].stringify())
                }
            }.boxed()
        })
    };
    let routing = ModelRouting::with_dependencies(
        database.clone(),
        Arc::new(|_| true),
        Arc::new(|_, _| async { Ok(false) }.boxed()),
        Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
    );
    let console = ManagedConsole::with_request(database.clone(), routing.clone(), {
        let request = request.clone();
        Arc::new(move |owner, worker, command| {
            request(owner, worker, command, RequestTimeout::Disabled, None)
        })
    });
    let service = Service::with_request(
        database.clone(),
        routing,
        console,
        request,
        {
            let publications = publications.clone();
            Arc::new(move |event| publications.lock().unwrap().push(event))
        },
        "preparation-server".into(),
    );
    let (owner, chat) = (text(input, "owner")?, text(input, "chat")?);
    let (mut join_error, mut joined_before, mut phase_before) =
        (Value::Null, Value::Null, Value::Null);
    service.request(owner, chat).await?;
    if input["gate"] == true {
        thread_seen.notified().await;
        service.request(owner, chat).await?;
        let mut joined = Box::pin(service.join(owner, chat));
        anyhow::ensure!(
            joined.as_mut().now_or_never().is_none(),
            "GUI join must await thread preparation"
        );
        thread_gate.notify_one();
        joined.await?;
        joined_before = json!(true);
        phase_before = service.repository.get(owner, chat).await?.unwrap()["phase"].clone();
        console_gate.notify_one();
    } else if let Err(error) = service.join(owner, chat).await {
        join_error = json!(error.to_string());
    }
    service.settle(owner, chat).await?;
    if input["retry"] == true {
        *fail.lock().unwrap() = None;
        service.request(owner, chat).await?;
        service.settle(owner, chat).await?;
    }
    if input["reconnect"] == true {
        service
            .worker_connected(
                owner,
                text(input, "worker")?,
                &std::collections::HashMap::new(),
            )
            .await?;
        service.settle(owner, chat).await?;
    }
    service.drained().await;
    let state = service.repository.get(owner, chat).await?;
    let terminal = if let Some(state) = &state {
        cantrip_server::terminals::Repository::new(database)
            .context(owner, text(state, "terminalId")?)
            .await?
    } else {
        None
    };
    Ok(
        json!({"state":state,"terminal":terminal,"calls":Value::Array(calls.lock().unwrap().clone()),"publications":Value::Array(publications.lock().unwrap().clone()),"joinError":join_error,"joinBeforeConsoleReady":joined_before,"phaseBeforeConsoleReady":phase_before}),
    )
}
