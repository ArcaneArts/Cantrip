//! Recovery of a staged restore and retained workspace homes.
use super::{Job, Mode, Outcome, archive, backup_directory, context, material, phase};
use crate::cantrip_os::{carrier::Transport, checked, operations::Journal, text};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, value::json};

pub(super) async fn restore(job: &Job<'_>, journal: &mut Journal<'_>) -> Result<Outcome> {
    let command = job.command;
    let scope = &command["scope"];
    let source_scope = &command["backupScope"];
    ensure!(
        ["ownerId", "workerId", "serverId"]
            .into_iter()
            .all(|field| source_scope[field] == scope[field]),
        "The backup belongs to another account, Worker or Server."
    );
    let transport = job.transport()?;
    let id = job.id()?;
    let may_receive = matches!(
        journal.checkpoint()["phase"].as_str(),
        Some("admitted" | "verifying")
    );
    let mut guest = if job.mode == Mode::New || (job.mode == Mode::Continue && may_receive) {
        receive(job, journal, &transport).await?
    } else {
        job.observe_guest(&transport, journal).await?
    };
    if guest["state"] == "received" && matches!(job.mode, Mode::New | Mode::Continue) {
        job.assert_current(&transport).await?;
        phase(journal, "activating")?;
        guest = job
            .control(&transport, true, &["restore", id], None)
            .await?;
    }
    if matches!(guest["state"].as_str(), Some("restored" | "forgotten"))
        && guest["receipt"].is_object()
    {
        let receipt = &guest["receipt"];
        ensure!(
            job.workspace_matches(&receipt["workspace"])
                && receipt["runtime_handles_restored"] == false
                && receipt["retained_original_home"].is_string(),
            "Restored account differs from its canonical admission."
        );
        let hash = receipt["archive_sha256"]
            .as_str()
            .context("Restored archive digest")?;
        ensure!(
            journal.checkpoint()["archiveSha256"] == hash,
            "Restored archive differs from its verified backup admission."
        );
        let mut warnings = job.cleanup_guest(&transport).await?;
        if job.clear_staging().await.is_err() {
            warnings.push("Worker restore staging cleanup could not be confirmed.");
        }
        return job.complete(journal,
            json!({"action":"restore","backupId":command["backupId"],"receipt":receipt,"cleanupWarnings":warnings}));
    }
    let mut outcome = incomplete(journal, &guest)?;
    if outcome.state == "failed"
        && let Err(error) = job.clear_staging().await
    {
        outcome.error = json!(format!("Worker restore staging cleanup failed: {error}"));
    }
    Ok(outcome)
}

async fn receive(job: &Job<'_>, journal: &mut Journal<'_>, transport: &Transport) -> Result<Value> {
    let command = job.command;
    job.request()?;
    job.assert_current(transport).await?;
    phase(journal, "verifying")?;
    job.clear_staging().await?;
    let destination = job.staging()?.join("verified.tar");
    let id = text(command, "backupId")?;
    let source_scope = &command["backupScope"];
    let source = backup_directory(job.root, source_scope, id).join("archive.ctos");
    let context = context(&command["scope"], id);
    let verified = async {
        let metadata = archive::unpack(
            &source,
            &destination,
            job.root,
            &context,
            |revision| {
                material(job.encryption, &command["scope"], Some(revision)).map(|key| key.key)
            },
            job.lifetime,
            |metadata| {
                ensure!(
                    &metadata["manifest"]["cantrip"]["scope"] == source_scope,
                    "Backup captured placement differs from its admission."
                );
                Ok(())
            },
        )
        .await?;
        job.assert_current(transport).await?;
        Ok::<_, anyhow::Error>(metadata)
    }
    .await;
    let metadata = match verified {
        Ok(metadata) => metadata,
        Err(error) => {
            job.clear_staging().await.with_context(|| {
                format!("{error} Worker restore staging cleanup could not be confirmed.")
            })?;
            return Err(error);
        }
    };
    let mut checkpoint = journal.checkpoint().clone();
    checkpoint["archiveSha256"] = metadata["archiveSha256"].clone();
    checkpoint["phase"] = json!("receiving");
    journal.set_checkpoint(checkpoint)?;
    let request = json!({"archive_bytes":metadata["archiveBytes"],
        "archive_sha256":metadata["archiveSha256"],"replace":command["replace"]})
    .stringify();
    let source = tokio::fs::File::open(destination).await?.into_std().await;
    job.control(
        transport,
        true,
        &[
            "receive",
            job.id()?,
            text(&command["workspace"], "guestWorkspaceId")?,
            "--request",
            &request,
        ],
        Some(source),
    )
    .await
}

