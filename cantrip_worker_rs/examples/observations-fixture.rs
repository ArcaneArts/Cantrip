//! Disposable Node/native observation oracle. Never part of the shipped worker.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    filesystem::{Scope, paths},
    git::worktrees::{
        Manager,
        observations::{
            Observations,
            activity::{self, Activity},
            notification,
        },
    },
    routing::Registry,
};
use std::{
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::io::{AsyncBufReadExt, BufReader};
fn print(value: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", value.stringify()).unwrap();
    out.flush().unwrap();
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut observer = None;
    let mut activity = None;
    let accepted = Arc::new(AtomicBool::new(true));
    while let Some(line) = input.next_line().await? {
        let value = parse_json_text(&line).map_err(|error| anyhow!("{}", error.lossy()))?;
        let result=async {
            match value["op"].as_str().unwrap() {
                "open"=> {
                    let directory=paths::native(value["directory"].as_js_string().unwrap());
                    let accepted=accepted.clone();
                    observer=Some(Observations::new(Arc::new(Manager::new(&directory)),Arc::new(move|notification| {
                        let accepted=accepted.load(Ordering::Acquire);
                        print(json!({"kind":"notification","accepted":accepted,"notification":notification}));accepted
                    })));
                    Ok(Value::Null)
                }
                "configure"=> {observer.as_ref().unwrap().configure(value["targets"].as_array().unwrap());Ok(Value::Null)}
                "routed"=>observer.as_ref().unwrap().execute_routed(&value["command"],&Registry::new(&paths::native(value["directory"].as_js_string().unwrap()))).await,
                "close"=>{observer.as_ref().unwrap().close().await;Ok(Value::Null)}
                "accept"=> {accepted.store(value["value"]==true,Ordering::Release);Ok(Value::Null)}
                "path"=>Ok(json!(activity::activity_path(value["value"].as_js_string().unwrap()))),
                "bounded"=>Ok(json!(activity::bounded_changes(value["changes"].as_array().unwrap().clone()))),
                "commits"=>Ok(json!(activity::commit_changes(value["output"].as_str().unwrap()))),
                "touches"=>Ok(json!(notification::touches_files(value["value"].as_js_string()))),
                "operation"=>Ok(notification::operation(&value["target"],&value["state"],&value["conflicts"],value["observedAt"].as_str().unwrap())),
                "server"=>Ok(notification::for_server(&value["notification"])),
                "activity-open"=> {let entry=Activity::new(paths::native(value["root"].as_js_string().unwrap()));entry.initialize(&Scope::default()).await;activity=Some(entry);Ok(Value::Null)}
                "activity-flush"=>{let entry=activity.as_ref().unwrap();for file in value["paths"].as_array().unwrap(){entry.record(file.as_js_string().unwrap());}Ok(json!(entry.flush().await))}
                "activity-head"=>Ok(json!(activity.as_ref().unwrap().observe_head(&value["head"],&Scope::default()).await)),
                _=>Err(anyhow!("Unknown observation fixture operation"))
            }
        }.await;
        print(match result {
            Ok(result) => json!({"kind":"response","id":value["id"],"ok":true,"result":result}),
            Err(error) => {
                json!({"kind":"response","id":value["id"],"ok":false,"error":error.to_string()})
            }
        });
    }
    if let Some(observer) = observer {
        observer.close().await;
    }
    Ok(())
}
