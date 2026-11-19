//! Immutable, account-scoped evidence of an actual native checkpoint. Opening
//! a record proves its source and location and grants no execution authority.
use crate::encryption::Service;
use anyhow::{Context, Result, anyhow, bail};
use cantrip_crypto::content::{
    NativeResourceComponent as Component, open_native_suspension_source,
    seal_native_suspension_source,
};
use cantrip_history::{
    files::{ensure_directory, flush_directory, queue, read_json, write_immutable},
    source_digest,
};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

const SOURCE: &str = "nativeSuspensionSourceSchema";
const SCOPE: &str = "nativeSuspensionStorageScopeSchema";
const SNAPSHOT: &str = "nativeSuspensionStorageSnapshotSchema";
const RECORD: &str = "nativeSuspensionStorageRecordSchema";

#[derive(Clone)]
pub struct Store {
    directory: PathBuf,
    encryption: Arc<Service>,
}

pub struct Commit<'a> {
    pub source: &'a Value,
    pub home: &'a Path,
    pub suspension: &'a Value,
    pub runtime_version: &'a Value,
    pub runtime_fingerprint: &'a Value,
    pub continuation: Option<&'a Value>,
    pub task_continuation: Option<&'a Value>,
    pub binding: Option<(&'a JsString, &'a JsString)>,
}

pub struct Opened {
    pub evidence: Value,
    pub source: Value,
    pub home: PathBuf,
    pub continuation: Value,
    pub task_continuation: Option<Value>,
}

impl Store {
    pub fn new(directory: &Path, encryption: Arc<Service>) -> Self {
        Self {
            directory: directory.join("native-turn-suspensions"),
            encryption,
        }
    }

    fn scope(&self) -> Result<Value> {
        let (owner, server) = self.encryption.bound_identity()?;
        validate(
            SCOPE,
            &json!({"serverId":server,"ownerId":owner,"workerId":self.encryption.worker_id()}),
        )
    }

    fn assert_scope(&self, scope: &Value) -> Result<()> {
        if &self.scope()? != scope {
            bail!("Native suspension ownership changed during persistence.");
        }
        Ok(())
    }

    fn directory(&self, scope: &Value, chat: &Value) -> PathBuf {
        self.directory
            .join(source_digest(scope))
            .join(source_digest(chat))
    }

    fn protection(
        &self,
        scope: &Value,
        component: Component,
        revision: Option<u64>,
    ) -> Result<(Value, crate::encryption::ComponentKey)> {
        let grant = self
            .encryption
            .bound_component(component.name(), revision)?;
        if scope["ownerId"].as_js_string() != Some(&grant.owner_id)
            || scope["serverId"] != grant.server_id
        {
            bail!("Native suspension ownership changed during persistence.");
        }
        let registration = self.encryption.registration();
        let principal = registration["principalId"]
            .as_js_string()
            .context("Native suspension worker principal")?;
        Ok((
            json!({
                "ownerId":grant.owner_id,"serverId":grant.server_id,"principalId":principal,
                "keyRevision":grant.component.key_revision,
            }),
            grant.component,
        ))
    }

