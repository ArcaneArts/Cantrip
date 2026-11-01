//! Account preparation uses the actual handoff service with a controlled worker.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{Repository, account_failover::Service},
    database::Database,
    native_commands::CommandError,
    operations::shared_failure,
    wire::Value,
};
use futures::FutureExt;
use std::{sync::Arc, time::Duration};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
fn outcome(result: Result<Value>) -> Result<Value> {
    match result {
        Ok(value) => Ok(json!({"value":value})),
        Err(error) => {
            let error = error.context("Account preparation fixture caller");
            if let Some(command) = shared_failure::downcast_ref::<CommandError>(&error) {
                Ok(
                    json!({"error":json!({"kind":"native-command","code":command.code,"message":command.message,"status":command.status})}),
                )
            } else {
                Err(error)
            }
        }
    }
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let owner = input["owner"]
        .as_str()
        .context("Account preparation owner")?;
    let chat = input["chat"].as_str().unwrap_or("chat");
    let original = if let Some(original) = input.get("original") {
        original.clone()
    } else {
        Repository::new(database.clone())
            .execution_context(owner, chat)
            .await?
            .context("Account preparation original context")?
    };
    let gate = (input["concurrent"] == true)
        .then(|| Arc::new(super::native_handoff_service::Gate::default()));
    let fixture =
        super::native_handoff_service::fixture(database.clone(), input, owner, gate.clone());
    let service = Service::new(database.clone(), fixture.service.clone());
    let first = if input["queued"] == true {
        (service.queued_preparation())(owner.to_owned(), original.clone())
    } else {
        service.prepare(owner, &original, input.get("expected"))
    };
    let mut results = Vec::new();
    let mut pending_while_held = false;
    if let Some(gate) = &gate {
        tokio::time::timeout(Duration::from_secs(10), gate.reached.notified())
            .await
            .context("Actual account handoff did not reach the controlled worker")?;
        let second =
            (input["dropAll"] != true).then(|| service.prepare(owner, &original, Some(&json!(-1))));
        pending_while_held = service.drained().now_or_never().is_none();
        anyhow::ensure!(
            pending_while_held,
            "Account ownership drained before its real worker completed"
        );
        gate.release.notify_one();
        if input["dropAll"] == true {
            drop(first);
            service.drained().await;
            results.push(outcome(
                Repository::new(database)
                    .execution_context(owner, chat)
                    .await?
                    .context("Transferred account context after all waiters left"),
            )?);
        } else if input["dropFirst"] == true {
            drop(first);
            results.push(outcome(second.expect("Joining caller").await)?);
        } else {
            for result in futures::future::join_all([first, second.expect("Joining caller")]).await
            {
                results.push(outcome(result)?);
            }
        }
    } else {
        results.push(outcome(first.await)?);
    }
    if input["again"] == true {
        results.push(outcome(
            service
                .prepare(owner, &original, input.get("expected"))
                .await,
        )?);
    }
    service.drained().await;
    fixture.service.drained().await;
    fixture.commands.drained().await;
    Ok(
        json!({"results":Value::Array(results),"pendingWhileHeld":pending_while_held,"events":Value::Array(fixture.events.lock().unwrap().clone()),"commands":Value::Array(fixture.worker.commands.lock().unwrap().clone()),"configurations":Value::Array(fixture.worker.configurations.lock().unwrap().clone())}),
    )
}
