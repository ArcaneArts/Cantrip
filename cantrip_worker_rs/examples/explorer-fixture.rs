//! Disposable local differential driver; not a production command adapter.
use anyhow::{Result, anyhow};
use cantrip_wire::{parse_json_text, value::json};
use cantrip_worker::filesystem::{Scope, explorer};
use std::io::{self, BufRead};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|e| anyhow!("{}", e.lossy()))?;
        let root = cantrip_worker::filesystem::paths::native(input["root"].as_js_string().unwrap());
        let outcome = explorer::execute(&root, &input["request"], &Scope::default()).await;
        let output = match outcome {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(e) => {
                json!({"ok":false,"error":e.to_string(),"code":if e.is::<explorer::TextPreviewRequiredError>(){Some("text-preview-required")}else{None}})
            }
        };
        println!("{}", output.stringify());
    }
    Ok(())
}
