use anyhow::{Context, Result};
use cantrip_server::{
    usage::{
        FlushResult,
        meter::{Counter, Measurement, Options, State},
    },
    wire,
};
use chrono::{DateTime, Utc};
use num_bigint::BigInt;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};

struct Oracle(Option<Child>);
impl Drop for Oracle {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn counter(value: &Value) -> Counter {
    if let Some(integer) = value.get("integer").and_then(Value::as_str) {
        return Counter::Integer(integer.parse().unwrap());
    }
    let number = value
        .get("number")
        .and_then(Value::as_str)
        .map(|s| match s {
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => f64::NAN,
        })
        .or_else(|| value.as_f64())
        .unwrap_or(f64::NAN);
    Counter::Number(number)
}
fn now(clock: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(clock).unwrap()
}
fn run(scenario: &Value) -> Result<Value> {
    let mut state = State::new(Options {
        meter_id: "fixture-meter".into(),
        max_buffered_entries: scenario["maxEntries"].as_u64().unwrap_or(3) as usize,
        flush_threshold_bytes: BigInt::from(10).pow(100),
        ..Options::default()
    })?;
    let mut clock = 1793059200123;
    let mut valid_clock = true;
    let mut started_at = 0;
    let mut active = false;
    let mut batches = vec![];
    let mut observations = vec![];
    let mut publications = vec![];
    let mut output = vec![];
    for step in scenario["steps"].as_array().context("scenario steps")? {
        if let Some(value) = step.get("at") {
            if let Some(value) = value.as_i64() {
                clock = value;
                valid_clock = true;
            } else {
                valid_clock = false;
            }
        }
        let value = match step["op"].as_str().context("step operation")? {
            "record" => {
                let input = &step["input"];
                json!(state.record(
                    Measurement {
                        owner_id: input["ownerId"].as_str().unwrap().into(),
                        bytes: counter(&input["bytes"]),
                        operation_count: input.get("operationCount").map(counter),
                        channel: input["channel"].as_str().unwrap().into(),
                        direction: input["direction"].as_str().unwrap().into(),
                        notify_change: input.get("notifyChange").and_then(Value::as_bool)
                    },
                    valid_clock.then(|| now(clock)),
                    |value| observations.push(serde_json::to_value(value).unwrap())
                ))
            }
            "start" => {
                if active {
                    json!({"started":false,"shared":true})
                } else if let Some(batch) = state.capture(now(clock)) {
                    batches.push(serde_json::to_value(batch)?);
                    started_at = clock;
                    active = true;
                    json!({"started":true,"shared":false})
                } else {
                    json!({"started":false,"shared":false,"emptyResult":true})
                }
            }
            "success" | "failure" => {
                anyhow::ensure!(active, "fixture completion has an active flush");
                active = false;
                if step["op"] == "failure" {
                    state.failed(clock - started_at);
                    json!(false)
                } else {
                    let owners = state.committed(
                        serde_json::from_value::<FlushResult>(step["result"].clone())?,
                        now(clock),
                        clock - started_at,
                    )?;
                    if !owners.is_empty() {
                        publications.push(owners);
                    }
                    json!(true)
                }
            }
            "close" => {
                anyhow::ensure!(!active, "fixture closes outside an unresolved sink call");
                if state.closed {
                    output.push(json!({"value":null,"stats":state.stats(),"batches":batches,"observations":observations,"publications":publications}));
                    continue;
                }
                state.closed = true;
                let replies = step["replies"].as_array();
                for attempt in 0..2 {
                    let Some(batch) = state.capture(now(clock)) else {
                        break;
                    };
                    let owners = batch.entries.iter().fold(Vec::new(), |mut owners, entry| {
                        if !owners.contains(&entry.owner_id) {
                            owners.push(entry.owner_id.clone());
                        }
                        owners
                    });
                    batches.push(serde_json::to_value(batch)?);
                    let reply = replies.and_then(|r| r.get(attempt));
                    if reply.is_some_and(|r| r["reject"] == true) {
                        state.failed(0);
                        continue;
                    }
                    let result = reply
                        .and_then(|r| r.get("result"))
                        .map(|r| serde_json::from_value::<FlushResult>(r.clone()))
                        .transpose()?
                        .unwrap_or(FlushResult {
                            applied: true,
                            owner_ids: owners,
                        });
                    let owners = state.committed(result, now(clock), 0)?;
                    if !owners.is_empty() {
                        publications.push(owners);
                    }
                    break;
                }
                Value::Null
            }
            _ => anyhow::bail!("unknown fixture step"),
        };
        output.push(json!({"value":value,"stats":state.stats(),"batches":batches,"observations":observations,"publications":publications}));
    }
    Ok(Value::Array(output))
}
#[test]
fn native_meter_state_matches_actual_node_records_retries_and_shutdown() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut oracle = Oracle(Some(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/usage-meter-oracle.mjs",
            ])
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    ));
    let stdout = oracle
        .0
        .as_mut()
        .unwrap()
        .stdout
        .take()
        .context("oracle stdout")?;
    let mut cases = 0;
    let mut receipt = None;
    for line in BufReader::new(stdout).lines() {
        let case: Value = serde_json::from_str(&line?)?;
        if let Some(done) = case.get("done") {
            anyhow::ensure!(receipt.is_none(), "duplicate oracle receipt");
            receipt = Some(done.as_u64().context("oracle case count")?);
            continue;
        }
        anyhow::ensure!(
            receipt.is_none(),
            "oracle case after its completion receipt"
        );
        let actual = wire::Value::from_serialize(&run(&case["scenario"])?);
        let expected = wire::Value::from_serialize(&case["outcome"]);
        anyhow::ensure!(
            actual == expected,
            "Meter scenario {} {} differs:\nactual {}\nexpected {}",
            case["id"],
            case["scenario"]["name"],
            actual.stringify().chars().take(8192).collect::<String>(),
            expected.stringify().chars().take(8192).collect::<String>()
        );
        cases += 1;
    }
    let status = oracle.0.as_mut().unwrap().wait()?;
    oracle.0 = None;
    anyhow::ensure!(
        status.success() && cases > 0 && receipt == Some(cases),
        "Incomplete meter oracle: {status}, cases {cases}, receipt {receipt:?}"
    );
    println!("{cases} actual Node meter state scenarios matched");
    Ok(())
}
