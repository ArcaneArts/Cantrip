//! Native keeper-protocol fault peer. Actual lease tests use bundled Codex.
use super::*;
pub async fn run() -> Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    let get = |name: &str| {
        arguments
            .iter()
            .position(|v| v == name)
            .and_then(|i| arguments.get(i + 1))
            .cloned()
    };
    let generation = get("--generation").unwrap();
    let config = parse_json_text(
        &std::env::var("CANTRIP_NATIVE_OWNER_FIXTURE").unwrap_or_else(|_| "{}".into()),
    )
    .unwrap_or(json!({}));
    for key in [
        "CANTRIP_INFERENCE_SCOPE",
        "CANTRIP_INFERENCE_GENERATION",
        "CANTRIP_INFERENCE_RUNTIME",
    ] {
        if std::env::var_os(key).is_some() {
            bail!("helper inherited runtime registration");
        }
    }
    if config["exitBeforeAck"] == true {
        eprintln!("controlled ownership failure");
        std::process::exit(7);
    }
    if config["noAck"] == true
        && !config["readyFile"]
            .as_str()
            .is_some_and(|path| std::path::Path::new(path).exists())
    {
        std::future::pending::<()>().await;
    }
    if config["badAck"] == true {
        println!("{{\"version\":2}}");
    } else {
        println!(
            "{}",
            json!({"version":1,"generation":generation,"ready":true}).stringify()
        );
    }
    if get("--prepare").is_some() || get("--retire").is_some() {
        return Ok(());
    }
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut first_delay = config["delayFirstJournalMs"].as_u64();
    while let Some(line) = lines.next_line().await? {
        let request = parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy()))?;
        if config["malformedIpc"] == true {
            println!("not json");
            continue;
        }
        if let Some(ms) = config["delayJournalMs"].as_u64() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        if let Some(ms) = first_delay.take() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        let mut response = json!({"requestId":request["requestId"],"ok":true});
        if config["missingResult"] != true {
            response["result"] = request["command"].clone();
        }
        if config["fragmentUnicode"] == true {
            response["result"] = json!("😀");
            let bytes = (response.stringify() + "\n").into_bytes();
            let at = bytes.iter().position(|v| *v == 0xf0).unwrap() + 1;
            let mut out = tokio::io::stdout();
            out.write_all(&bytes[..at]).await?;
            out.flush().await?;
            tokio::time::sleep(Duration::from_millis(2)).await;
            out.write_all(&bytes[at..]).await?;
            out.flush().await?;
        } else {
            println!("{}", response.stringify());
        }
    }
    if let Some(ms) = config["closeDelayMs"].as_u64() {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    Ok(())
}
