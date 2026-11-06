use anyhow::{Context, Result};
use cantrip_server::{
    chats::{Repository, native_suspensions::stored_summary},
    database::Database,
    migrations::migrate,
    wire::{self, ValidationError, Value},
};
use serde_json::json;
use std::{path::PathBuf, process::Command, sync::Arc};

fn oracle() -> Result<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args(["scripts/server-rust/native-suspension-oracle.mjs"])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[test]
fn suspension_contracts_and_private_projection_match_source() -> Result<()> {
    let corpus = oracle()?;
    let cases = corpus["cases"].as_array().context("oracle cases")?;
    assert_eq!(cases.len(), 99, "oracle corpus changed");
    for case in cases {
        let outcome = match wire::parse(case["schema"].as_str().unwrap(), Some(&case["input"])) {
            Ok(value) => Value::object([("ok", value)]),
            Err(ValidationError::Invalid(issues)) => {
                Value::object([("issues", Value::Array(issues))])
            }
            Err(ValidationError::Operation) => {
                anyhow::bail!("unexpected operation failure: {case:?}")
            }
        };
        assert_eq!(outcome, case["outcome"], "{case:?}");
    }
    for case in corpus["projections"].as_array().unwrap() {
        assert_eq!(stored_summary(&case["input"]), case["output"]);
    }
    Ok(())
}

#[tokio::test]
async fn native_database_reopens_held_record_and_rejects_legacy_unpause() -> Result<()> {
    const PHASE: &str = "CANTRIP_SUSPENSION_DB_PHASE";
    const DATA: &str = "CANTRIP_SUSPENSION_DB_PATH";
    let Ok(phase) = std::env::var(PHASE) else {
        let root = tempfile::tempdir()?;
        for phase in ["seed", "reopen"] {
            let output = tokio::process::Command::new(std::env::current_exe()?)
                .args([
                    "--exact",
                    "native_database_reopens_held_record_and_rejects_legacy_unpause",
                    "--nocapture",
                ])
                .env(PHASE, phase)
                .env(DATA, root.path().join("database"))
                .env("PGLITE_RUNTIME_DIR", root.path().join("runtime"))
                .kill_on_drop(true)
                .output()
                .await?;
            anyhow::ensure!(
                output.status.success(),
                "{phase}: stdout {}; stderr {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return Ok(());
    };
    let root = PathBuf::from(std::env::var(DATA)?);
    let record = oracle()?["record"].clone();
    let database = Arc::new(Database::pglite(&root).await?);
    migrate(&database).await?;
    if phase == "seed" {
        database.execute("INSERT INTO users(id,kind,display_name) VALUES ('owner','anonymous','Owner'); INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('project','owner','{}'::jsonb,'A'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('worker','owner','Worker','linux','x64',now(),now()); INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('source','project','worker','/qa','/qa'); INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,origin) VALUES ('tree','source','worker','Primary','/qa','/qa','cantrip'); INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id) VALUES ('chat','owner','project','{}'::jsonb,'tree')").await?;
        database.query("UPDATE chats SET native_suspension_state=$1::text::jsonb,automation_paused=true WHERE id='chat'", &[&record.stringify()]).await?;
        database.close().await?;
        return Ok(());
    }
    anyhow::ensure!(phase == "reopen", "unknown database test phase");
    let repository = Repository::new(database.clone());
    assert_eq!(
        repository.native_suspension("owner", "chat").await?,
        Some(record.clone())
    );
    assert!(
        repository
            .set_automation_paused("owner", "chat", false)
            .await
            .is_err()
    );
    assert!(repository.native_suspension("other", "chat").await.is_err());
    for phase in ["pausing", "paused", "resuming", "stopping", "error"] {
        let mut raw = record.clone();
        raw["phase"] = Value::from_serialize(&json!(phase));
        if phase == "error" {
            raw["error"] =
                Value::from_serialize(&json!({"code":"restore-failed","protectedDetails":null}));
        }
        database
            .query(
                "UPDATE chats SET native_suspension_state=$1::text::jsonb WHERE id='chat'",
                &[&raw.stringify()],
            )
            .await?;
        assert!(
            repository
                .set_automation_paused("owner", "chat", false)
                .await
                .is_err()
        );
    }
    let unknown = json!({"version":99,"phase":"running","secret":"never-public"}).to_string();
    database
        .query(
            "UPDATE chats SET native_suspension_state=$1::text::jsonb WHERE id='chat'",
            &[&unknown],
        )
        .await?;
    assert_eq!(
        repository
            .native_suspension("owner", "chat")
            .await
            .unwrap_err()
            .to_string(),
        "suspension-state-unreadable"
    );
    assert!(
        repository
            .set_automation_paused("owner", "chat", false)
            .await
            .is_err()
    );
    let saved: String = database
        .query(
            "SELECT native_suspension_state::text FROM chats WHERE id='chat'",
            &[],
        )
        .await?[0]
        .get(0)?;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&saved)?,
        serde_json::from_str::<serde_json::Value>(&unknown)?
    );
    assert!(
        !stored_summary(&serde_json::from_str::<Value>(&saved)?)
            .stringify()
            .contains("never-public")
    );
    database.close().await?;
    Ok(())
}
