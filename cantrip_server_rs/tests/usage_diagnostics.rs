use anyhow::{Context, Result, bail};
use cantrip_server::{
    operations::{
        log_records,
        logging::{Emitter, Logger},
    },
    usage::{
        FlushResult,
        background::{Followup, Job, Operation, Outcome},
        meter::{Counter, Measurement, Options},
        meter_service::{Meter, Observer, Publisher, Sink},
    },
    wire::Value,
};
use chrono::{DateTime, Utc};
use futures::FutureExt;
use serde_json::{Value as Json, json};
use std::{
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering::SeqCst},
    },
};

const BASE: i64 = 1_793_059_200_123;
#[derive(Default)]
struct Probe {
    clock: AtomicI64,
    active: Mutex<Json>,
    trace: Mutex<Vec<Json>>,
    records: Mutex<Vec<Value>>,
}
impl Probe {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            clock: AtomicI64::new(BASE),
            ..Self::default()
        })
    }
    fn logger(self: &Arc<Self>) -> Logger {
        let clock = self.clone();
        let output = self.clone();
        let emitter = Emitter::new(
            "server".into(),
            Arc::new(move || clock.clock.load(SeqCst) as f64),
            Arc::new(move |record| {
                output
                    .trace
                    .lock()
                    .unwrap()
                    .push(json!({"event":record["context"]["event"]}));
                output.records.lock().unwrap().push(record);
            }),
        );
        Arc::new(move |call| emitter.dispatch(call).unwrap())
    }
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(self.clock.load(SeqCst)).unwrap()
    }
    fn reply(&self, followup: bool) -> Result<()> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"operation":if followup {"followup"} else {"repository"}}));
        let step = self.active.lock().unwrap();
        self.clock.fetch_add(
            step[if followup {
                "followupDuration"
            } else {
                "duration"
            }]
            .as_i64()
            .unwrap_or(0),
            SeqCst,
        );
        if step[if followup { "followupFail" } else { "fail" }] == true {
            bail!("private-accounting-error-marker")
        }
        Ok(())
    }
    fn snapshot(&self, result: Json, stats: impl serde::Serialize) -> Value {
        let records = std::mem::take(&mut *self.records.lock().unwrap());
        let persisted = records
            .iter()
            .map(log_records::minimize)
            .collect::<Vec<_>>();
        Value::from_serialize(
            &json!({"result":result,"stats":stats,"trace":std::mem::take(&mut *self.trace.lock().unwrap()),"records":records,"persisted":persisted}),
        )
    }
}
fn storage(acquired: bool) -> Json {
    json!({"acquired":acquired,"accountCount":2,"categoryCount":3,"logicalBytes":"9007199254740993","rowCount":"10","measuredAt":"2026-10-27T00:00:00.123Z","ownerIds":["owner"]})
}
fn history(acquired: bool) -> Json {
    json!({"acquired":acquired,"bandwidthDaysRolled":2,"bandwidthHourlyRowsDeleted":3,"bandwidthDailyRowsDeleted":5,"flushRowsDeleted":7,"storageDaysRolled":11,"storageHourlyRowsDeleted":13,"storageDailyRowsDeleted":17})
}
fn totals() -> Json {
    json!({"accountCount":2,"logicalServerBytes":"19","logicalWorkerManagedBytes":"23","physicalDatabaseBytes":"29"})
}

