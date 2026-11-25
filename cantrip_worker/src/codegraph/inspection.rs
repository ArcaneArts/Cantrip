//! Inspect the existing CodeGraph index for an exact authorized checkout.
use super::{
    Supervisor, identity, project,
    runtime::{INDEX_DIRECTORY, Installation},
};
use crate::filesystem::explorer::restricted;
use anyhow::{Context, Result, bail, ensure};
use cantrip_protocol::external_mcp::inspection::{CodeGraphQuery, GraphQuery};
use cantrip_wire::{Value, parse_json_text, value::json};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, ffi::OsString, io::ErrorKind, path::Path};

impl Supervisor {
    pub(crate) async fn inspect_external(
        &self,
        root: &Path,
        checkout: &Value,
        query: Option<CodeGraphQuery>,
    ) -> Result<Value> {
        let unavailable = |state: &str, message: &str| -> Result<Value> {
            if query.is_some() {
                bail!("{message}");
            }
            Ok(json!({"state":state,"summary":message}))
        };
        self.inner.scope.check()?;
        let Some(installation) = self.inner.runtime.active() else {
            return unavailable(
                "unavailable",
                "CodeGraph is not installed on the assigned worker.",
            );
        };
        let active = self
            .projects
            .lock()
            .unwrap()
            .get(root)
            .is_some_and(|entry| {
                identity(&entry.project.target, checkout)
                    && entry.project.target["rootKind"] == checkout["rootKind"]
            });
        if !active {
            return unavailable(
                "unavailable",
                "CodeGraph has no active index for this checkout. Check the project's CodeGraph settings.",
            );
        }
        let directory = restricted::open_checkout(root)?;
        let index = match directory.open_dir_nofollow(INDEX_DIRECTORY) {
            Ok(index) if restricted::contains_regular(&index, "codegraph.db") => index,
            _ => return unavailable("missing", "The checkout has no local CodeGraph index."),
        };
        for companion in [
            "codegraph.db-wal",
            "codegraph.db-shm",
            "codegraph.db-journal",
        ] {
            match index.symlink_metadata(companion) {
                Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                _ => {
                    return unavailable(
                        "unavailable",
                        "The checkout’s CodeGraph index is unavailable.",
                    );
                }
            }
        }
        let mut snapshot = project::inspect_existing(&installation, &self.inner.scope, root)
            .await
            .map_err(|_| anyhow::anyhow!("The worker could not read the checkout’s CodeGraph index. Check its status in Cantrip."))?;
        if snapshot["initialized"] != true {
            return unavailable(
                "missing",
                "CodeGraph is still preparing this checkout's index.",
            );
        }
        let stale = snapshot["reindexRecommended"] == true
            || snapshot["pendingChanges"]
                .as_u64()
                .is_some_and(|count| count > 0);
        if query.is_some() && stale {
            return unavailable(
                "stale",
                "The CodeGraph index is stale. Wait for the worker to sync this checkout.",
            );
        }
        let Some(query) = query else {
            snapshot["state"] = json!(if stale { "stale" } else { "ready" });
            snapshot["summary"] = json!(if stale {
                "The CodeGraph index has pending changes."
            } else {
                "The checkout's CodeGraph index is ready."
            });
            return Ok(snapshot);
        };
        let limit = query.limit.to_string();
        let args = match query.kind {
            GraphQuery::Symbols => vec![
                "query".into(),
                "--json".into(),
                "--limit".into(),
                limit.into(),
            ],
            GraphQuery::References => vec![
                "callers".into(),
                "--json".into(),
                "--limit".into(),
                limit.into(),
            ],
            GraphQuery::Context => vec![
                "context".into(),
                "--format".into(),
                "json".into(),
                "--max-nodes".into(),
                limit.into(),
                "--no-code".into(),
            ],
        };
        let mut args: Vec<OsString> = args;
        args.extend([
            "--path".into(),
            root.as_os_str().to_owned(),
            "--".into(),
            query.query.into(),
        ]);
        let captured = installation
            .run_read_only(&self.inner.scope, root, &args)
            .await?;
        Installation::succeeded("query", &captured).map_err(|_| {
            anyhow::anyhow!(
                "CodeGraph could not complete the query. Check the checkout’s index status."
            )
        })?;
        let value = parse_json_text(std::str::from_utf8(&captured.stdout)?.trim())
            .map_err(|_| anyhow::anyhow!("CodeGraph did not return a valid result."))?;
        let result = scoped(&directory, query.kind, &value)?;
        ensure!(
            result.stringify().len() <= 20 * 1024,
            "CodeGraph results exceeded the limit. Ask for fewer matches."
        );
        Ok(
            json!({"summary":"Read the checkout's CodeGraph index.","kind":query.kind,"result":result}),
        )
    }
}

fn scoped(directory: &Dir, kind: GraphQuery, value: &Value) -> Result<Value> {
    let collect = |records: &Value, wrapped| -> Result<Vec<Value>> {
        Ok(records
            .as_array()
            .context("CodeGraph result entries")?
            .iter()
            .take(20)
            .filter_map(|record| {
                let node = if wrapped { &record["node"] } else { record };
                symbol(directory, node)
            })
            .collect())
    };
    Ok(match kind {
        GraphQuery::Symbols => json!(collect(value, true)?),
        GraphQuery::References => json!(collect(&value["callers"], false)?),
        GraphQuery::Context => {
            let nodes = collect(&value["nodes"], false)?;
            let keep: HashSet<_> = nodes
                .iter()
                .filter_map(|node| node["id"].as_str())
                .collect();
            let edges = value["edges"].as_array().context("CodeGraph relationships")?.iter()
                .filter(|edge| edge["source"].as_str().is_some_and(|id| keep.contains(graph_id(id).as_str()))
                    && edge["target"].as_str().is_some_and(|id| keep.contains(graph_id(id).as_str())))
                .take(60).map(|edge| json!({
                    "source":edge["source"].as_str().map(graph_id),"target":edge["target"].as_str().map(graph_id),
                    "kind":short(&edge["kind"], 40),"line":edge["line"].as_u64(),
                })).collect::<Vec<_>>();
            json!({"symbols":nodes,"relationships":edges})
        }
    })
}

fn symbol(directory: &Dir, value: &Value) -> Option<Value> {
    let path = value["filePath"].as_str()?;
    if !restricted::contains_regular(directory, path) {
        return None;
    }
    Some(json!({
        "id":value["id"].as_str().map(graph_id),"path":path,"name":short(&value["name"], 200),
        "kind":short(&value["kind"], 40),"line":value["startLine"].as_u64(),
        "endLine":value["endLine"].as_u64(),
    }))
}

fn graph_id(value: &str) -> String {
    cantrip_crypto::encode(&Sha256::digest(value.as_bytes()))
}

fn short(value: &Value, maximum: usize) -> Option<String> {
    value
        .as_str()
        .map(|text| text.chars().take(maximum).collect())
}
