//! Controlled native protocol peer; no providers, commands, or user profiles.
use super::*;
async fn write(value: &Value) -> Result<()> {
    let mut output = tokio::io::stdout();
    output
        .write_all((value.stringify() + "\n").as_bytes())
        .await?;
    output.flush().await?;
    Ok(())
}
pub async fn run() -> Result<()> {
    let config =
        parse_json_text(&std::env::var("CANTRIP_CODEX_FIXTURE").unwrap_or_else(|_| "{}".into()))
            .unwrap_or(json!({}));
    if std::env::args().any(|v| v == "--version") {
        if let Some(ms) = config["versionDelayMs"].as_u64() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        let value = config
            .get("versionRaw")
            .cloned()
            .unwrap_or(json!("codex-cli 0.166.0"));
        if let Some(value) = value.as_str() {
            if config["versionStderr"] == true {
                eprintln!("{value}");
            } else {
                println!("{value}");
            }
        }
        if let Some(message) = config["versionWarning"].as_str() {
            eprintln!("{message}");
        }
        std::process::exit(config["versionExit"].as_i64().unwrap_or(0) as i32);
    }
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut held = Vec::new();
    let mut notified = Vec::new();
    while let Some(line) = input.next_line().await? {
        let value = parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy()))?;
        let method = value["method"].as_str().unwrap_or("");
        let params = &value["params"];
        if value.get("id").is_none() {
            notified.push(value);
            continue;
        }
        let id = value["id"].clone();
        match method {
            "initialize" => {
                if config["rejectInitialize"] == true
                    || config["rejectExperimental"] == true
                        && params["capabilities"]["experimentalApi"] == true
                {
                    write(&json!({"id":id,"error":json!({"code":-32600,"message":"experimental capability rejected"})})).await?;
                } else {
                    write(&json!({"id":id,"result":config.get("initialize").cloned().unwrap_or(json!({"userAgent":"native-fixture/0.166.0","platformFamily":"unix","platformOs":"macos"}))})).await?;
                }
            }
            "experimentalFeature/list" => {
                if let Some(error) = config.get("featureError") {
                    write(&json!({"id":id,"error":error})).await?;
                    continue;
                }
                let page = params["cursor"]
                    .as_str()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0);
                let result=config["pages"].as_array().and_then(|pages|pages.get(page)).cloned().unwrap_or(json!({"data":vec![json!({"name":"multi_agent","stage":"stable","enabled":false,"defaultEnabled":false})],"nextCursor":Value::Null}));
                write(&json!({"id":id,"result":result})).await?;
            }
            "fixture/echo" => {
                if let Some(lines) = params["lines"].as_array() {
                    for line in lines {
                        let text = line.as_str().unwrap();
                        let mut out = tokio::io::stdout();
                        out.write_all(text.as_bytes()).await?;
                        out.flush().await?;
                    }
                }
                if let Some(notices) = params["notifications"].as_array() {
                    for notice in notices {
                        write(notice).await?;
                    }
                }
                if let Some(error) = params.get("error") {
                    write(&json!({"id":id,"error":error})).await?;
                } else {
                    write(&json!({"id":id,"result":params.get("value").cloned().unwrap_or(Value::Null)})).await?;
                }
            }
            "fixture/notified" => {
                write(&json!({"id":id,"result":notified})).await?;
                notified = Vec::new();
            }
            "fixture/hold" => held.push(id),
            "fixture/release" => {
                for id in held.drain(..).rev() {
                    write(&json!({"id":id,"result":"released"})).await?;
                }
                write(&json!({"id":id,"result":true})).await?;
            }
            "fixture/exit" => {
                if let Some(lines) = params["stderr"].as_array() {
                    let mut stderr = tokio::io::stderr();
                    for line in lines {
                        stderr.write_all(line.as_str().unwrap().as_bytes()).await?;
                    }
                    stderr.flush().await?;
                }
                #[cfg(unix)]
                if params["signal"] == true {
                    // Signal only this owned disposable peer; the production
                    // client must observe the reaped status, not guess by code.
                    unsafe {
                        libc::raise(libc::SIGTERM);
                    }
                    unreachable!("SIGTERM terminates the fixture");
                }
                std::process::exit(params["code"].as_i64().unwrap_or(1) as i32);
            }
            _ => {
                let unavailable = config["unavailable"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|v| v == &value["method"]));
                write(&json!({"id":id,"error":json!({"code":if unavailable {-32601}else{-32602},"message":if unavailable {"Method not found"}else{"Invalid params"}})})).await?;
            }
        }
    }
    Ok(())
}
