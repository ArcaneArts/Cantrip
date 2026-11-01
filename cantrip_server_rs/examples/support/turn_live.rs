use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository,
        live_mutations::{Dependencies, MessageOptions, RouteSelection, Service},
        message_queries::MessageKind,
    },
    database::Database,
    wire::Value,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("Turn Live fixture text")
}
fn kind(value: &Value) -> MessageKind {
    match value["kind"].as_str() {
        Some("task") => MessageKind::Task,
        Some("plain") => MessageKind::Plain,
        _ => MessageKind::Encrypted,
    }
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let commands = Arc::new(Mutex::new(Vec::new()));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let fixture = input.clone();
    let connected = input["connected"] != false;
    let enabled = input["enabled"] != false;
    let service = Service::with_dependencies(
        database.clone(),
        Dependencies {
            publish: {
                let events = events.clone();
                let fail = input["failHub"] == true;
                Arc::new(move |event| {
                    if fail {
                        anyhow::bail!("Controlled live publication failure")
                    }
                    events.lock().unwrap().push(event);
                    Ok(())
                })
            },
            invalidate: {
                let events = events.clone();
                Arc::new(move |event| events.lock().unwrap().push(event))
            },
            enabled: Arc::new(move || enabled),
            connected: Arc::new(move |_| connected),
            request: {
                let commands = commands.clone();
                Arc::new(move |owner, worker, command| {
                    let (commands, fixture) = (commands.clone(), fixture.clone());
                    async move {
                        commands.lock().unwrap().push(Value::object([
                            ("ownerId", Value::from_serialize(&owner)),
                            ("worker", Value::from_serialize(&worker)),
                            ("command", command.clone()),
                        ]));
                        if fixture["failRequest"] == true {
                            anyhow::bail!("Controlled live protection failure")
                        }
                        if let Some(reply) = fixture.get("protectionReply") {
                            return Ok(Some(reply.clone()));
                        }
                        let mut message = fixture["protectedMessage"].clone();
                        message["id"] = command["message"]["id"].clone();
                        message["idempotencyKey"] = command["message"]["idempotencyKey"].clone();
                        Ok(Some(message))
                    }
                    .boxed()
                })
            },
            logger: {
                let logs = logs.clone();
                Arc::new(move |call| {
                    let mut record = Value::object([
                        ("level", Value::from_serialize(&call.level)),
                        ("message", Value::from_serialize(&call.message)),
                        ("error", Value::Bool(!call.context["err"].is_null())),
                    ]);
                    for key in ["chatId", "messageId", "resource", "requestId"] {
                        if let Some(value) = call.context.get(key) {
                            record[key] = value.clone();
                        }
                    }
                    logs.lock().unwrap().push(record);
                })
            },
        },
    );
    let repository = Repository::new(database.clone());
    let owner = text(input, "owner")?;
    let steps = input["steps"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![input.clone()]);
    let mut results = Vec::new();
    let mut frames = Vec::new();
    for step in steps {
        if let Some(sql) = step["beforeSQL"].as_str() {
            database.query(sql, &[]).await?;
        }
        let chat = step
            .get("chat")
            .or_else(|| input.get("chat"))
            .and_then(Value::as_str)
            .context("Live Chat")?;
        let operation: Result<Value> = async {
            Ok(match text(&step, "action")? {
                "write" => service
                    .write_message(
                        owner,
                        chat,
                        &step["message"],
                        MessageOptions {
                            attribution: step.get("attribution"),
                            kind: kind(&step),
                            upsert: step["upsert"] == true,
                            routing: step.get("routing"),
                        },
                    )
                    .await?
                    .unwrap_or(Value::Null),
                "route" => service
                    .set_route(
                        owner,
                        text(&step, "messageId")?,
                        RouteSelection {
                            model: text(&step, "modelId")?,
                            runtime: &step["runtime"],
                            reasoning: step.get("reasoning"),
                            kind: kind(&step),
                            routing: step.get("routing"),
                        },
                    )
                    .await?
                    .unwrap_or(Value::Null),
                "boundary" => {
                    service.publish_boundary(owner, chat, &step["projectId"], step.get("routing"));
                    Value::Null
                }
                "summary" => {
                    service.publish_summary(
                        owner,
                        &Value::from_serialize(chat),
                        &step["projectId"],
                    );
                    Value::Null
                }
                "progress" => {
                    service.publish_progress(owner, chat, &step["progress"]);
                    Value::Null
                }
                "plan-mode" => service
                    .update_plan_mode(owner, chat, text(&step, "mode")?)
                    .await?
                    .unwrap_or(Value::Null),
                "plan" => {
                    service.update_plan(owner, chat, &step["plan"]).await?;
                    Value::Null
                }
                "interaction-record" => {
                    service
                        .record_interaction(owner, &step["interaction"], step["protected"] != false)
                        .await?
                }
                "interaction-clear" => service
                    .terminalize_interaction(
                        owner,
                        text(&step, "requestKey")?,
                        chat,
                        text(&step, "worker")?,
                        text(&step, "status")?,
                        step.get("resolution"),
                    )
                    .await?
                    .unwrap_or(Value::Null),
                "interaction-interrupt" => Value::Array(
                    service
                        .interrupt_interactions(owner, chat, step["laneId"].as_str())
                        .await?,
                ),
                "storage-plan" => repository
                    .encrypted_plan(owner, chat)
                    .await?
                    .unwrap_or(Value::Null),
                "storage-routing" => repository
                    .live_routing(owner, chat)
                    .await?
                    .unwrap_or(Value::Null),
                "storage-attachments" => Value::Array(
                    repository
                        .prompt_attachments(owner, &step["context"], &step["ids"])
                        .await?,
                ),
                "storage-audiences" => Value::Array(
                    repository
                        .skill_audience_keys(
                            owner,
                            text(&step, "worker")?,
                            text(&step, "provider")?,
                        )
                        .await?,
                ),
                "stub" => cantrip_server::chats::turn_storage::message_stub(&step["message"]),
                _ => anyhow::bail!("Unknown turn Live fixture action"),
            })
        }
        .await;
        let result = match operation {
            Ok(value) => value,
            Err(_) if input["captureErrors"] == true => {
                Value::object([("failed", Value::Bool(true))])
            }
            Err(error) => return Err(error),
        };
        results.push(result);
        frames.push(events.lock().unwrap().len());
        service.drained().await;
    }
    Ok(Value::object([
        ("results", Value::Array(results)),
        ("frames", Value::from_serialize(&frames)),
        ("events", Value::Array(events.lock().unwrap().clone())),
        ("commands", Value::Array(commands.lock().unwrap().clone())),
        ("logs", Value::Array(logs.lock().unwrap().clone())),
    ]))
}