    pub async fn open(&self, id: &str, source: &Value) -> Result<Opened> {
        let source = validate(SOURCE, source)?;
        let scope = self.scope()?;
        let path = self.directory(&scope, &source["chatId"]);
        let store = self.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || store.open_at(&path, &scope, &source, &id)).await?
    }

    fn open_at(&self, directory: &Path, scope: &Value, source: &Value, id: &str) -> Result<Opened> {
        let record = read_record(directory, scope, &source["chatId"], id)?;
        let opened = self.open_record(&record, source)?;
        self.assert_scope(scope)?;
        Ok(opened)
    }

    fn open_record(&self, record: &Value, source: &Value) -> Result<Opened> {
        let component = component(source);
        let binding = &record["evidence"]["suspension"];
        let envelope = component.envelope(&record["protectedSource"])?;
        let revision = envelope["keyRevision"]
            .as_u64()
            .context("Native suspension key revision")?;
        let (context, key) = self.protection(&record["scope"], component, Some(revision))?;
        let snapshot = open_native_suspension_source(
            &key.key,
            &context,
            component,
            binding,
            &record["protectedSource"],
        )?;
        let snapshot = validate(SNAPSHOT, &snapshot)?;
        if snapshot["scope"] != record["scope"]
            || snapshot["version"] != record["version"]
            || &snapshot["source"] != source
            || &snapshot["suspension"] != binding
        {
            bail!("Native suspension belongs to a different source.");
        }
        let home = snapshot["home"]
            .as_str()
            .context("Invalid native suspension home.")?;
        Ok(Opened {
            evidence: record["evidence"].clone(),
            source: snapshot["source"].clone(),
            home: home.into(),
            continuation: snapshot["continuation"].clone(),
            task_continuation: snapshot.get("task").cloned(),
        })
    }

    pub async fn commit(&self, input: Commit<'_>) -> Result<Value> {
        let source = validate(SOURCE, input.source)?;
        let scope = self.scope()?;
        if input.binding.is_some_and(|(owner, server)| {
            scope["ownerId"].as_js_string() != Some(owner)
                || scope["serverId"].as_js_string() != Some(server)
        }) {
            bail!("Native suspension ownership changed during persistence.");
        }
        let suspension = validate("nativeTurnSuspensionSchema", input.suspension)?;
        if source["threadId"] != suspension["threadId"] {
            bail!("Native suspension belongs to a different native thread.");
        }
        if let Some(continuation) = input.continuation
            && (continuation["threadId"] != suspension["threadId"]
                || continuation["turnId"] != suspension["turnId"]
                || continuation["chatId"] != source["chatId"])
        {
            bail!("Worker bookkeeping belongs to another native suspension.");
        }
        let component = component(&source);
        if (component == Component::Task) != input.task_continuation.is_some()
            || (input.task_continuation.is_some() && input.continuation.is_none())
        {
            bail!("Task checkpoints require their original round and worker continuation.");
        }
        for (receipt, worker) in [
            (&source["taskInput"], &source["taskInput"]["workerId"]),
            (
                &source["taskGoalCycle"],
                &source["taskGoalCycle"]["parent"]["workerId"],
            ),
        ] {
            if !receipt.is_null() && worker != &scope["workerId"] {
                bail!("Task checkpoint belongs to another worker.");
            }
        }
        let home = cantrip_config::resolve(&std::env::current_dir()?, input.home);
        let home_text = home.to_str().context("Invalid native suspension home.")?;
        let version = match (input.task_continuation, input.continuation) {
            (Some(_), _) => 3,
            (None, Some(_)) => 2,
            _ => 1,
        };
        let mut snapshot = json!({
            "version":version,"scope":scope,"source":source,"suspension":suspension,"home":home_text,
        });
        if let Some(continuation) = input.continuation {
            snapshot["continuation"] = continuation.clone();
        }
        if let Some(task) = input.task_continuation {
            snapshot["task"] = task.clone();
        }
        let snapshot = validate(SNAPSHOT, &snapshot)?;
        let id = storage_id(&scope, &source["chatId"], &suspension, &json!(version));
        let directory = self.directory(&scope, &source["chatId"]);
        let store = self.clone();
        let diagnostic_version = input.runtime_version.clone();
        let diagnostic_fingerprint = input.runtime_fingerprint.clone();
        queue(&directory)
            .run(move || {
                store.assert_scope(&scope)?;
                match read_record(&directory, &scope, &source["chatId"], &id) {
                    Ok(record) => {
                        let opened = store.open_record(&record, &source)?;
                        let evidence = same_home(opened, &home)?;
                        // A failed prior publication can have installed the link
                        // before the directory became durable.
                        flush_directory(&directory)?;
                        store.assert_scope(&scope)?;
                        return Ok(evidence);
                    }
                    Err(error) if missing(&error) => {}
                    Err(error) => return Err(error),
                }
                let evidence = validate(
                    "nativeSuspensionEvidenceSchema",
                    &json!({
                        "suspension":suspension, "storageId":id,
                        "runtimeVersion":diagnostic_version, "runtimeFingerprint":diagnostic_fingerprint,
                    }),
                )?;
                let (context, key) = store.protection(&scope, component, None)?;
                let protected = seal_native_suspension_source(
                    &key.key, &context, component, &suspension, &snapshot,
                )?;
                store.assert_scope(&scope)?;
                ensure_directory(&directory)?;
                write_immutable(
                    &directory.join(format!("{id}.json")),
                    &json!({
                        "version":version,"scope":scope,"chatId":source["chatId"],
                        "evidence":evidence,"protectedSource":protected,
                    })
                    .stringify(),
                )?;
                // Another process can win the exclusive link. Authenticate the
                // bytes that were actually published before acknowledging them.
                let opened = store.open_at(&directory, &scope, &source, &id)?;
                same_home(opened, &home)
            })
            .await
    }
}

fn component(source: &Value) -> Component {
    if source["taskInput"].is_null() && source["taskGoalCycle"].is_null() {
        Component::Chat
    } else {
        Component::Task
    }
}

fn validate(schema: &'static str, value: &Value) -> Result<Value> {
    // Validation issues on private continuations can carry snapshot content.
    cantrip_protocol::parse(schema, Some(value))
        .map_err(|_| anyhow!("Invalid native suspension data ({schema})."))
}

fn storage_id(scope: &Value, chat: &Value, suspension: &Value, version: &Value) -> String {
    let input = json!([
        json!("cantrip-native-suspension"),
        version.clone(),
        scope.clone(),
        chat.clone(),
        suspension.clone()
    ]);
    let digest = Sha256::digest(input.stringify().as_bytes());
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn read_record(directory: &Path, scope: &Value, chat: &Value, id: &str) -> Result<Value> {
    if !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        bail!("Invalid native suspension storage identity.");
    }
    let record = read_json(&directory.join(format!("{id}.json"))).map_err(|error| {
        if error.downcast_ref::<io::Error>().is_some() {
            error
        } else {
            anyhow!("Invalid native suspension record JSON.")
        }
    })?;
    let record = validate(RECORD, &record)?;
    if &record["scope"] != scope
        || &record["chatId"] != chat
        || record["evidence"]["storageId"] != id
        || storage_id(
            scope,
            chat,
            &record["evidence"]["suspension"],
            &record["version"],
        ) != id
    {
        bail!("Native suspension storage identity mismatch.");
    }
    Ok(record)
}

fn same_home(opened: Opened, home: &Path) -> Result<Value> {
    // Path equality on Rust lexically normalizes additional separators.
    if opened.home.as_os_str() != home.as_os_str() {
        bail!("Native suspension home changed.");
    }
    Ok(opened.evidence)
}

pub(super) fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
}
