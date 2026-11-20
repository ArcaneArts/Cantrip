use super::transcript::Transcript;
use crate::{
    codex::{
        external_home::{self, Home, Homes},
        rpc_client::Client,
    },
    filesystem::{Scope, paths},
    http::checked,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_config::Environment;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const IMPORT_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) struct Adapter {
    homes: Homes,
    binary: PathBuf,
    cwd: PathBuf,
    environment: Environment,
}

impl Adapter {
    pub(super) fn new(binary: &Path, data: &Path, cwd: &Path, environment: &Environment) -> Self {
        Self {
            homes: Homes::new(data, cwd, environment),
            binary: binary.to_owned(),
            cwd: cwd.to_owned(),
            environment: environment.clone(),
        }
    }

    pub(super) async fn destination(&self, cwd: &Value) -> Result<Home> {
        ensure!(
            external_home::supported(),
            "Export to the local Codex app is supported only on macOS and Windows workers."
        );
        let path = paths::native(cwd.as_js_string().context("Missing export worktree.")?);
        ensure!(
            tokio::fs::metadata(path)
                .await
                .is_ok_and(|entry| entry.is_dir()),
            "The selected project worktree is no longer available."
        );
        self.homes.available().await.into_iter().next().context(
            "No external Codex home was found. Open the Codex desktop app once on this worker and try again."
        )
    }

    async fn client(&self, home: &Home) -> Result<Client> {
        Client::spawn(
            &self.binary,
            &home.path,
            &self.cwd,
            &self.environment,
            REQUEST_TIMEOUT,
        )
        .await
        .context("Could not start the Codex app-server for project export.")
    }

    pub(super) async fn inspect(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let inspection = async {
            let home = self.destination(&command["cwd"]).await?;
            let client = self.client(&home).await?;
            let ready = async {
                client.initialize("cantrip_project_export_preview", "Cantrip Project Export Preview", "1.0.0", true).await?;
                rpc(&client, "thread/list", json!({"archived":false,"limit":1,"sortKey":"updated_at",
                    "sortDirection":"desc","sourceKinds":vec!["cli","vscode"],"useStateDbOnly":true})).await?;
                rpc(&client, "externalAgentConfig/detect", json!({"migrationSource":"cursor",
                    "includeHome":false,"cwds":Vec::<Value>::new(),"maxSessions":0})).await?;
                Ok(())
            };
            let result = tokio::select! {
                result = ready => result,
                _ = scope.stopped() => Err(anyhow::anyhow!("Project export inspection stopped.")),
            };
            let close = client.close().await;
            result.and(close)?;
            Ok::<_, anyhow::Error>(home)
        }.await;
        let mut result = json!({"target":command["target"],"platform":crate::platform::platform()});
        match inspection {
            Ok(home) => {
                result["available"] = json!(true);
                result["destinationLabel"] = json!(home.label);
                result["message"] = Value::Null;
            }
            Err(error) => {
                let message = crate::error::message(&error);
                result["available"] = json!(false);
                result["destinationLabel"] = Value::Null;
                result["message"] = json!(JsString::new(
                    message.units().iter().take(2_000).copied().collect()
                ));
            }
        }
        checked("projectExportTargetInspectionSchema", &result)
    }

