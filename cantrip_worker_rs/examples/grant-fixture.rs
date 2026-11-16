//! Development-only protocol oracle. Accepts/emits synthetic secret material;
//! never run with actual worker profiles or keys. Not a production entry point.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::encryption::{Identity, RequestedGrant, Service, ServiceError};
use futures::future::BoxFuture;
use std::{
    collections::HashMap,
    io::{self, BufRead},
    sync::Arc,
};

fn output(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => match error.downcast_ref::<ServiceError>() {
            Some(error) => json!({"ok":false,"code":error.code,"error":error.message}),
            None => json!({"ok":false,"code":Value::Null,"error":error.to_string()}),
        },
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let mut service: Option<Arc<Service>> = None;
    let mut pending: HashMap<String, BoxFuture<'static, Result<Value, ServiceError>>> =
        HashMap::new();
    for line in io::stdin().lock().lines() {
        let line = line?;
        let input = parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy()))?;
        let result:Result<Value>=async {
            if input["op"]=="open" {
                if let Some(service)=service.take(){service.close().await?;}pending.clear();
                let identity=Identity::open(std::path::Path::new(input["directory"].as_str().unwrap()),input["serverUrl"].as_str().unwrap(),input["workerId"].as_js_string().unwrap(),input["allowPortChange"].as_bool().unwrap_or(false))?;
                let created=Service::new(identity,input["serverUrl"].as_str().unwrap(),cantrip_worker::http::client()?)?;
                let registration=created.registration();service=Some(created);return Ok(registration);
            }
            let current=service.as_ref().ok_or_else(||anyhow!("Fixture has not opened a service"))?;
            match input["op"].as_str().unwrap_or("") {
                "accept"=>Ok(current.accept_bootstrap(&input["payload"])?),
                "status"=>Ok(current.status()),
                "owner"=>Ok(json!(current.owner_id()?)),
                "server"=>Ok(current.server_identity()?),
                "key"=>{let key=current.component_key(input["component"].as_str().unwrap(),input["revision"].as_u64())?;Ok(json!({"key":cantrip_crypto::encode(&key.key),"keyRevision":key.key_revision}))},
                "lock"=>{current.lock();Ok(current.status())},
                "start"=>{
                    let requested=if input["requested"].is_null(){None}else{Some(RequestedGrant{component:input["requested"]["component"].as_str().unwrap().to_owned(),key_revision:input["requested"]["keyRevision"].as_u64().unwrap()})};
                    let id=input["id"].as_str().unwrap().to_owned();
                    pending.insert(id,current.refresh(input["credential"].as_str().unwrap().to_owned(),requested));Ok(Value::Null)
                },
                "wait"=>Ok(pending.remove(input["id"].as_str().unwrap()).ok_or_else(||anyhow!("Missing fixture refresh"))?.await?),
                "drop"=>{pending.remove(input["id"].as_str().unwrap());Ok(Value::Null)},
                "close"=>{current.close().await?;pending.clear();Ok(current.status())},
                _=>Err(anyhow!("Unknown grant fixture operation")),
            }
        }.await;
        println!(
            "{}",
            json!({"id":input["requestId"],"result":output(result)}).stringify()
        );
    }
    if let Some(service) = service {
        service.close().await?;
    }
    Ok(())
}