#[tokio::test]
async fn actual_accounting_producers_match_reference_logs_state_and_noise_policy() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/usage-diagnostics-oracle.mjs",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Reference oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Json = serde_json::from_slice(&output.stdout)?;
    for (case, scenario) in cases.as_array().context("scenarios")?.iter().enumerate() {
        let probe = Probe::new();
        let logger = probe.logger();
        if scenario["kind"] == "job" {
            let is_storage = scenario["name"] == "storage-reconciliation";
            let name = if is_storage {
                "storage-reconciliation"
            } else {
                "history-maintenance"
            };
            let p = probe.clone();
            let operation: Operation = Arc::new(move |_| {
                let p = p.clone();
                async move {
                    p.reply(false)?;
                    let acquired = p.active.lock().unwrap()["acquired"] == true;
                    Ok(Outcome {
                        acquired,
                        value: if is_storage {
                            storage(acquired)
                        } else {
                            history(acquired)
                        },
                    })
                }
                .boxed()
            });
            let p = probe.clone();
            let followup: Followup = Arc::new(move |_, acquired| {
                let p = p.clone();
                async move {
                    if is_storage {
                        if acquired {
                            p.reply(true)?;
                        }
                        Ok(None)
                    } else {
                        p.reply(true)?;
                        Ok(Some(totals()))
                    }
                }
                .boxed()
            });
            let p = probe.clone();
            let job = Job::with_clock_and_logger(
                name,
                60000,
                operation,
                followup,
                if is_storage {
                    None
                } else {
                    Some(
                        json!({"accountCount":0,"logicalServerBytes":"0","logicalWorkerManagedBytes":"0","physicalDatabaseBytes":null}),
                    )
                },
                Arc::new(move || p.now()),
                logger,
            )?;
            for (step, action) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                *probe.active.lock().unwrap() = action.clone();
                let result = if action["close"] == true {
                    job.close().await;
                    Json::Null
                } else {
                    job.run()
                        .await
                        .map(|v| v.as_ref().clone())
                        .unwrap_or(Json::Null)
                };
                assert_eq!(
                    probe.snapshot(result, job.stats()),
                    Value::from_serialize(&action["expected"]),
                    "case{case} step{step}"
                );
            }
        } else {
            let p = probe.clone();
            let sink: Sink = Arc::new(move |batch| {
                let p = p.clone();
                async move {
                    p.trace.lock().unwrap().push(json!({"batch":batch}));
                    let step = p.active.lock().unwrap();
                    p.clock
                        .fetch_add(step["duration"].as_i64().unwrap_or(0), SeqCst);
                    if step["fail"] == true {
                        bail!("private-accounting-error-marker")
                    }
                    Ok(FlushResult {
                        applied: step["applied"].as_bool().unwrap_or(true),
                        owner_ids: vec!["owner".into(), "other".into()],
                    })
                }
                .boxed()
            });
            let p = probe.clone();
            let observer_fail = scenario["observerFail"] == true;
            let observe: Observer = Arc::new(move |value| {
                p.trace.lock().unwrap().push(json!({"measurement":value}));
                if observer_fail {
                    bail!("private-accounting-error-marker")
                }
                Ok(())
            });
            let p = probe.clone();
            let publication_fail = scenario["publicationFail"] == true;
            let publish: Publisher = Arc::new(move |owners| {
                p.trace.lock().unwrap().push(json!({"owners":owners}));
                if publication_fail {
                    bail!("private-accounting-error-marker")
                }
                Ok(())
            });
            let now = probe.clone();
            let wall = probe.clone();
            let meter = Meter::with_clocks_and_logger(
                Options {
                    meter_id: "diagnostic-meter".into(),
                    flush_threshold_bytes: 1_000_000.into(),
                    max_buffered_entries: scenario["maxEntries"].as_u64().unwrap() as usize,
                    ..Options::default()
                },
                sink,
                Some(observe),
                Some(publish),
                Arc::new(move || now.now()),
                Arc::new(move || wall.clock.load(SeqCst)),
                logger,
            )?;
            for (step, action) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                *probe.active.lock().unwrap() = action.clone();
                let result = match action["op"].as_str().unwrap() {
                    "record" => json!(meter.record(Measurement {
                        owner_id: action["owner"].as_str().unwrap().into(),
                        bytes: Counter::Integer(7.into()),
                        operation_count: Some(Counter::Integer(1.into())),
                        channel: "http".into(),
                        direction: "egress".into(),
                        notify_change: action["notifyChange"].as_bool()
                    })),
                    "flush" => json!(meter.flush().await),
                    "advance" => {
                        probe
                            .clock
                            .fetch_add(action["duration"].as_i64().unwrap(), SeqCst);
                        Json::Null
                    }
                    "close" => {
                        meter.close().await;
                        Json::Null
                    }
                    _ => unreachable!(),
                };
                assert_eq!(
                    probe.snapshot(result, meter.stats()),
                    Value::from_serialize(&action["expected"]),
                    "case{case} step{step}"
                );
            }
            meter.close().await;
        }
    }
    Ok(())
}
