//! Calls from an authorized external MCP channel use the canonical server
//! services. Application encryption and transcript projection stay here.
use crate::{chat_content, config::Config, encryption::Service};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::{blind_lookup_tag, content::encrypt_private_label, derive_lookup_key};
use cantrip_protocol::external_mcp::orchestration::{
    CORE_PATH, Call, CoreCall, CoreOperation, WaitMode, resource_id,
};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{Instant, sleep_until};
use uuid::Uuid;

mod transcript;

#[derive(Clone)]
pub(in crate::worker_link) struct Client {
    http: reqwest::Client,
    config: Arc<Mutex<Config>>,
}

impl Client {
    pub fn new(config: Arc<Mutex<Config>>) -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(12))
                .build()?,
            config,
        })
    }

    pub async fn run(
        &self,
        binding: &Value,
        encryption: Arc<Service>,
        call: Call,
    ) -> Result<Value> {
        let started = Instant::now();
        let mut output = match &call {
            Call::AgentRead { .. } => {
                let mut reply = self.chat(binding, 10, None).await?;
                transcript::project(&encryption, &mut reply)?;
                reply["messages"] = json!(Vec::<Value>::new());
                reply["summary"] = json!("Read Agent chat and recent native subagents.");
                reply
            }
            Call::ChatRead {
                limit,
                before_sequence,
                ..
            } => {
                let mut reply = self.chat(binding, *limit, *before_sequence).await?;
                transcript::project(&encryption, &mut reply)?;
                reply["summary"] = json!("Read Agent chat updates.");
                reply
            }
            Call::ChatWait {
                after_cursor,
                timeout_ms,
                ..
            } => {
                let deadline = started + Duration::from_millis(*timeout_ms);
                loop {
                    let mut reply = self.chat(binding, 10, None).await?;
                    let changed = reply["cursor"] != after_cursor.as_str();
                    if changed || Instant::now() >= deadline {
                        transcript::project(&encryption, &mut reply)?;
                        reply["timedOut"] = json!(!changed);
                        reply["summary"] = json!(if changed {
                            "The Agent chat changed."
                        } else {
                            "The chat wait timed out."
                        });
                        break reply;
                    }
                    poll_at(deadline).await;
                }
            }
            Call::TaskStatus { task_ids, .. } => {
                let mut reply = self
                    .request(
                        binding,
                        CoreOperation::Tasks {
                            task_ids: task_ids.clone(),
                        },
                    )
                    .await?;
                reply["summary"] = json!("Read Task status.");
                reply
            }
            Call::TaskWait {
                task_ids,
                after_cursor,
                timeout_ms,
                mode,
                ..
            } => {
                let deadline = started + Duration::from_millis(*timeout_ms);
                loop {
                    let mut reply = self
                        .request(
                            binding,
                            CoreOperation::Tasks {
                                task_ids: task_ids.clone(),
                            },
                        )
                        .await?;
                    let tasks = reply["tasks"].as_array().context("Task status result")?;
                    let completed = tasks.iter().filter(|task| task["terminal"] == true).count();
                    let done = match mode {
                        WaitMode::Any => completed > 0,
                        WaitMode::All => completed == task_ids.len(),
                    };
                    let changed = after_cursor
                        .as_deref()
                        .is_some_and(|cursor| reply["cursor"] != cursor);
                    let unavailable = reply["missingTaskIds"]
                        .as_array()
                        .is_some_and(|ids| !ids.is_empty());
                    if done || changed || unavailable || Instant::now() >= deadline {
                        let timed_out = !done && !changed && !unavailable;
                        reply["timedOut"] = json!(timed_out);
                        reply["satisfied"] = json!(done);
                        reply["summary"] = json!(if timed_out {
                            "The Task wait timed out."
                        } else {
                            "Read Task updates."
                        });
                        break reply;
                    }
                    poll_at(deadline).await;
                }
            }
            Call::AgentCreate { operation_id, .. }
            | Call::TaskCreate { operation_id, .. }
            | Call::TaskStart { operation_id, .. }
            | Call::ChatSend { operation_id, .. } => {
                self.write(binding, &encryption, &call, *operation_id)
                    .await?
            }
        };
        output["projectId"] = json!(call.project());
        Ok(output)
    }

    async fn chat(
        &self,
        binding: &Value,
        limit: u16,
        before_sequence: Option<u64>,
    ) -> Result<Value> {
        self.request(
            binding,
            CoreOperation::Chat {
                limit,
                before_sequence,
            },
        )
        .await
    }

    async fn write(
        &self,
        binding: &Value,
        service: &Arc<Service>,
        call: &Call,
        operation_id: Uuid,
    ) -> Result<Value> {
        let prepared = self
            .request(binding, CoreOperation::Prepare { operation_id })
            .await?;
        let owner = prepared["ownerId"].as_str().context("Operation owner")?;
        let principal = prepared["principalId"]
            .as_str()
            .context("Operation principal")?;
        ensure!(
            binding["identity"]["ownerId"] == owner,
            "Cantrip returned another operation owner."
        );
        let component = match call {
            Call::AgentCreate { .. } => "private-surface-metadata",
            Call::ChatSend { .. } => "chat-content",
            _ => "task-content",
        };
        let key = service.bound_component(component, prepared["keyRevision"].as_u64())?;
        ensure!(
            key.owner_id.as_str() == Some(owner),
            "The worker account changed."
        );
        let revision = key.component.key_revision;
        let lookup = derive_lookup_key(
            &key.component.key,
            &json!({
                "ownerId":owner,"component":component,"keyRevision":revision,
                "table":"external_mcp_operation_receipts","field":"fingerprint",
            }),
        )?;
        let canonical = Value::from_serialize(call);
        let fingerprint = blind_lookup_tag(
            &lookup,
            &json!([json!(principal), json!(operation_id), canonical])
                .stringify()
                .into(),
        )?;
        let id = |kind: &str| resource_id(owner, principal, operation_id, kind).to_string();
        let title = |chat: &str, name: &str| {
            let labels = service.bound_component("private-surface-metadata", None)?;
            ensure!(
                labels.owner_id.as_str() == Some(owner),
                "The worker account changed."
            );
            encrypt_private_label(
                &labels.component.key,
                &json!({"ownerId":owner,"keyRevision":labels.component.key_revision,"recordKind":"chat","rowId":chat}),
                &json!(name),
            )
        };
        let worktree = &binding["resource"]["attachmentId"];
        let wire = match call {
            Call::AgentCreate { title: name, .. } => {
                let chat = id("agent");
                json!({"id":chat,"titleProtection":title(&chat, name.as_deref().unwrap_or("New agent"))?,
                    "autoTitle":name.is_none(),"attachToTabLayout":false,"worktreeId":worktree})
            }
            Call::ChatSend { message, .. } => {
                let label = prepared["label"].as_str().context("Operation label")?;
                let mut draft = prepared["configuration"].clone();
                draft["idempotencyKey"] = json!(format!("external-mcp:{principal}:{operation_id}"));
                draft["messageId"] = json!(id("message"));
                draft["promptId"] = json!(id("prompt"));
                draft["mode"] = json!("default");
                draft["text"] = json!(format!("Message from {label} via Cantrip MCP\n\n{message}"));
                let scope = chat_content::Scope::new(service.clone())?;
                chat_content::turn_with_attachments(&scope, &draft, &[])?
            }
            Call::TaskCreate {
                title: name,
                description,
                start,
                ..
            } => {
                let chat = id("task");
                let label = name.as_deref().unwrap_or("New task");
                let content = crate::task_content::initial(&json!(description))?;
                let task = crate::task_content::opaque(
                    cantrip_crypto::content::Communication::Task,
                    &key.component.key,
                    &json!({"ownerId":owner,"keyRevision":revision,"chatId":chat}),
                    &content,
                )?;
                json!({"start":start,"create":json!({
                    "chatId":chat,"worktreeId":worktree,"titleProtection":title(&chat,label)?,
                    "autoTitle":name.is_none(),"planGoalEnabled":false,"task":task,
                })})
            }
            Call::TaskStart { .. } => json!({}),
            _ => unreachable!("Validated write"),
        };
        self.request(
            binding,
            CoreOperation::commit(
                operation_id,
                i32::try_from(revision)?,
                fingerprint,
                &wire.stringify(),
            )?,
        )
        .await
    }

    async fn request(&self, binding: &Value, operation: CoreOperation) -> Result<Value> {
        let identity = &binding["identity"];
        let worker = identity["workerId"].as_str().context("Worker identity")?;
        let session = binding["sessionId"]
            .as_str()
            .context("WorkerLink session")?;
        let grant = binding["grantId"].as_str().context("WorkerLink grant")?;
        let (mut url, token) = {
            let config = self.config.lock().unwrap();
            ensure!(
                config.worker_id.as_str() == Some(worker),
                "The worker identity changed."
            );
            (
                url::Url::parse(&config.server_url)?.join(CORE_PATH)?,
                config.token.clone(),
            )
        };
        url.path_segments_mut()
            .map_err(|_| anyhow!("Invalid Cantrip Server origin."))?
            .extend([worker, session, grant]);
        let worker_generation = identity["workerProcessGeneration"]
            .as_str()
            .context("Worker process generation")?
            .to_owned();
        let mut response = self
            .http
            .post(url)
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(
                CoreCall {
                    worker_generation,
                    operation,
                }
                .encode(),
            )
            .send()
            .await?;
        let success = response.status().is_success();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                body.len() + chunk.len() <= 2 * 1024 * 1024,
                "The Cantrip result exceeded its size limit."
            );
            body.extend_from_slice(&chunk);
        }
        let value = parse_json_text(std::str::from_utf8(&body)?)
            .map_err(|_| anyhow!("Invalid Cantrip operation result."))?;
        ensure!(
            success,
            "{}",
            value["error"]
                .as_str()
                .unwrap_or("Cantrip rejected the MCP operation.")
        );
        Ok(value)
    }
}

async fn poll_at(deadline: Instant) {
    sleep_until(deadline.min(Instant::now() + Duration::from_millis(500))).await;
}
