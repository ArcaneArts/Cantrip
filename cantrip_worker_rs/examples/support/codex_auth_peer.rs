use super::*;

pub(super) async fn run(mode: &str, home: &std::path::Path) -> Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    let mut authenticated = false;
    let mut pending = false;
    let mut check = tokio::time::interval(Duration::from_millis(20));
    let complete = home.join("authorize-fixture-device");
    eprintln!("fixture-authentication-stderr-token");
    loop {
        let line = tokio::select! {
            line = lines.next_line() => line?,
            _ = check.tick(), if pending && mode == "success" => {
                if tokio::fs::try_exists(&complete).await? {
                    authenticated = true;
                    pending = false;
                    publish(&mut out, json!({"loginId":"device-fixture","success":true})).await?;
                }
                continue;
            }
        };
        let Some(line) = line else {
            break;
        };
        let request = parse_json_text(&line).map_err(|error| anyhow!("{}", error.lossy()))?;
        let id = &request["id"];
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => json!({"userAgent":"fixture"}),
            "initialized" => continue,
            "account/read" => {
                assert_eq!(request["params"]["refreshToken"], false);
                let account = if authenticated {
                    json!({"type":"chatgpt","email":"device@example.invalid","planType":"plus"})
                } else {
                    Value::Null
                };
                json!({"account":account})
            }
            "account/login/start" => {
                assert_eq!(request["params"]["type"], "chatgptDeviceCode");
                let login_id = "device-fixture";
                if mode != "failure" {
                    pending = true;
                } else {
                    publish(
                        &mut out,
                        json!({
                            "loginId":login_id,"success":false,
                            "error":"expired fixture-authentication-private-error"
                        }),
                    )
                    .await?;
                }
                json!({"type":"chatgptDeviceCode","loginId":login_id,
                    "verificationUrl":"https://example.invalid/verify","userCode":"FIXTURE-DEVICE-CODE"})
            }
            "account/rateLimits/read" => json!({
                "rateLimitsByLimitId":json!({"codex":json!({
                    "secondary":json!({"usedPercent":42,"resetsAt":2_000_000_000,"windowDurationMins":10_080})
                })})
            }),
            "account/login/cancel" => {
                assert!(pending);
                assert_eq!(request["params"]["loginId"], "device-fixture");
                pending = false;
                json!({"status":"canceled"})
            }
            "account/logout" => {
                assert!(!pending, "logout must first cancel a pending device login");
                authenticated = false;
                json!({})
            }
            method => bail!("Unexpected auth fixture RPC {method}."),
        };
        let frame = json!({"id":id,"result":result});
        out.write_all((frame.stringify() + "\n").as_bytes()).await?;
        out.flush().await?;
    }
    Ok(())
}

async fn publish(out: &mut tokio::io::Stdout, params: Value) -> Result<()> {
    let notice = json!({"method":"account/login/completed","params":params});
    out.write_all((notice.stringify() + "\n").as_bytes())
        .await?;
    out.flush().await?;
    Ok(())
}
