//! Native source of external Codex history and encrypted attachment relay.
mod attachments;
mod catalog;
mod sync;

use crate::{
    codex::{
        discovery,
        external_home::{self, Home, Homes},
        rpc_client::Client,
    },
    encryption::Service,
    filesystem::{Scope, paths},
    http::checked,
    native_items::slice,
    routing::Registry,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_config::Environment;
use cantrip_crypto::content::encrypt_private_label;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

const DISCOVER: &str = "external.chat-history.discover";
const READ: &str = "external.chat-history.read";
const CHUNK: &str = "external.chat-history.attachment.read";
const RELEASE: &str = "external.chat-history.attachments.release";
const MAX_THREADS: usize = 5_000;
type Key = (JsString, JsString);
type Queue = tokio::sync::Mutex<()>;

pub(crate) fn supports(kind: &str) -> bool {
    matches!(kind, DISCOVER | READ | CHUNK | RELEASE)
}

pub(crate) struct Manager {
    homes: Homes,
    binary: PathBuf,
    cwd: PathBuf,
    environment: Environment,
    version: Option<JsString>,
    attachments: Arc<attachments::Store>,
    queues: Mutex<HashMap<Key, Weak<Queue>>>,
}

impl Manager {
    pub(crate) fn new(
        binary: &Path,
        data: &Path,
        cwd: &Path,
        environment: &Environment,
        version: &Value,
    ) -> Self {
        Self {
            homes: Homes::new(data, cwd, environment),
            binary: binary.to_owned(),
            cwd: cwd.to_owned(),
            environment: environment.clone(),
            version: version.as_js_string().cloned(),
            attachments: Arc::new(attachments::Store::new(data)),
            queues: Mutex::default(),
        }
    }

    pub(crate) async fn execute(
        &self,
        command: &Value,
        registry: &Registry,
        service: Arc<Service>,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        let kind = command["type"]
            .as_str()
            .context("Missing external history command.")?;
        if kind == DISCOVER {
            let resolved = registry.resolve(command).await?;
            return self.discover(&resolved, scope).await;
        }
        let key = (
            catalog::field(command, "sourceId")?.clone(),
            catalog::field(command, "sourceThreadId")?.clone(),
        );
        let queue = {
            let mut queues = self.queues.lock().unwrap();
            queues.retain(|_, queue| queue.strong_count() != 0);
            let queue = queues.get(&key).and_then(Weak::upgrade).unwrap_or_default();
            queues.insert(key, Arc::downgrade(&queue));
            queue
        };
        let _owned = tokio::select! {
            _ = scope.stopped() => bail!("External chat history stopped."),
            guard = queue.lock() => guard,
        };
        scope.check()?;
        if kind == READ {
            let resolved = registry.resolve(command).await?;
            return self.read(&resolved, service, scope).await;
        }
        let store = self.attachments.clone();
        let command = command.clone();
        tokio::task::spawn_blocking(move || {
            if command["type"] == CHUNK {
                store.read(&command, &service)
            } else {
                store.release(&command)?;
                Ok(json!({"accepted":true}))
            }
        })
        .await?
    }

    fn tested(&self) -> bool {
        self.version
            .as_ref()
            .and_then(discovery::semantic)
            .as_ref()
            .is_some_and(discovery::tested)
    }

    async fn client(&self, home: &Home) -> Result<Client> {
        let client = Client::spawn(
            &self.binary,
            &home.path,
            &self.cwd,
            &self.environment,
            Duration::from_secs(20),
        )
        .await?;
        if let Err(error) = client
            .initialize(
                "cantrip_external_history_reader",
                "Cantrip External History Reader",
                "1.0.0",
                true,
            )
            .await
        {
            let _ = client.close().await;
            return Err(error);
        }
        Ok(client)
    }

    async fn discover(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let sources = if external_home::supported() {
            let targets = catalog::targets(&command["targets"], scope).await?;
            let homes = self.homes.candidates().await;
            let archived = command["includeArchived"] == true;
            let mut pending = Vec::with_capacity(homes.len());
            for home in &homes {
                pending.push(self.source(home, &targets, archived, scope));
            }
            futures::future::join_all(pending).await
        } else {
            Vec::new()
        };
        scope.check()?;
        checked(
            "externalChatDiscoveryWorkerResultSchema",
            &json!({
                "truncated":sources.iter().any(|source| source["truncated"] == true),"sources":sources,
            }),
        )
    }

    async fn source(
        &self,
        home: &Home,
        targets: &[catalog::Target],
        archived: bool,
        scope: &Scope,
    ) -> Value {
        let mut result = json!({"kind":"chatgpt-codex","sourceId":home.fingerprint,"name":"ChatGPT Codex",
            "platform":crate::platform::platform(),"homeLabel":home.label,"runtimeVersion":self.version.as_ref().map(|text| slice(text, 0, 100)),
            "threads":Vec::<Value>::new(),"message":Value::Null,"truncated":false});
        let (status, message) = if !home.present {
            (
                "unavailable",
                Some("No local Codex history store was found."),
            )
        } else if !self.tested() {
            (
                "incompatible",
                Some("The bundled Codex reader is outside Cantrip's tested range."),
            )
        } else {
            match self.list(home, targets, archived, scope).await {
                Ok((threads, truncated)) => {
                    result["threads"] = json!(threads);
                    result["truncated"] = json!(truncated);
                    ("available", None)
                }
                Err(_) => (
                    "incompatible",
                    Some("Cantrip could not safely read this Codex history store."),
                ),
            }
        };
        result["availability"] = json!(status);
        result["message"] = json!(message);
        result
    }

    async fn list(
        &self,
        home: &Home,
        targets: &[catalog::Target],
        archived: bool,
        scope: &Scope,
    ) -> Result<(Vec<Value>, bool)> {
        let client = self.client(home).await?;
        let listing = async {
            let (active, active_truncated) = list_pages(&client, false, MAX_THREADS).await?;
            let (archived, archived_truncated) =
                if archived && !active_truncated && active.len() < MAX_THREADS {
                    list_pages(&client, true, MAX_THREADS - active.len()).await?
                } else {
                    (Vec::new(), false)
                };
            let mut matches = HashMap::new();
            for (archive, threads) in [(false, active), (true, archived)] {
                for thread in threads {
                    if let Some(meta) = catalog::metadata(&thread, archive, targets)? {
                        matches.insert(catalog::field(&meta, "sourceThreadId")?.clone(), meta);
                    }
                }
            }
            let mut matched = matches.into_values().collect::<Vec<_>>();
            matched.sort_by(|a, b| {
                b["updatedAt"]
                    .as_str()
                    .cmp(&a["updatedAt"].as_str())
                    .then_with(|| {
                        a["sourceThreadId"]
                            .as_str()
                            .cmp(&b["sourceThreadId"].as_str())
                    })
            });
            let truncated = active_truncated || archived_truncated || matched.len() > MAX_THREADS;
            matched.truncate(MAX_THREADS);
            Ok((matched, truncated))
        };
        let result = tokio::select! {
            _ = scope.stopped() => Err(anyhow::anyhow!("External chat history stopped.")),
            result = listing => result,
        };
        let closed = client.close().await;
        result.and_then(|value| closed.map(|()| value))
    }

    async fn read(&self, command: &Value, service: Arc<Service>, scope: &Scope) -> Result<Value> {
        ensure!(
            external_home::supported(),
            "External Codex history is not supported on this platform."
        );
        ensure!(
            self.tested(),
            "The bundled Codex reader is outside Cantrip's tested range."
        );
        let bound = service.bound_identity()?;
        ensure!(
            command["ownerId"].as_js_string() == Some(&bound.0),
            "External history owner does not match this worker."
        );
        let home = self
            .homes
            .available()
            .await
            .into_iter()
            .find(|home| command["sourceId"] == home.fingerprint.as_str())
            .context("The selected Codex history source was not found.")?;
        let targets = catalog::targets(&command["targets"], scope).await?;
        let client = self.client(&home).await?;
        let fetched = tokio::select! {
            _ = scope.stopped() => Err(anyhow::anyhow!("External chat history stopped.")),
            result = rpc(&client, "thread/read", json!({"threadId":command["sourceThreadId"],"includeTurns":true})) => result,
        };
        let closed = client.close().await;
        let thread = fetched?["thread"].clone();
        closed?;
        ensure!(
            thread["id"] == command["sourceThreadId"] && thread["turns"].is_array(),
            "Codex returned an invalid thread/read response."
        );
        let Some(mut metadata) = catalog::metadata(&thread, false, &targets)? else {
            bail!(
                "The selected Codex chat no longer belongs to this project or is not safe to import."
            );
        };
        let title = metadata["title"].clone();
        if let Value::Object(fields) = &mut metadata {
            for key in ["archived", "existingImport", "title"] {
                fields.shift_remove(&JsString::from(key));
            }
        }
        let mut roots = targets
            .iter()
            .flat_map(catalog::Target::roots)
            .map(Path::to_owned)
            .collect::<Vec<_>>();
        let temporary = std::env::temp_dir();
        roots.push(paths::canonical(&temporary).await.unwrap_or(temporary));
        let command = command.clone();
        let attachments = self.attachments.clone();
        let scope = scope.clone();
        tokio::task::spawn_blocking(move || {
            let result = (|| {
                scope.check()?;
                ensure!(service.bound_identity()? == bound, "The worker binding changed during external import.");
                let descriptors = attachments.stage_thread(&command, &thread, &roots, service.clone(), &scope)?;
                let sync = sync::sync(&thread, &metadata["cwd"], &descriptors)?;
                let grant = service.bound_component("private-surface-metadata", None)?;
                ensure!((grant.owner_id.clone(), grant.server_id.clone()) == bound && service.bound_identity()? == bound,
                    "The worker binding changed during external import.");
                let title = encrypt_private_label(&grant.component.key, &json!({
                    "ownerId":grant.owner_id,"keyRevision":grant.component.key_revision,
                    "recordKind":"chat","rowId":command["chatId"],
                }), &title)?;
                checked("externalChatReadWorkerResultSchema", &json!({"transcript":json!({
                    "sourceId":command["sourceId"],"sourceThreadId":command["sourceThreadId"],"metadata":metadata,
                    "titleProtection":title,"sync":sync,"attachments":descriptors,
                })}))
            })();
            if result.is_err() {
                let _ = attachments.release(&command);
            }
            result
        }).await?
    }
}

async fn rpc(client: &Client, method: &str, params: Value) -> Result<Value> {
    let response = client.request(method.into(), Some(params)).await?;
    if let Some(message) = response["error"]["message"].as_js_string() {
        return Err(crate::error::WireError(slice(message, 0, 2_000)).into());
    }
    Ok(response["result"].clone())
}

async fn list_pages(client: &Client, archived: bool, maximum: usize) -> Result<(Vec<Value>, bool)> {
    let mut threads = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = HashSet::new();
    for _ in 0..50 {
        let page = rpc(client, "thread/list", json!({
            "cursor":cursor,"limit":100.min(maximum - threads.len()),"sortKey":"updated_at","sortDirection":"desc",
            "sourceKinds":vec!["cli","vscode"],"archived":archived,"useStateDbOnly":true,
        })).await?;
        let data = page["data"]
            .as_array()
            .context("Codex returned an invalid thread/list response.")?;
        ensure!(
            page.get("nextCursor")
                .is_some_and(|value| value.is_null() || value.is_string()),
            "Codex returned an invalid thread/list response."
        );
        for thread in data {
            catalog::validate_thread(thread)?;
        }
        threads.extend(data.iter().cloned());
        threads.truncate(maximum);
        let next = page["nextCursor"]
            .as_js_string()
            .filter(|next| !next.is_empty());
        let Some(next) = next else {
            return Ok((threads, false));
        };
        ensure!(
            seen.insert(next.clone()),
            "Codex repeated an external history cursor."
        );
        if threads.len() >= maximum {
            return Ok((threads, true));
        }
        cursor = json!(next);
    }
    Ok((threads, !cursor.is_null()))
}