    pub(super) async fn export(
        &self,
        cwd: &Value,
        expected: &Home,
        abandoned: Option<&JsString>,
        transcript: Transcript,
        on_started: impl FnOnce(&JsString) -> Result<()>,
        scope: &Scope,
    ) -> Result<JsString> {
        let current = self.destination(cwd).await?;
        ensure!(
            current == *expected,
            "The external Codex home changed during export."
        );
        let stage_root = self
            .homes
            .user_home()?
            .join(".cursor")
            .join("projects")
            .join(".cantrip-exports");
        cantrip_host::files::private_directory(&stage_root)?;
        let stage = tempfile::Builder::new()
            .prefix("export-")
            .tempdir_in(&stage_root)?;
        let source = stage.path().join("session.jsonl");
        let Transcript {
            title,
            turns,
            records,
            ..
        } = transcript;
        let write_path = source.clone();
        tokio::task::spawn_blocking(move || {
            let mut file = std::io::BufWriter::new(cantrip_host::files::open_private(&write_path)?);
            for record in records {
                writeln!(file, "{}", record.stringify())?;
            }
            file.flush()
        })
        .await??;
        scope.check()?;
        let client = self.client(&current).await?;
        let mut created = None;
        let result = async {
            client.initialize("cantrip_project_exporter", "Cantrip Project Exporter", "1.0.0", true).await?;
            scope.check()?;
            if let Some(thread) = abandoned {
                delete(&client, thread).await?;
            }
            // Once submitted, observe this import through its specific
            // completion and journal the thread before verifying or stopping.
            let imported = rpc(&client, "externalAgentConfig/import", json!({
                "migrationSource":"cursor","providerId":"cantrip","source":"cantrip_project_export",
                "migrationItems":vec![json!({"itemType":"SESSIONS","description":"Import Cantrip chat","cwd":cwd,
                    "details":json!({"sessions":vec![json!({"path":paths::text(&source),"cwd":cwd,"title":title})]})})],
            })).await?;
            let import = id(&imported["importId"]).context("Codex returned an invalid session import identity.")?;
            let completion = client.wait("externalAgentConfig/import/completed".into(),
                Arc::new(move |params| params["importId"].as_js_string() == Some(&import)), Some(IMPORT_TIMEOUT)).await?;
            let thread = imported_thread(&completion["params"])?;
            created = Some(thread.clone());
            on_started(&thread)?;
            // Current Cursor imports infer a title from the first prompt.
            rpc(&client, "thread/name/set", json!({"threadId":thread,"name":title})).await?;
            let verified = rpc(&client, "thread/read", json!({"threadId":thread,"includeTurns":true})).await?;
            ensure!(id(&verified["thread"]["id"]).as_ref() == Some(&thread)
                && verified["thread"]["preview"].as_js_string().is_some_and(|text| !text.trim().is_empty())
                && verified["thread"]["turns"].as_array().is_some_and(|items| items.len() == turns),
                "Codex did not persist the exported chat as native visible turns.");
            let listed = rpc(&client, "thread/list", json!({"archived":false,"cwd":cwd,"searchTerm":title,
                "limit":100,"sortKey":"updated_at","sortDirection":"desc","sourceKinds":vec!["cli","vscode"],
                "useStateDbOnly":true})).await?;
            ensure!(listed["data"].as_array().is_some_and(|items| items.iter().any(|item| item["id"].as_js_string() == Some(&thread))),
                "Codex persisted the exported chat but did not expose it in thread discovery.");
            Ok(thread)
        }.await;
        if result.is_err()
            && let Some(thread) = created
        {
            let _ = delete(&client, &thread).await;
        }
        let closed = client.close().await;
        drop(stage);
        let _ = tokio::fs::remove_dir(stage_root).await;
        result.and_then(|thread| closed.map(|()| thread))
    }
}

async fn rpc(client: &Client, method: &str, params: Value) -> Result<Value> {
    let response = client.request(method.into(), Some(params)).await?;
    if let Some(message) = response["error"]["message"].as_js_string() {
        let message = JsString::new(message.units().iter().take(2_000).copied().collect());
        bail!("Codex {method} failed: {message}");
    }
    Ok(response["result"].clone())
}

async fn delete(client: &Client, thread: &JsString) -> Result<()> {
    let response = client
        .request("thread/delete".into(), Some(json!({"threadId":thread})))
        .await?;
    if let Some(message) = response["error"]["message"].as_js_string() {
        let message = message.lowercase();
        ensure!(
            message.lossy().contains("not found") || message.lossy().contains("unknown thread"),
            "Codex could not replace an interrupted export."
        );
    }
    Ok(())
}

fn id(value: &Value) -> Option<JsString> {
    value
        .as_js_string()
        .filter(|id| !id.is_empty())
        .map(|id| JsString::new(id.units().iter().take(500).copied().collect()))
}

fn imported_thread(completion: &Value) -> Result<JsString> {
    let results = completion["itemTypeResults"]
        .as_array()
        .context("Codex returned an invalid session import completion.")?;
    let sessions = results
        .iter()
        .find(|entry| entry["itemType"] == "SESSIONS")
        .context("Codex did not create a thread for the imported chat.")?;
    if let Some(thread) = sessions["successes"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|entry| id(&entry["target"]))
    {
        return Ok(thread);
    }
    if let Some(message) = sessions["failures"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["message"].as_js_string())
    {
        let message = JsString::new(message.units().iter().take(2_000).copied().collect());
        bail!("Codex could not import the chat: {message}");
    }
    bail!("Codex did not create a thread for the imported chat.")
}
