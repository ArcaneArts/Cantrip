//! Standalone Chat roots, using the existing worker's on-disk registry.
use super::{paths, storage};
use crate::routing::{self, Registry};
use anyhow::{Context, Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{Value, parse_json_text, value::json};
use chrono::{DateTime, Utc};
use std::{
    collections::{BTreeMap, HashSet},
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tokio::{fs, sync::Mutex};

const DIRECTORY: &str = "chat-scratch";
const REGISTRY_FILE: &str = "chat-scratch-registry.json";
const PROVISION: &str = "chat.scratch.provision";
const RESOLVE: &str = "chat.scratch.resolve";
const ARCHIVE: &str = "chat.scratch.archive";
const RESTORE: &str = "chat.scratch.restore";
const DELETE: &str = "chat.scratch.delete";
const RECONCILE: &str = "chat.scratch.reconcile";
const ARCHIVE_RESULT: &str = "standaloneChatScratchArchiveResultSchema";

type Roots = BTreeMap<String, Value>;

pub(crate) struct Manager {
    data: PathBuf,
    commands: Mutex<()>,
}

impl Manager {
    pub(crate) fn new(data: &Path) -> Self {
        Self {
            data: data.to_owned(),
            commands: Mutex::new(()),
        }
    }

    pub(crate) fn supports(kind: &str) -> bool {
        matches!(
            kind,
            PROVISION | RESOLVE | ARCHIVE | RESTORE | DELETE | RECONCILE
        )
    }

    pub(crate) async fn execute_routed(
        &self,
        command: &Value,
        routing: &Registry,
    ) -> Result<Value> {
        let kind = command["type"]
            .as_str()
            .context("Missing scratch command type")?;
        let result = async {
            let result = self.execute(kind, command).await?;
            routing.protect_result(kind, &result).await
        }
        .await;
        result.map_err(|error| routing::protect_error(kind, error))
    }

    // The worker command envelope validates the command before dispatch.
    async fn execute(&self, kind: &str, command: &Value) -> Result<Value> {
        let _guard = self.commands.lock().await;
        let mut roots = self.load().await?;
        if kind == RECONCILE {
            return self.reconcile(&mut roots, command, Utc::now()).await;
        }
        let (root_id, chat_id) = identity(command)?;
        match kind {
            PROVISION => self.provision(&mut roots, command, root_id, chat_id).await,
            DELETE => self.delete(&mut roots, command, root_id, chat_id).await,
            RESOLVE | ARCHIVE | RESTORE => {
                registered(&roots, root_id, chat_id)?;
                let location = self.location(chat_id).await?;
                let path = location.canonical_target().await?;
                if kind == RESOLVE {
                    return checked(
                        "standaloneChatScratchResolveResultSchema",
                        &json!({"rootId":root_id,"chatId":chat_id,"path":paths::text(&path),"displayPath":location.display()}),
                    );
                }
                let record = if kind == ARCHIVE {
                    archive_record(
                        command,
                        &command["archivedAt"],
                        &command["archiveExpiresAt"],
                    )?
                } else {
                    archive_record(command, &Value::Null, &Value::Null)?
                };
                roots.insert(root_id.to_owned(), record.clone());
                self.persist(&roots)?;
                Ok(record)
            }
            _ => bail!("Unsupported standalone Chat scratch command."),
        }
    }

    async fn provision(
        &self,
        roots: &mut Roots,
        command: &Value,
        root_id: &str,
        chat_id: &str,
    ) -> Result<Value> {
        let existing = roots.get(root_id);
        if existing.is_some_and(|record| record["chatId"] != chat_id)
            || roots
                .iter()
                .any(|(id, record)| id != root_id && record["chatId"] == chat_id)
        {
            bail!("Standalone Chat scratch identity conflicts with its registry.");
        }
        let location = self.location(chat_id).await?;
        let reused = directory_exists(&location.target).await?;
        if existing.is_none() {
            if reused {
                bail!("Unregistered standalone Chat scratch target already exists.");
            }
            // Persist the identity before creating its directory so a retry can
            // recover if the process exits between the two writes.
            roots.insert(
                root_id.to_owned(),
                archive_record(command, &Value::Null, &Value::Null)?,
            );
            self.persist(roots)?;
        }
        if !reused {
            storage::make_directory(&location.target, false).await?;
        }
        let path = location.canonical_target().await?;
        checked(
            "standaloneChatScratchProvisionResultSchema",
            &json!({"status":"ready","jobId":command["jobId"],"attempt":command["attempt"],"rootId":root_id,"chatId":chat_id,
                "path":paths::text(&path),"displayPath":location.display(),"reused":reused}),
        )
    }

    async fn delete(
        &self,
        roots: &mut Roots,
        command: &Value,
        root_id: &str,
        chat_id: &str,
    ) -> Result<Value> {
        let location = self.location(chat_id).await?;
        let deleted = directory_exists(&location.target).await?;
        if roots.contains_key(root_id) {
            registered(roots, root_id, chat_id)?;
            if deleted {
                let path = location.canonical_target().await?;
                fs::remove_dir_all(path).await?;
            }
            roots.remove(root_id);
            self.persist(roots)?;
        } else if deleted {
            bail!("Refusing to delete an unregistered Chat scratch target.");
        }
        checked(
            "standaloneChatScratchDeleteResultSchema",
            &json!({"jobId":command["jobId"],"attempt":command["attempt"],"rootId":root_id,"chatId":chat_id,"deleted":deleted}),
        )
    }

    async fn reconcile(
        &self,
        roots: &mut Roots,
        command: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value> {
        let mut authoritative = HashSet::new();
        let mut retained = Vec::new();
        let mut missing = Vec::new();
        let mut due = Vec::new();
        for target in command["roots"]
            .as_array()
            .context("Missing scratch inventory")?
        {
            let (root_id, chat_id) = identity(target)?;
            authoritative.insert(root_id);
            if registered(roots, root_id, chat_id).is_err() {
                missing.push(root_id);
                continue;
            }
            let location = self.location(chat_id).await?;
            if !directory_exists(&location.target).await? {
                missing.push(root_id);
                continue;
            }
            location.canonical_target().await?;
            let record =
                archive_record(target, &target["archivedAt"], &target["archiveExpiresAt"])?;
            if let Some(expiry) = record["archiveExpiresAt"].as_str()
                && DateTime::parse_from_rfc3339(expiry)?.timestamp_millis()
                    <= now.timestamp_millis()
            {
                due.push(root_id);
            }
            roots.insert(root_id.to_owned(), record);
            retained.push(root_id);
        }
        let orphaned = roots
            .keys()
            .filter(|id| !authoritative.contains(id.as_str()))
            .collect::<Vec<_>>();
        retained.sort_unstable();
        missing.sort_unstable();
        due.sort_unstable();
        self.persist(roots)?;
        checked(
            "standaloneChatScratchReconciliationResultSchema",
            &json!({"retainedRootIds":retained,"missingRootIds":missing,"orphanedRootIds":orphaned,"dueRootIds":due}),
        )
    }

    async fn location(&self, chat_id: &str) -> Result<Location> {
        let root = self.data.join(DIRECTORY);
        storage::make_directory(&root, true).await?;
        if !directory_exists(&root).await? {
            bail!("Standalone Chat scratch root is missing.");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let root = paths::canonical(&root).await?;
        Ok(Location {
            target: root.join(chat_id),
            root,
            display: Path::new(DIRECTORY).join(chat_id),
        })
    }

    async fn load(&self) -> Result<Roots> {
        let content = match fs::read_to_string(self.data.join(REGISTRY_FILE)).await {
            Ok(content) => content,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Roots::new()),
            Err(error) => return Err(error.into()),
        };
        let value = parse_json_text(&content)
            .map_err(|_| anyhow::anyhow!("Invalid standalone Chat scratch registry."))?;
        if value["version"].as_u64() != Some(1) || value.as_object().map(|o| o.len()) != Some(2) {
            bail!("Invalid standalone Chat scratch registry.");
        }
        let mut roots = Roots::new();
        let mut chats = HashSet::new();
        for item in value["roots"]
            .as_array()
            .context("Invalid standalone Chat scratch registry")?
        {
            let record = checked(ARCHIVE_RESULT, item)?;
            let (root_id, chat_id) = identity(&record)?;
            if !chats.insert(chat_id.to_owned())
                || roots.insert(root_id.to_owned(), record).is_some()
            {
                bail!("Duplicate standalone Chat scratch registry identity.");
            }
        }
        Ok(roots)
    }

    fn persist(&self, roots: &Roots) -> Result<()> {
        let path = self.data.join(REGISTRY_FILE);
        let temp = self
            .data
            .join(format!("{REGISTRY_FILE}.{}.tmp", uuid::Uuid::new_v4()));
        let content = json!({"version":1,"roots":roots.values().collect::<Vec<_>>()});
        let result = (|| {
            cantrip_host::files::private_directory(&self.data)?;
            cantrip_host::files::write_private(
                &temp,
                format!("{}\n", content.stringify()).as_bytes(),
            )?;
            std::fs::rename(&temp, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
}

fn identity(value: &Value) -> Result<(&str, &str)> {
    let root = value["rootId"]
        .as_str()
        .context("Missing scratch root identity")?;
    let chat = value["chatId"].as_str().context("Missing Chat identity")?;
    Ok((root, chat))
}

fn registered(roots: &Roots, root_id: &str, chat_id: &str) -> Result<()> {
    if roots
        .get(root_id)
        .is_none_or(|record| record["chatId"] != chat_id)
    {
        bail!("Standalone Chat scratch identity is not registered.");
    }
    Ok(())
}

fn archive_record(identity: &Value, archived_at: &Value, expires_at: &Value) -> Result<Value> {
    checked(
        ARCHIVE_RESULT,
        &json!({"rootId":identity["rootId"],"chatId":identity["chatId"],"archivedAt":archived_at,"archiveExpiresAt":expires_at}),
    )
}

async fn directory_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path).await {
        Ok(entry) if entry.is_dir() && !entry.file_type().is_symlink() => Ok(true),
        Ok(_) => bail!("Standalone Chat scratch storage is not a safe directory."),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

struct Location {
    root: PathBuf,
    target: PathBuf,
    display: PathBuf,
}
impl Location {
    async fn canonical_target(&self) -> Result<PathBuf> {
        if !directory_exists(&self.target).await? {
            bail!("Standalone Chat scratch target is missing.");
        }
        let path = paths::canonical(&self.target).await?;
        if !paths::equal(&path, &self.target) || path.parent() != Some(self.root.as_path()) {
            bail!("Standalone Chat scratch target escaped its storage root.");
        }
        Ok(path)
    }

    fn display(&self) -> cantrip_wire::JsString {
        paths::text(&self.display)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "11111111-1111-4111-8111-111111111111";
    const CHAT: &str = "22222222-2222-4222-8222-222222222222";
    const OTHER: &str = "33333333-3333-4333-8333-333333333333";
    const JOB: &str = "44444444-4444-4444-8444-444444444444";
    const ARCHIVED_AT: &str = "2026-01-01T00:00:00.000Z";
    const EXPIRY: &str = "2026-04-01T00:00:00.000Z";

    #[tokio::test]
    async fn resumes_legacy_roots_and_keeps_reconciliation_non_destructive() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let data = directory.path();
        let scratch = data.join(DIRECTORY).join(CHAT);
        fs::create_dir_all(&scratch).await?;
        fs::write(scratch.join("owned.txt"), b"retained").await?;
        let legacy = json!({"version":1,"roots":vec![
            json!({"rootId":ROOT,"chatId":CHAT,"archivedAt":ARCHIVED_AT,"archiveExpiresAt":EXPIRY})
        ]});
        fs::write(data.join(REGISTRY_FILE), legacy.stringify()).await?;
        let manager = Manager::new(data);
        let routing = Registry::new(data);
        let identity = json!({"type":RESOLVE,"rootId":ROOT,"chatId":CHAT});
        let protected = manager.execute_routed(&identity, &routing).await?;
        assert!(protected["path"].as_str().unwrap().starts_with("ctrr_"));
        let reopened_routing = Registry::new(data);
        let opened = reopened_routing.resolve(&protected).await?;
        assert_eq!(
            opened["path"],
            json!(paths::text(&paths::canonical(&scratch).await?))
        );

        let provision = json!({"jobId":JOB,"attempt":2,"rootId":ROOT,"chatId":CHAT});
        assert_eq!(
            manager.execute(PROVISION, &provision).await?["reused"],
            true
        );
        let mut roots = manager.load().await?;
        let result = manager
            .reconcile(
                &mut roots,
                &json!({"roots":vec![
                    legacy["roots"].as_array().unwrap()[0].clone(),
                    json!({"rootId":OTHER,"chatId":OTHER,"archivedAt":Value::Null,"archiveExpiresAt":Value::Null})
                ]}),
                DateTime::parse_from_rfc3339(EXPIRY)?.with_timezone(&Utc),
            )
            .await?;
        assert_eq!(result["retainedRootIds"], json!(vec![ROOT]));
        assert_eq!(result["dueRootIds"], json!(vec![ROOT]));
        assert_eq!(result["missingRootIds"], json!(vec![OTHER]));
        let result = manager
            .execute(RECONCILE, &json!({"roots":Vec::<Value>::new()}))
            .await?;
        assert_eq!(result["orphanedRootIds"], json!(vec![ROOT]));
        assert_eq!(fs::read(scratch.join("owned.txt")).await?, b"retained");
        assert_eq!(manager.execute(DELETE, &provision).await?["deleted"], true);
        assert_eq!(manager.execute(DELETE, &provision).await?["deleted"], false);
        Ok(())
    }

    #[tokio::test]
    async fn refuses_unregistered_content_and_retries_a_bound_missing_directory() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let data = directory.path();
        let manager = Manager::new(data);
        let scratch = data.join(DIRECTORY).join(CHAT);
        fs::create_dir_all(&scratch).await?;
        let job = json!({"jobId":JOB,"attempt":1,"rootId":ROOT,"chatId":CHAT});
        assert!(manager.execute(PROVISION, &job).await.is_err());
        assert!(manager.execute(DELETE, &job).await.is_err());
        fs::remove_dir(&scratch).await?;

        manager.persist(&Roots::from([(
            ROOT.into(),
            archive_record(&job, &Value::Null, &Value::Null)?,
        )]))?;
        #[cfg(unix)]
        {
            let other = data.join("other");
            fs::create_dir(&other).await?;
            fs::write(other.join("owned.txt"), "retained").await?;
            std::os::unix::fs::symlink(&other, &scratch)?;
            assert!(manager.execute(DELETE, &job).await.is_err());
            assert_eq!(fs::read(other.join("owned.txt")).await?, b"retained");
            fs::remove_file(&scratch).await?;
        }
        assert_eq!(manager.execute(PROVISION, &job).await?["reused"], false);
        Ok(())
    }
}