pub(super) async fn rollback(job: &Job<'_>, journal: &mut Journal<'_>) -> Result<Outcome> {
    let transport = job.transport()?;
    let restore = text(job.command, "restoreOperationId")?;
    let guest = if job.mode == Mode::New
        || (job.mode == Mode::Continue && journal.checkpoint()["phase"] == "admitted")
    {
        job.request()?;
        job.assert_current(&transport).await?;
        phase(journal, "rolling-back")?;
        job.control(&transport, true, &["rollback", job.id()?, restore], None)
            .await?
    } else {
        job.observe_guest(&transport, journal).await?
    };
    if guest["state"] == "rolled-back" && guest["receipt"].is_object() {
        let receipt = &guest["receipt"];
        ensure!(
            receipt["restore_operation_id"] == restore
                && receipt["workspace"] == job.command["workspace"]["guestWorkspaceId"]
                && receipt["runtime_handles_restored"] == false,
            "Rollback restored a different admission."
        );
        return job.complete(
            journal,
            json!({"action":"rollback","restoreOperationId":restore,
            "receipt":receipt,"cleanupWarnings":Vec::<Value>::new()}),
        );
    }
    incomplete(journal, &guest)
}

pub(super) async fn reset(job: &Job<'_>, journal: &mut Journal<'_>) -> Result<Outcome> {
    let transport = job.transport()?;
    let intent = job.request()?;
    let guest = if job.mode == Mode::New {
        job.assert_current(&transport).await?;
        phase(journal, "resetting")?;
        let request = json!({"paths":intent["paths"]}).stringify();
        job.control(
            &transport,
            true,
            &[
                "reset",
                job.id()?,
                text(&job.command["workspace"], "guestWorkspaceId")?,
                "--request",
                &request,
            ],
            None,
        )
        .await?
    } else {
        job.observe_guest(&transport, journal).await?
    };
    if guest["state"] == "reset"
        && guest["maintenance"]["released"] == true
        && guest["receipt"].is_object()
    {
        let receipt = &guest["receipt"];
        let paths = checked("cantripOsResetPathsSchema", receipt["reset_paths"].clone())?;
        ensure!(
            receipt["workspace"] == job.workspace()
                && paths == intent["paths"]
                && receipt["retained_original_home"]
                    .as_str()
                    .is_some_and(|path| path.starts_with('/'))
                && receipt["shared_system_state_changed"] == false
                && receipt["runtime_handles_restored"] == false,
            "The reset receipt differs from its admitted paths or workspace account."
        );
        return job.complete(
            journal,
            json!({"action":"reset","receipt":receipt,
            "interruption":guest["maintenance"],"cleanupWarnings":Vec::<Value>::new()}),
        );
    }
    let mut outcome = incomplete(journal, &guest)?;
    if outcome.state == "failed" && outcome.error.is_null() {
        outcome.error = json!("The guest reset failed; its retained original was preserved.");
    }
    Ok(outcome)
}

fn incomplete(journal: &mut Journal<'_>, guest: &Value) -> Result<Outcome> {
    let state = if guest["state"] == "failed"
        && (guest["maintenance"].is_null() || guest["maintenance"]["released"] == true)
    {
        "failed"
    } else if guest["active"] == true && guest["state"] != "received" {
        "running"
    } else {
        phase(journal, "recovery-required")?;
        "unknown"
    };
    Ok(Outcome {
        state,
        receipt: Value::Null,
        error: guest["error"].clone(),
    })
}
