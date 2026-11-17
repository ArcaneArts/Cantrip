//! Synthetic, disposable source-journal interoperability driver. No real keys.
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::Zeroizing;
use cantrip_history::{
    content::{self, Encryption, Field, Material},
    cursor::Tracker,
    native,
    source::{self, Journal},
};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

#[path = "support/history_content.rs"]
mod history_content;
#[path = "support/history_outbox.rs"]
mod history_outbox;
#[path = "support/history_projection.rs"]
mod history_projection;

struct Keys(Mutex<Value>);
impl Encryption for Keys {
    fn identity(&self) -> Result<(JsString, JsString)> {
        let state = self.0.lock().unwrap();
        Ok((
            state["owner"].as_js_string().unwrap().clone(),
            state["server"].as_js_string().unwrap().clone(),
        ))
    }
    fn material(&self, revision: Option<u64>) -> Result<Material> {
        let mut state = self.0.lock().unwrap();
        let pause = if let Value::Object(fields) = &mut *state {
            fields.shift_remove("pause")
        } else {
            None
        };
        let revision = revision.unwrap_or(state["revision"].as_u64().unwrap());
        if revision == 99 {
            bail!("Missing historical chat-content key.");
        }
        let material = Material {
            owner_id: state["owner"].as_js_string().unwrap().clone(),
            server_id: state["server"].as_js_string().unwrap().clone(),
            key_revision: revision,
            key: Zeroizing::new(vec![revision as u8; 32]),
        };
        drop(state);
        // Test-only granted-key boundary. The production encryption service has
        // no gate or deterministic entropy mode. Owned fixtures release it.
        if let Some(pause) = pause {
            std::fs::write(pause["ready"].as_str().unwrap(), b"ready")?;
            let release = std::path::Path::new(pause["release"].as_str().unwrap());
            while !release.exists() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        Ok(material)
    }
}
fn field(value: &Value) -> Result<Field> {
    Ok(match value.as_str().unwrap_or("source-record") {
        "source-record" => Field::SourceRecord,
        "prepared-batch" => Field::PreparedBatch,
        "projection-state" => Field::ProjectionState,
        "projection-rebase" => Field::ProjectionRebase,
        "outbox-baseline" => Field::OutboxBaseline,
        "outbox-mutation" => Field::OutboxMutation,
        _ => bail!("Unknown field"),
    })
}
struct Fixture {
    service: Arc<Keys>,
    handles: HashMap<String, Journal>,
    outboxes: HashMap<String, cantrip_history::outbox::Outbox>,
    tracker: Tracker,
    projections: history_projection::Engine,
}
impl Fixture {
    async fn run(&mut self, input: Value) -> Result<Value> {
        if input["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("content."))
        {
            return history_content::run(self.service.clone(), input).await;
        }
        if input["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("projection."))
        {
            return self
                .projections
                .run(self.service.clone(), &self.handles, &self.outboxes, &input)
                .await;
        }
        if input["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("outbox."))
        {
            return history_outbox::run(&mut self.outboxes, self.service.clone(), &input).await;
        }
        let handle = input["handle"].as_str().unwrap_or("a").to_owned();
        match input["op"].as_str().unwrap() {
            "identity" => {
                *self.service.0.lock().unwrap() = input["state"].clone();
                Ok(Value::Null)
            }
            "open" => {
                let names = ["workerId", "chatId", "bindingId", "threadId"].map(|key| {
                    input[key].as_js_string().cloned().unwrap_or_else(|| {
                        match key {
                            "workerId" => "worker",
                            "chatId" => "chat",
                            "bindingId" => "binding",
                            _ => "thread",
                        }
                        .into()
                    })
                });
                let scope = source::scope(
                    self.service.as_ref(),
                    &names[0],
                    &names[1],
                    &names[2],
                    &names[3],
                )?;
                let journal = Journal::open(
                    PathBuf::from(input["directory"].as_str().unwrap()),
                    scope,
                    self.service.clone(),
                )
                .await?;
                let result = json!({"directory":journal.directory().to_string_lossy(),"journalId":journal.journal_id(),"scope":journal.scope()});
                self.handles.insert(handle, journal);
                Ok(result)
            }
            "reduce" => cantrip_history::reducer::reduce(
                input.get("previous"),
                input["records"].as_array().unwrap(),
                input["threadId"].as_js_string().unwrap_or(&"thread".into()),
            ),
            "reduce-source" => {
                let journal = self
                    .handles
                    .get(&handle)
                    .ok_or_else(|| anyhow!("Missing handle"))?;
                let records = journal
                    .read(
                        input["after"].as_u64().unwrap_or(0),
                        input["limit"].as_u64().unwrap_or(128),
                    )
                    .await?;
                cantrip_history::reducer::reduce(
                    input.get("previous"),
                    &records,
                    input["threadId"].as_js_string().unwrap_or(&"thread".into()),
                )
            }
            "schema" => Ok(
                match cantrip_protocol::parse(
                    input["schema"].as_str().unwrap(),
                    Some(&input["value"]),
                ) {
                    Ok(value) => json!({"success":true,"data":value}),
                    Err(cantrip_protocol::ValidationError::Invalid(issues)) => {
                        json!({"success":false,"issues":issues})
                    }
                    Err(_) => bail!("Unknown schema"),
                },
            ),
            "snapshot" => native::snapshot(&input["value"], &"thread".into()),
            "frame" => native::source(&input["value"], &"thread".into()),
            "protect" => content::protect(
                self.service.as_ref(),
                &input["context"],
                input["body"].as_js_string().unwrap(),
                field(&input["field"])?,
            ),
            "decrypt" => Ok(json!(
                content::open(
                    self.service.as_ref(),
                    &input["context"],
                    &input["envelope"],
                    field(&input["field"])?
                )?
                .as_str()
            )),
            "tracker" => {
                self.tracker = Tracker::default();
                Ok(json!(
                    input["frames"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|frame| if frame["kind"] == "notification" {
                            self.tracker.notification(frame)
                        } else {
                            self.tracker.snapshot(frame)
                        })
                        .collect::<Vec<_>>()
                ))
            }
            "recover" => {
                let mut found = Journal::recover(
                    PathBuf::from(input["directory"].as_str().unwrap()),
                    input["workerId"]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "worker".into()),
                    self.service.clone(),
                    Arc::new(AtomicBool::new(input["cancelled"] == true)),
                    if input["known"] == true {
                        Some(Arc::new(|_, _| true))
                    } else {
                        None
                    },
                )
                .await?;
                let mut entries = Vec::new();
                while let Some(entry) = found.next().await? {
                    entries.push(match entry.journal {Ok(journal)=>json!({"key":entry.key,"journalId":journal.journal_id(),"scope":journal.scope()}),Err(_)=>json!({"key":entry.key,"error":true})});
                }
                Ok(json!(entries))
            }
            "batch" => {
                let pending = input["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|entry| {
                        let journal = self.handles.get(entry["handle"].as_str().unwrap()).unwrap();
                        journal.append(&entry["frame"])
                    })
                    .collect::<Vec<_>>();
                let mut result = Vec::new();
                for pending in pending {
                    result.push(pending.await?);
                }
                Ok(json!(result))
            }
            "abandon" => {
                let journal = self
                    .handles
                    .get(&handle)
                    .ok_or_else(|| anyhow!("Missing handle"))?;
                let pending = journal.append(&input["frame"]);
                drop(pending);
                journal.head().await
            }
            op => {
                let journal = self
                    .handles
                    .get(&handle)
                    .ok_or_else(|| anyhow!("Missing handle"))?;
                match op {
                    "append" => journal.append(&input["frame"]).await,
                    "read" => Ok(json!(
                        journal
                            .read(
                                input["after"].as_u64().unwrap_or(0),
                                input["limit"].as_u64().unwrap_or(128)
                            )
                            .await?
                    )),
                    "head" => journal.head().await,
                    _ => bail!("Unknown fixture operation"),
                }
            }
        }
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut fixture = Fixture {
        service: Arc::new(Keys(Mutex::new(
            json!({"owner":"owner","server":"server","revision":1}),
        ))),
        handles: HashMap::new(),
        outboxes: HashMap::new(),
        tracker: Tracker::default(),
        projections: history_projection::Engine::default(),
    };
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|e| anyhow!("{}", e.lossy()))?;
        let result = match fixture.run(input).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        println!("{}", result.stringify());
        io::stdout().flush()?;
    }
    Ok(())
}
