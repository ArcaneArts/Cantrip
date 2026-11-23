//! Bind the managed CodeGraph server to the admitted Host project.
use super::{Supervisor, identity, project, runtime::Installation, storage::Storage};
use crate::{
    filesystem::{Scope, paths, source_path},
    logging,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(super) const ENVIRONMENT: [(&str, &str); 5] = [
    ("CODEGRAPH_DIR", super::runtime::INDEX_DIRECTORY),
    ("CODEGRAPH_NO_DAEMON", "0"),
    ("CODEGRAPH_NO_UPDATE_CHECK", "1"),
    ("CODEGRAPH_TELEMETRY", "0"),
    ("DO_NOT_TRACK", "1"),
];

impl Supervisor {
    pub(crate) async fn agent_mcp(
        &self,
        data: &Path,
        cwd: &JsString,
        session: Option<&Value>,
    ) -> Option<Value> {
        match self.agent_configuration(data, cwd, session).await {
            Ok(configuration) => configuration,
            Err(error) => {
                self.inner.logs.repeated("codegraph-agent-preparation".into(), "warn",
                    "CodeGraph agent MCP preparation failed",
                    json!({"event":"codegraph.mcp.prepare-failed","subsystem":"codegraph",
                        "operation":"prepare-agent-mcp","status":"degraded","error":logging::error(&error)}));
                None
            }
        }
    }

    async fn agent_configuration(
        &self,
        data: &Path,
        cwd: &JsString,
        session: Option<&Value>,
    ) -> Result<Option<Value>> {
        if self.inner.runtime.active().is_none()
            || session.is_some_and(|session| {
                session["projectId"].as_js_string().is_none()
                    || session["worktreeId"].as_js_string().is_none()
                    || !matches!(
                        session["rootKind"].as_str(),
                        Some("git-worktree" | "folder-root")
                    )
            })
        {
            return Ok(None);
        }
        self.inner.scope.check()?;
        let cwd = source_path::canonical(cwd).await?;
        let project = {
            let mut desired = self.transitions.lock().await;
            let current = self
                .projects
                .lock()
                .unwrap()
                .values()
                .filter(|entry| cwd.starts_with(&entry.project.root))
                .max_by_key(|entry| entry.project.root.components().count())
                .map(|entry| entry.project.clone());
            if let Some(current) = current {
                if session.is_some_and(|session| {
                    !identity(&current.target, session)
                        || current.target["rootKind"] != session["rootKind"]
                }) {
                    return Ok(None);
                }
                current
            } else if let Some(session) = session {
                let path = paths::text(&cwd);
                self.ensure_target(
                    &mut desired,
                    json!({
                        "projectId":session["projectId"], "worktreeId":session["worktreeId"],
                        "rootKind":session["rootKind"], "sourcePath":path, "worktreePath":path,
                    }),
                )
                .await?
            } else {
                return Ok(None);
            }
        };
        project.prepare_for_agent().await;
        self.inner.scope.check()?;
        let retained = self
            .projects
            .lock()
            .unwrap()
            .get(&project.root)
            .is_some_and(|entry| Arc::ptr_eq(&entry.project, &project));
        if !retained || *project.stop.borrow() {
            return Ok(None);
        }
        let command = paths::text(&std::env::current_exe()?);
        let args = vec![
            JsString::from("codegraph-mcp"),
            paths::text(data),
            paths::text(&project.root),
        ];
        let environment = Value::object(
            ENVIRONMENT
                .into_iter()
                .map(|(key, value)| (key, json!(value))),
        );
        self.inner.logs.event("debug", "CodeGraph agent MCP injected",
            json!({"event":"codegraph.mcp.injected","subsystem":"codegraph","operation":"prepare-agent-mcp",
                "status":"completed","projectId":project.target["projectId"],"worktreeId":project.target["worktreeId"]}));
        Ok(Some(
            json!({"command":command, "args":args,"env":environment,"enabled":true}),
        ))
    }
}

/// The native managed command resolves the current pointer when Codex starts it.
pub fn launch_mcp(arguments: impl IntoIterator<Item = OsString>) -> Result<()> {
    let mut arguments = arguments.into_iter();
    let data = PathBuf::from(
        arguments
            .next()
            .context("Missing CodeGraph worker data directory.")?,
    );
    let root = PathBuf::from(
        arguments
            .next()
            .context("Missing CodeGraph worktree root.")?,
    );
    ensure!(
        arguments.next().is_none() && data.is_absolute() && root.is_absolute(),
        "Invalid CodeGraph MCP arguments."
    );
    let canonical = paths::canonical_sync(&root)?;
    ensure!(
        canonical == root && canonical.is_dir(),
        "CodeGraph worktree moved."
    );
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let command = executor.block_on(async {
        let storage = Storage::new(&data);
        let scope = Scope::default();
        let _initialization = storage.project_lock(&canonical, &scope).await?;
        let installed =
            Installation::current(&storage)?.context("CodeGraph has no installed runtime.")?;
        project::ensure_mcp_index(&installed, &scope, &canonical).await?;
        Ok::<_, anyhow::Error>(installed.mcp_command(&canonical))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        drop(executor);
        let mut command = command;
        Err(command.exec()).context("Could not launch the installed CodeGraph MCP server.")
    }
    #[cfg(windows)]
    {
        executor.block_on(async {
            let (mut child, _job) = codex_utils_pty::JobObject::spawn_background(
                &mut tokio::process::Command::from(command),
            )?;
            let status = child.wait().await?;
            ensure!(status.success(), "CodeGraph MCP exited with {status}.");
            Ok(())
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let status = {
            let mut command = command;
            command.status()?
        };
        ensure!(status.success(), "CodeGraph MCP exited with {status}.");
        Ok(())
    }
}
