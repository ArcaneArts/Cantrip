use anyhow::{Context, Result};
use cantrip_server::{
    relay::{RelayLimitError, RelayQuotas, SurfacePermit},
    wire::Value,
    workers::limits::{ByteWindow, SlidingWindow},
};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
};
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("oracle text")
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value[key].as_u64().context("oracle integer")
}
fn error(error: RelayLimitError) -> Value {
    Value::from_serialize(
        &serde_json::json!({"error":{"name":"RelayLimitError","message":error.message,"statusCode":429,"retryAfterSeconds":error.retry_after_seconds}}),
    )
}
fn run(case: &Value) -> Result<Value> {
    let input = &case["input"];
    let steps = input["steps"].as_array().context("oracle steps")?;
    let op = text(case, "op")?;
    if op == "bytes" || op == "rate" {
        let limit = number(input, "limit")?;
        let mut bytes = ByteWindow::new(limit);
        let mut rate = SlidingWindow::new(limit as usize);
        return Ok(Value::Array(
            steps
                .iter()
                .map(|step| {
                    let now = step["now"].as_i64().context("oracle clock")?;
                    let key = text(step, "key")?;
                    let result = if op == "rate" {
                        rate.consume(key, now)
                    } else if text(step, "op")? == "retry" {
                        bytes.retry_after(key, number(step, "bytes")?, now)
                    } else {
                        bytes.consume(key, number(step, "bytes")?, now)
                    };
                    Ok(Value::from_serialize(&result))
                })
                .collect::<Result<_>>()?,
        ));
    }
    let limits = input["limits"]
        .as_array()
        .context("quota limits")?
        .iter()
        .map(|value| value.as_u64().context("quota limit"))
        .collect::<Result<Vec<_>>>()?;
    let quotas = RelayQuotas::with_limits(
        limits[0],
        limits[1],
        limits[2],
        limits[3],
        limits[4] as usize,
        limits[5] as usize,
    );
    let mut leases: HashMap<String, SurfacePermit> = HashMap::new();
    let mut outcomes = Vec::new();
    for step in steps {
        let now = step["now"].as_i64().context("quota clock")?;
        let outcome = match text(step, "op")? {
            "relay" => Value::object([(
                "value",
                Value::Bool(quotas.consume_relay_at(
                    text(step, "owner")?,
                    text(step, "worker")?,
                    number(step, "bytes")?,
                    now,
                )),
            )]),
            "upload" => match quotas.consume_upload_at(
                text(step, "owner")?,
                text(step, "worker")?,
                number(step, "bytes")?,
                now,
            ) {
                Ok(()) => Value::object([("ok", Value::Bool(true))]),
                Err(failure) => error(failure),
            },
            "surface" => {
                match quotas.acquire_surface(text(step, "owner")?, text(step, "worker")?) {
                    Ok(lease) => {
                        leases.insert(text(step, "id")?.into(), lease);
                        Value::object([("ok", Value::Bool(true))])
                    }
                    Err(failure) => error(failure),
                }
            }
            "release" => {
                leases.remove(text(step, "id")?);
                Value::object([("ok", Value::Bool(true))])
            }
            _ => anyhow::bail!("unknown quota step"),
        };
        outcomes.push(Value::object([
            ("outcome", outcome),
            ("stats", Value::from_serialize(&quotas.stats())),
        ]));
    }
    Ok(Value::Array(outcomes))
}
#[test]
fn native_quotas_match_actual_node_windows_and_active_claims() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut child = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/relay-quota-oracle.mjs",
        ])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut count = 0;
    let mut receipt = None;
    for line in BufReader::new(child.stdout.take().context("oracle stdout")?).lines() {
        let case: Value = serde_json::from_str(&line?)?;
        if let Some(done) = case.get("done") {
            receipt = done.as_u64();
            continue;
        }
        let actual = run(&case)?;
        assert_eq!(
            actual, case["expected"],
            "quota oracle case {} {}",
            case["id"], case["op"]
        );
        count += 1;
    }
    anyhow::ensure!(
        child.wait()?.success() && receipt == Some(count) && count > 0,
        "Incomplete quota oracle {count} {receipt:?}"
    );
    println!("{count} actual Node limiter/quota sequences matched");
    Ok(())
}
