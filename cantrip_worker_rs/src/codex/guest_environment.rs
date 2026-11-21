//! A managed Codex app-server on the worker with one admitted guest executor.
use crate::{
    cantrip_os::{assert_scope, carrier::Transport, operations::save, session::Session},
    codex::managed::Launch,
    filesystem::{Scope, paths},
    run_definitions::repository::read_bounded,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, parse_json_text, payload_digest, value::json};
use std::{
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_RECORD_BYTES: u64 = 1024 * 1024;

pub(super) struct Environment {
    pub id: String,
    pub selection: Value,
    execution: Value,
    document: String,
    pub instructions: String,
}

pub(crate) fn record_path(data: &Path, authority: &Value, chat: &JsString) -> PathBuf {
    // All identity fields are strings. Canonical and ordinary JSON yield the
    // same array bytes as the previously shipped worker.
    let key = payload_digest(&Value::Array(vec![
        authority["serverId"].clone(),
        authority["ownerId"].clone(),
        authority["workerId"].clone(),
        json!(chat),
    ]));
    data.join("os-agent-placements").join(format!("{key}.json"))
}

pub(crate) fn stored(file: &Path) -> Result<Option<Value>> {
    match read_bounded(file, MAX_RECORD_BYTES) {
        Ok(raw) => {
            let record = parse_json_text(std::str::from_utf8(&raw)?)
                .map_err(|_| anyhow!("Invalid OS agent placement JSON."))?;
            Ok(Some(checked("cantripOsExecutionSchema", &record)?))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("Reading the saved OS agent placement."),
    }
}

impl Environment {
    pub async fn capture(
        data: &Path,
        authority: &Value,
        session: &Value,
        cwd: &JsString,
    ) -> Result<Option<Self>> {
        let chat = session["chatId"]
            .as_js_string()
            .context("An OS agent runtime requires an admitted chat identity.")?;
        let file = record_path(data, authority, chat);
        let previous = stored(&file)?;
        let supplied = session
            .get("osExecution")
            .map(|placement| checked("cantripOsExecutionSchema", placement))
            .transpose()?;
        if let (Some(supplied), Some(previous)) = (&supplied, &previous) {
            same_placement(previous, supplied)?;
        }
        let Some(execution) = previous.as_ref().or(supplied.as_ref()) else {
            return Ok(None);
        };
        let placement = &execution["scope"];
        let root_kind = if placement["sourceKind"] == "git" {
            "git-worktree"
        } else {
            "folder-root"
        };
        ensure!(
            session["contextKind"] == "project"
                && session["projectId"] == placement["projectId"]
                && session["worktreeId"] == placement["worktreeId"]
                && session["rootKind"] == root_kind,
            "The managed session differs from its captured OS project/worktree."
        );
        let environment = Self::open(authority, execution, cwd).await?;
        if previous.is_none() {
            match save(&file, execution, true) {
                Ok(()) => {}
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == ErrorKind::AlreadyExists) =>
                {
                    let recorded =
                        stored(&file)?.context("The saved OS agent placement disappeared.")?;
                    same_placement(&recorded, execution)?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(Some(environment))
    }

    /// Reopen the saved placement or use Core's captured execution for a read.
    pub async fn reopen(
        data: &Path,
        authority: &Value,
        chat: &JsString,
        cwd: &JsString,
        supplied: Option<&Value>,
    ) -> Result<Option<Self>> {
        let previous = stored(&record_path(data, authority, chat))?;
        let supplied = supplied
            .map(|execution| checked("cantripOsExecutionSchema", execution))
            .transpose()?;
        if let (Some(previous), Some(supplied)) = (&previous, &supplied) {
            same_placement(previous, supplied)?;
        }
        let Some(execution) = previous.as_ref().or(supplied.as_ref()) else {
            return Ok(None);
        };
        Ok(Some(Self::open(authority, execution, cwd).await?))
    }

    async fn open(authority: &Value, execution: &Value, cwd: &JsString) -> Result<Self> {
        let placement = &execution["scope"];
        ensure!(
            placement["ownerId"] == authority["ownerId"]
                && placement["workerId"] == authority["workerId"],
            "The OS runtime belongs to a different owner or worker."
        );
        ensure!(
            placement["guestPath"].as_js_string() == Some(cwd),
            "The native cwd differs from its captured Linux placement."
        );

        let transport = Transport::from_value(&execution["transport"])?;
        let lifetime = Scope::default();
        assert_scope(&transport, placement, true, &lifetime).await?;
        let binding = Session::capture_binding(&transport, placement, &lifetime).await?;
        let (program, args) = transport.executor_connection(&binding)?;
        let args = args
            .iter()
            .map(|arg| paths::text(Path::new(arg)))
            .collect::<Vec<_>>();
        let id = environment_id(&authority["serverId"], placement);
        let document = format!(
            "default = {}\ninclude_local = false\n[[environments]]\nid = {}\nprogram = {}\nargs = {}\ninitialize_timeout_sec = 60\n",
            json!(&id).stringify(),
            json!(&id).stringify(),
            json!(paths::text(Path::new(program))).stringify(),
            json!(args).stringify(),
        );
        let selection =
            json!({"environmentId":id,"cwd":cwd,"runtimeWorkspaceRoots":vec![cwd.clone()]});
        let workspace = &placement["guestWorkspaceId"];
        let uid = &placement["uid"];
        let source = if placement["mode"] == "linked" {
            "Git metadata for this linked checkout is owned by Cantrip on the source worker. Use the product's Git controls and keep the existing .git metadata."
        } else if placement["sourceKind"] == "git" {
            "Git for this checkout runs in the Linux workspace."
        } else {
            "This is a non-Git folder. Initialize Git only if the user requests it."
        };
        let instructions = format!(
            "This Chat uses the CantripOS Linux workspace {} at {}, UID {}. Shell and filesystem tools operate in the selected guest. Use the managed cantrip MCP tools advertised for this placement. MCP and provider credentials stay on the owning worker. {source} After transport loss, observe the existing state before retrying a mutation.",
            workspace.stringify(),
            cwd.lossy(),
            uid.stringify(),
        );
        Ok(Self {
            id,
            selection,
            execution: execution.clone(),
            document,
            instructions,
        })
    }

    pub fn assert_execution(&self, execution: &Value) -> Result<()> {
        same_placement(&self.execution, execution)
    }

    pub fn configure_launch(self: &Arc<Self>, launch: &mut Launch) {
        launch.profile.native_host = true;
        let environment = self.clone();
        launch.prepare_home = Some(Arc::new(move |home| {
            let environment = environment.clone();
            cantrip_transport::lifecycle::owned(async move { environment.prepare_home(&home) })
        }));
    }

    pub fn prepare_home(&self, home: &Path) -> Result<()> {
        cantrip_host::files::private_directory(home)?;
        let file = home.join("environments.toml");
        let mut staging = tempfile::NamedTempFile::new_in(home)?;
        staging.write_all(self.document.as_bytes())?;
        staging.as_file().sync_all()?;
        match staging.persist_noclobber(&file) {
            Ok(_) => {
                #[cfg(unix)]
                std::fs::File::open(home)?.sync_all()?;
                Ok(())
            }
            Err(error) if error.error.kind() == ErrorKind::AlreadyExists => {
                ensure!(
                    read_bounded(&file, MAX_RECORD_BYTES)? == self.document.as_bytes(),
                    "This native runtime already belongs to a different execution environment."
                );
                Ok(())
            }
            Err(error) => Err(error.error.into()),
        }
    }
}

fn same_placement(previous: &Value, current: &Value) -> Result<()> {
    ensure!(
        previous == current,
        "This chat already captured a different OS placement; its runtime cannot be retargeted."
    );
    Ok(())
}

fn environment_id(server: &Value, scope: &Value) -> String {
    let fields = [
        "ownerId",
        "workerId",
        "instanceId",
        "guestInstanceId",
        "attachmentGeneration",
        "runtimeGeneration",
        "bindingId",
        "bindingGeneration",
        "projectSourceId",
        "worktreeId",
        "workspaceId",
        "uid",
        "guestPath",
    ];
    let identity = Value::Array(
        std::iter::once(server.clone())
            .chain(fields.into_iter().map(|name| scope[name].clone()))
            .collect(),
    );
    format!("cantrip-os-{}", &payload_digest(&identity)[..48])
}
