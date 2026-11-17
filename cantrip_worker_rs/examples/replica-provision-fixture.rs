//! Local owned-repository differential entry point. Never shipped.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    filesystem::{Scope, paths},
    replicas,
};
use std::{
    io::{self, BufRead},
    sync::{Arc, Mutex},
};
async fn command(manager: &replicas::Manager, command: &Value) -> Value {
    let progress = Mutex::new(Vec::new());
    let result = manager
        .execute(command, &Scope::default(), &|event| {
            progress.lock().unwrap().push(event)
        })
        .await;
    let progress = progress.into_inner().unwrap();
    match result {
        Ok(value) => json!({"ok":true,"value":value,"progress":progress}),
        Err(error) => {
            json!({"ok":false,"error":cantrip_worker::error::message(&error),"progress":progress})
        }
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let mut owner = None;
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|e| anyhow!("{}", e.lossy()))?;
        let result = if input["method"] == "helpers" {
            let output = input["output"].as_js_string().unwrap();
            let (code, message) = replicas::clone_failure(output, input["windows"] == true);
            json!({"progress":replicas::parse_clone_progress(output).map(|v|json!({"percent":v})),
                "summary":replicas::summarize_clone_failure(output),"failure":json!({"code":code,"message":message})})
        } else {
            let directory = paths::native(input["directory"].as_js_string().unwrap());
            let worker = input["workerId"].as_js_string().unwrap();
            if owner.as_ref().is_none_or(
                |(path, id, _): &(
                    std::path::PathBuf,
                    cantrip_wire::JsString,
                    Arc<replicas::Manager>,
                )| *path != directory || id != worker,
            ) {
                owner = Some((
                    directory.clone(),
                    worker.clone(),
                    Arc::new(replicas::Manager::new(&directory, worker)),
                ));
            }
            let manager = &owner.as_ref().unwrap().2;
            if input["method"] == "batch" {
                json!(
                    futures::future::join_all(
                        input["commands"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|item| command(manager, item))
                    )
                    .await
                )
            } else {
                command(manager, &input["command"]).await
            }
        };
        println!(
            "{}",
            json!({"id":input["id"],"result":result})
                .stringify()
                .replace('\u{2028}', "\\u2028")
                .replace('\u{2029}', "\\u2029")
        );
    }
    Ok(())
}
