use super::{Job, Mode, Outcome, archive, carrier, context, material, phase, protect};
use crate::cantrip_os::{assert_scope, checked, operations::Journal, text};
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
                return complete(job, journal, metadata).await;
            }
            Err(error) if io_kind(&error, io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
    }

    let guest = if job.mode == Mode::New {
        assert_scope(&transport, scope, true, job.lifetime).await?;
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
        let expected_workspace = json!({"uid":workspace["uid"],"gid":workspace["gid"],
            "home":workspace["homeGuestPath"]})
        .stringify();
        phase(journal, "capturing")?;
        carrier::control(
            &transport,
            &[
                "--expect",
                &job.expected(true),
                "--expect-workspace",
                &expected_workspace,
                "capture",
                id,
                text(workspace, "guestWorkspaceId")?,
                "--request",
                &input,
            ],
            job.lifetime,
        )
        .await?
    } else {
        let saved = carrier::control(
            &transport,
            &["--expect", &expected, "inspect", id],
            job.lifetime,
        )
        .await?;
        ensure!(
            saved["operation_id"] == id,
            "Guest recovery receipt belongs to another operation."
        );
        let unfinished = saved["state"] == "unknown"
            || (saved["maintenance"].is_object() && saved["maintenance"]["released"] != true);
        if unfinished && saved["active"] != true {
            if job.mode == Mode::Observe {
                phase(journal, "recovery-required")?;
                saved
            } else {
                carrier::control(
                    &transport,
                    &["--expect", &expected, "recover", id],
                    job.lifetime,
                )
                .await?
            }
        } else {
            saved
        }
    };
    ensure!(
        guest["operation_id"] == id,
        "Misrouted guest capture receipt."
    );
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
        [
            ("id", "guestWorkspaceId"),
            ("uid", "uid"),
            ("gid", "gid"),
            ("home", "homeGuestPath")
        ]
        .into_iter()
        .all(|(guest, admitted)| actual[guest] == workspace[admitted]),
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
    complete(job, journal, metadata).await
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

async fn complete(job: &Job<'_>, journal: &mut Journal<'_>, metadata: Value) -> Result<Outcome> {
    let id = text(job.command, "operationId")?;
    let mut warnings = Vec::new();
    if job.mode == Mode::Observe {
        warnings.push("Guest transfer staging cleanup was not requested during observation.");
    } else {
        let transport = job.transport()?;
        let expected = job.expected(false);
        if carrier::control(
            &transport,
            &["--expect", &expected, "forget", id],
            job.lifetime,
        )
        .await
        .is_err()
        {
            warnings.push("Guest transfer staging cleanup could not be confirmed.");
        }
    }
    let envelope = protect(
        job.encryption,
        &job.command["scope"],
        id,
        json!({"action":"capture","metadata":metadata,"cleanupWarnings":warnings}),
    )?;
    phase(journal, "complete")?;
    let receipt = json!({"kind":"backup-result","action":"capture","protectedResult":envelope});
    Ok(Outcome {
        state: "ready",
        receipt,
        error: Value::Null,
    })
}

fn io_kind(error: &anyhow::Error, kind: io::ErrorKind) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == kind)
}
