use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

const MODE: &str = "CANTRIP_PGLITE_RUNTIME_ASSET_CASE";
const DATA: &str = "CANTRIP_PGLITE_RUNTIME_ASSET_DATABASE";

fn assets(root: &Path) -> Result<BTreeMap<PathBuf, String>> {
    fn visit(root: &Path, at: &Path, rows: &mut BTreeMap<PathBuf, String>) -> Result<()> {
        for entry in std::fs::read_dir(at)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                visit(root, &path, rows)?;
            } else if entry.file_type()?.is_symlink() {
                rows.insert(
                    path.strip_prefix(root)?.to_owned(),
                    std::fs::read_link(&path)?.to_string_lossy().into_owned(),
                );
            } else {
                rows.insert(
                    path.strip_prefix(root)?.to_owned(),
                    format!("{:x}", Sha256::digest(std::fs::read(path)?)),
                );
            }
        }
        Ok(())
    }
    let mut rows = BTreeMap::new();
    visit(root, root, &mut rows)?;
    Ok(rows)
}

async fn child(runtime: &Path, data: &Path, mode: &str) -> Result<()> {
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "existing_runtime_assets_boot_without_a_cache_marker",
                "--nocapture",
            ])
            .env(MODE, mode)
            .env(DATA, data)
            .env("PGLITE_RUNTIME_DIR", runtime)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "{mode}: {}; stdout: {}; stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[tokio::test]
async fn existing_runtime_assets_boot_without_a_cache_marker() -> Result<()> {
    if let Ok(mode) = std::env::var(MODE) {
        let opened = pglite::PGlite::open(PathBuf::from(std::env::var(DATA)?)).await;
        if mode == "incomplete" {
            let error = opened
                .err()
                .context("An empty runtime unexpectedly booted")?;
            ensure!(
                matches!(error,pglite::Error::Io(ref io) if io.kind()==std::io::ErrorKind::NotFound),
                "Expected the actual missing-executable error, got {error}"
            );
            return Ok(());
        }
        let database = opened?;
        if mode == "reopen" {
            let rows = database
                .query("SELECT value FROM runtime_witness", &[])
                .await?;
            ensure!(
                rows.len() == 1 && rows[0].get::<i32>(0)? == 7,
                "Existing database writes must survive runtime reuse"
            );
        } else {
            database.exec("CREATE TABLE runtime_witness(value integer NOT NULL); INSERT INTO runtime_witness VALUES(7)").await?;
            let tx = database.transaction().await?;
            tx.exec("UPDATE runtime_witness SET value=9").await?;
            tx.rollback().await?;
            ensure!(
                database
                    .query("SELECT value FROM runtime_witness", &[])
                    .await?[0]
                    .get::<i32>(0)?
                    == 7
            );
        }
        database.close().await?;
        return Ok(());
    }
    let root = tempfile::Builder::new()
        .prefix("cantrip-pglite-runtime-assets-")
        .tempdir()?;
    let runtime = root.path().join("runtime");
    let data = root.path().join("retained-database");
    let outcome: Result<()> = async {
        child(&runtime, &data, "seed").await?;
        std::fs::remove_file(runtime.join(".extracted"))?;
        let before = assets(&runtime)?;
        child(
            &runtime,
            &root.path().join("fresh-database"),
            "fresh-unmarked",
        )
        .await?;
        child(&runtime, &data, "reopen").await?;
        ensure!(
            assets(&runtime)? == before,
            "Runtime reuse must preserve every asset byte and link"
        );
        let incomplete = root.path().join("incomplete-runtime");
        std::fs::create_dir(&incomplete)?;
        child(
            &incomplete,
            &root.path().join("incomplete-database"),
            "incomplete",
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = outcome {
        let retained = root.keep();
        bail!("{error:#}; retained {}", retained.display());
    }
    Ok(())
}
