use anyhow::{Context, Result};
use cantrip_server::{chats::thread_sync::reconciliation::Reconciler, wire::Value};
use futures::FutureExt;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot};

// Construct each value directly so lone UTF-16 surrogates never pass through
// serde_json::Value's Unicode scalar strings.
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?}) => {
        Value::object([$(( $key, Value::from_serialize(&$value) )),*])
    };
}

#[derive(Default)]
struct Trace {
    accepted: Vec<Value>,
    calls: Vec<Value>,
    errors: Vec<Value>,
    started: usize,
    completed: usize,
}
async fn wait(trace: &Mutex<Trace>, changed: &Notify, field: &str, count: usize) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let notified = changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let value = trace.lock().unwrap();
                if (if field == "started" {
                    value.started
                } else {
                    value.completed
                }) >= count
                {
                    return;
                }
            }
            notified.await;
        }
    })
    .await
    .context("Thread callback did not reach its barrier")?;
    Ok(())
}
pub async fn run(input: &Value) -> Result<Value> {
    let trace = Arc::new(Mutex::new(Trace::default()));
    let changed = Arc::new(Notify::new());
    let mut senders = HashMap::new();
    let mut receivers = HashMap::new();
    if let Some(gates) = input["gates"].as_array() {
        for gate in gates {
            let (send, receive) = oneshot::channel();
            senders.insert(gate.stringify(), send);
            receivers.insert(gate.stringify(), receive);
        }
    }
    let receivers = Arc::new(Mutex::new(receivers));
    let failures = Arc::new(
        input["failures"]
            .as_array()
            .map(|values| values.iter().map(Value::stringify).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    let errors = trace.clone();
    let reconciler = Reconciler::new(
        Arc::new(move |error, key| {
            errors
                .lock()
                .unwrap()
                .errors
                .push(json!({"key":key,"message":error.to_string()}))
        }),
        input["limit"].as_u64().unwrap_or(4096) as usize,
    );
    let result:Result<()>=async{
  for action in input["actions"].as_array().context("Reconciler actions")?{
   match action["kind"].as_str(){
    Some("schedule")=>{
     let key=action["key"].as_js_string().context("Reconciler key")?.clone();
     let callback_key=key.clone();let(state,changed,receivers,failures)=(trace.clone(),changed.clone(),receivers.clone(),failures.clone());
     let accepted=reconciler.schedule(key,json!({"type":"chat.thread.changed","threadId":action["key"],"revision":action["revision"],"changes":action["changes"]}),Arc::new(move |observation|{
      let(state,changed,receivers,failures,key)=(state.clone(),changed.clone(),receivers.clone(),failures.clone(),callback_key.clone());
      async move{
       {let mut trace=state.lock().unwrap();trace.calls.push(json!({"key":key,"observation":observation}));trace.started+=1;}
       changed.notify_waiters();
       let id=Value::Array(vec![Value::String(key),observation["revision"].clone()]).stringify();
       let receiver=receivers.lock().unwrap().remove(&id);
       let outcome=if let Some(receiver)=receiver{receiver.await.context("Thread fixture gate was lost")}else{Ok(())};
       state.lock().unwrap().completed+=1;changed.notify_waiters();outcome?;
       anyhow::ensure!(!failures.contains(&id),"Controlled thread reconciliation failure.");Ok(())
      }.boxed()
     }));
     trace.lock().unwrap().accepted.push(json!({"key":action["key"],"revision":action["revision"],"accepted":accepted}));
    }
    Some("wait")=>wait(&trace,&changed,action["field"].as_str().context("Barrier field")?,action["count"].as_u64().context("Barrier count")?as usize).await?,
    Some("release")=>{let id=Value::Array(vec![action["key"].clone(),action["revision"].clone()]).stringify();senders.remove(&id).context("Thread fixture release")?.send(()).ok();}
    Some("clear")=>reconciler.clear(),
    Some("settle")=>{tokio::time::timeout(Duration::from_secs(15),reconciler.drained()).await.context("Thread callbacks did not settle")?;}
    _=>anyhow::bail!("Unknown thread reconciler fixture action"),
   }
  }Ok(())
 }.await;
    for (_, sender) in senders {
        sender.send(()).ok();
    }
    reconciler.clear();
    reconciler.drained().await;
    result?;
    let mut trace = trace.lock().unwrap();
    let order = |a: &Value, b: &Value| {
        a["key"]
            .as_js_string()
            .unwrap()
            .units()
            .cmp(b["key"].as_js_string().unwrap().units())
    };
    trace.calls.sort_by(order);
    trace.errors.sort_by(order);
    Ok(
        json!({"accepted":trace.accepted,"calls":trace.calls,"errors":trace.errors,"started":trace.started,"completed":trace.completed}),
    )
}
