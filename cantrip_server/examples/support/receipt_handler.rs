use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    native_commands::{
        CommandError, Repository,
        runtime::{receipt_service::ReceiptService, receipts::ReceiptNotifications},
    },
    wire::{self, Value},
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let trace = Arc::new(Mutex::new(Vec::new()));
    let input = match wire::parse("nativeCommandSettlementSchema", request.get("input")) {
        Ok(input) => input,
        Err(_) => {
            return Ok(
                json!({"status":400,"body":json!({"code":"invalid-native-command"}),"trace":Value::Array(vec![])}),
            );
        }
    };
    let owner = request["owner"].as_str().context("Receipt fixture owner")?;
    let service = ReceiptService::new(
        database.clone(),
        ReceiptNotifications::default(),
        {
            let trace = trace.clone();
            Arc::new(move |event| trace.lock().unwrap().push(event))
        },
        {
            let (trace, request) = (trace.clone(), request.clone());
            Arc::new(move |owner, chat| {
                let (trace, database, request) = (trace.clone(), database.clone(), request.clone());
                async move {
            let receipt=Repository::new(database).lookup(&owner,request["input"]["workerId"].as_str().context("Fixture worker")?,request["input"]["operationId"].as_str().context("Fixture operation")?).await?;
            trace.lock().unwrap().push(json!({"type":"dispatch","ownerId":owner,"chatId":chat,"committedStatus":receipt.as_ref().map(|r|r["status"].clone()).unwrap_or(Value::Null)}));
            anyhow::ensure!(request["dispatchError"]!=true,"Controlled queue dispatch failure");Ok(())
        }.boxed()
            })
        },
        {
            let trace = trace.clone();
            Arc::new(move |call| {
                trace
                    .lock()
                    .unwrap()
                    .push(json!({"type":"warning","context":call.context,"message":call.message}))
            })
        },
    );
    let response = match service.settle(owner, &input).await {
        Ok(body) => json!({"status":200,"body":body}),
        Err(error) => {
            if let Some(error) = error.downcast_ref::<CommandError>() {
                json!({"status":error.status,"body":json!({"code":error.code})})
            } else {
                return Err(error);
            }
        }
    };
    service.drained().await;
    let mut response = response;
    response["trace"] = Value::Array(trace.lock().unwrap().clone());
    Ok(response)
}
