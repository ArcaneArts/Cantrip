use super::{Job, Mode, Outcome, archive, carrier, context, material, phase};
use crate::cantrip_os::{carrier::Transport, checked, operations::Journal, text};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, value::json};
use std::{io, path::Path};

pub(super) async fn run(job: &Job<'_>, journal: &mut Journal<'_>) -> Result<Outcome> {
    let command = job.command;
    let scope = &command["scope"];
    let id = text(command, "operationId")?;
    let workspace = &command["workspace"];
    let destination = job.location()?;
    let archive_context = context(scope, id);
    let transport = job.transport()?;
    let expected = job.expected(false);

    // A crash after publication can be recovered by authenticating the file
    // would-be readers will actually use.
    if job.mode != Mode::New {
        match verify(job, &destination, &archive_context).await {
            Ok(metadata) => {
                let captured = &metadata["manifest"]["cantrip"];
                ensure!(
                    &captured["scope"] == scope && &captured["workspace"] == workspace,
                    "Published backup has a different captured placement."
                );
                return complete(job, &transport, journal, metadata).await;
            }
            Err(error) if io_kind(&error, io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
    }

    let guest = if job.mode == Mode::New {
        job.assert_current(&transport).await?;
        let request = job.request()?;
        let sources: Vec<Value> = command["sources"]
            .as_array()
            .context("Admitted backup sources")?
            .iter()
            .map(|source| {
                let mut entry = json!({"mode":source["mode"],"guestPath":source["guestPath"],
                    "bindingId":source["bindingId"],"projectSourceId":source["projectSourceId"],
                    "worktreeId":source["worktreeId"]});
                if source["mode"] == "linux-owned" && source["gitCommonGuestPath"].is_string() {
                    entry["gitMetadataPaths"] = json!(vec![source["gitCommonGuestPath"].clone()]);
                }
                entry
            })
            .collect();
        let input = json!({"exclusions":request["exclusions"],"sources":sources}).stringify();
        phase(journal, "capturing")?;
        job.control(
            &transport,
            true,
            &[
                "capture",
                id,
                text(workspace, "guestWorkspaceId")?,
                "--request",
                &input,
            ],
            None,
        )
        .await?
    } else {
        job.observe_guest(&transport, journal).await?
    };
    if guest["state"] != "captured" || guest["maintenance"]["released"] != true {
        let state = if guest["state"] == "failed" {
            "failed"
        } else if guest["active"] == true {
            "running"
        } else {
            "unknown"
        };
        return Ok(Outcome {
            state,
            receipt: Value::Null,
            error: guest["error"].clone(),
        });
    }

    let request = job.request()?;
    let captured = &guest["receipt"];
    let mut manifest = captured["manifest"].clone();
    let actual = &manifest["workspace"];
    ensure!(
        job.workspace_matches(actual),
        "Captured workspace account differs from its admission."
    );
    manifest["cantrip"] = json!({"scope":scope,"workspace":workspace,
        "sources":command["sources"],"label":request["label"]});
    let metadata = checked(
        "cantripOsBackupArchiveMetadataSchema",
        json!({
            "version":1,"archiveBytes":captured["archive_bytes"],
            "archiveSha256":captured["archive_sha256"],"manifest":manifest,
        }),
    )?;
    phase(journal, "sealing")?;
    let key = material(job.encryption, scope, None)?;
    let pending = carrier::export(
        &transport,
        &["--expect", &expected, "export", id],
        job.lifetime,
        async |bytes| {
            archive::seal(
                bytes,
                &destination,
                &archive_context,
                key.key_revision,
                &key.key,
                &metadata,
            )
            .await
        },
    )
    .await?;
    if let Err(error) = archive::publish(pending, &destination, job.root) {
        if !io_kind(&error, io::ErrorKind::AlreadyExists) {
            return Err(error);
        }
        ensure!(
            verify(job, &destination, &archive_context).await? == metadata,
            "A different backup occupies this admission's destination."
        );
    }
    complete(job, &transport, journal, metadata).await
}

async fn verify(job: &Job<'_>, destination: &Path, context: &Value) -> Result<Value> {
    archive::verify(
        destination,
        context,
        |revision| {
            material(job.encryption, &job.command["scope"], Some(revision)).map(|key| key.key)
        },
        job.lifetime,
    )
    .await
}

async fn complete(
    job: &Job<'_>,
    transport: &Transport,
    journal: &mut Journal<'_>,
    metadata: Value,
) -> Result<Outcome> {
    let warnings = job.cleanup_guest(transport).await?;
    job.complete(
        journal,
        json!({"action":"capture","metadata":metadata,"cleanupWarnings":warnings}),
    )
}

fn io_kind(error: &anyhow::Error, kind: io::ErrorKind) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == kind)
}
