//! Launch and recover configured Runs on an admitted Linux workspace.
mod journal;
mod process;

use super::{Failure, LaunchJob, Manager, Phase, layers, now};
use crate::{cantrip_os::text, filesystem::Scope};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{Value, parse_json_text, value::json};
use journal::Journal;
use process::Executor;
use std::{path::Path, time::Duration};
use zeroize::Zeroizing;

pub(super) const PREFIX: &str = "cantrip-os.run-runtime.";
const HELPER: &str = "/usr/lib/cantrip-os-executor/cantrip-os-run-definitions";
const DEFAULT_GRACE: u64 = 3000;
pub(super) const TERMINATION_UNKNOWN: &str =
    "Linux Run termination could not be confirmed. Its command was not repeated.";

pub(super) fn is_guest(command: &Value) -> bool {
    command.get("definitions").is_some()
}

pub(super) fn capture(input: &Value) -> Result<Value> {
    checked(
        "cantripOsRunCaptureSchema",
        &json!({
            "definitions":input["definitions"],"target":input["target"],"identity":input["identity"],
        }),
    )
}

pub(super) fn authorize(manager: &Manager, command: &Value) -> Result<()> {
    let (owner, _) = manager.encryption.bound_identity()?;
    let identity = &command["identity"];
    let definitions = &command["definitions"];
    let target = &command["target"];
    let source = &definitions["scope"];
    let selected = &target["scope"];
    ensure!(
        source["ownerId"].as_js_string() == Some(&owner)
            && selected["workerId"].as_js_string() == Some(&manager.worker)
            && identity["workerId"] == selected["workerId"]
            && identity["projectId"] == selected["projectId"]
            && identity["worktreeId"] == selected["worktreeId"]
            && definitions["transport"] == target["transport"]
            && [
                "ownerId",
                "workerId",
                "projectId",
                "projectSourceId",
                "instanceId",
                "guestInstanceId",
                "workspaceId",
                "guestWorkspaceId",
                "uid",
                "gid",
                "attachmentGeneration",
                "runtimeGeneration"
            ]
            .iter()
            .all(|key| source[*key] == selected[*key]),
        "The Run definition and target belong to different Linux authority."
    );
    Ok(())
}

pub(super) fn recovery(root: &Path, captured: &Value) -> Result<Option<Value>> {
    let Some(saved) = Journal::open(root, &captured["identity"])? else {
        return Ok(None);
    };
    saved.matches(captured, false)?;
    saved.input().map(Some)
}

pub(super) async fn stop_recorded(
    manager: &Manager,
    captured: &Value,
) -> Result<Option<super::process::Exit>> {
    authorize(manager, captured)?;
    let saved = Journal::open(&manager.guest_journals, &captured["identity"])?
        .context("The recorded Linux Run admission is unavailable.")?;
    saved.matches(captured, true)?;
    stop_saved(manager, saved)
        .await
        .context(TERMINATION_UNKNOWN)
}

async fn stop_saved(manager: &Manager, mut saved: Journal) -> Result<Option<super::process::Exit>> {
    let pending: Vec<_> = saved
        .processes()
        .iter()
        .enumerate()
        .filter(|(_, process)| process["exited"] == false)
        .map(|(index, process)| (index, process["id"].as_str().unwrap().to_owned()))
        .collect();
    if pending.is_empty() {
        return Ok(as_exit(&saved.record["result"]));
    }
    let admission = saved.input()?;
    let lifetime = Scope::default();
    let mut executor = Executor::capture(manager, &admission, &lifetime).await?;
    let result = async {
        executor.resume(&saved).await?;
        saved.record["stopRequested"] = json!(true);
        saved.save()?;
        let mut code = None;
        for (index, id) in pending {
            code = executor.terminate(&id).await?;
            saved.processes_mut()[index]["exited"] = json!(true);
            saved.save()?;
        }
        let result = completed(true, code);
        saved.record["result"] = result.clone();
        saved.save()?;
        Ok(as_exit(&result))
    }
    .await;
    executor.close().await;
    result
}

pub(super) async fn launch(
    manager: &Manager,
    job: &LaunchJob,
) -> Result<Option<super::process::Exit>, Failure> {
    let outcome = run(manager, job).await;
    match outcome {
        Ok(outcome) => match outcome["outcome"].as_str() {
            Some("exited" | "interrupted") => Ok(as_exit(&outcome)),
            Some("failed" | "unknown") => Err(outcome_failure(&outcome)),
            _ => Err(unknown()),
        },
        Err(error) => {
            // This path has no guest result to publish. Its errors are local
            // admission failures, or an older generation could not be retired.
            manager.logs.event(
                "warn",
                "Linux Run admission failed",
                json!({
                    "event":"cantrip-os.run.admission-failed",
                    "runtimeId":job.command["identity"]["runtimeId"],
                    "generation":job.command["identity"]["generation"],
                    "reason":error.to_string(),
                }),
            );
            Err(Failure::new(
                "target",
                "linux-launch-unavailable",
                "The Linux Run did not reach process launch. Inspect its Worker diagnostics.",
                true,
            ))
        }
    }
}

async fn run(manager: &Manager, job: &LaunchJob) -> Result<Value> {
    let root = &manager.guest_journals;
    let input = journal::launch(&job.command)?;
    authorize(manager, &input)?;
    ensure!(
        manager.current_authority(&job.session.lock().unwrap()),
        "The Linux Run belongs to another server authorization."
    );
    let previous = Journal::open(root, &input["identity"])?;
    let recovering = previous.is_some();
    let mut saved = if let Some(saved) = previous {
        saved.matches(&input, false)?;
        ensure!(
            saved.input()? == input,
            "The Linux Run generation already has another admission."
        );
        saved
    } else {
        ensure!(
            !job.resume_only,
            "The recorded Linux Run admission disappeared."
        );
        for older in journal::older(root, &input)? {
            stop_saved(manager, older)
                .await
                .context(TERMINATION_UNKNOWN)?;
        }
        Journal::reserve(root, &input)?
    };

    if saved.record["outputTruncated"] == true {
        job.session.lock().unwrap().output.mark_incomplete();
    }
    let lifetime = Scope::default();
    let observed = execute(manager, job, &input, &mut saved, recovering, &lifetime).await;
    let result = match observed {
        Ok(result) => result,
        Err(failure) => {
            if recovering && settled(&saved.record["result"]) {
                incomplete(
                    job,
                    &mut saved,
                    "\r\n[The prior Run completion was retained; its output could not be fully recovered.]\r\n",
                )?;
                return Ok(saved.record["result"].clone());
            }
            let failure = match failure {
                GuestFailure::Setup(failure) if !recovering && saved.processes().is_empty() => {
                    failure
                }
                _ if recovering || !saved.processes().is_empty() => unknown(),
                _ => Failure::new(
                    "target",
                    "linux-launch-unavailable",
                    "The Linux Run did not reach process launch. Check the guest executor and Worker diagnostics.",
                    true,
                ),
            };
            json!({
                "outcome":if failure.phase == "reconcile" {"unknown"} else {"failed"},
                "phase":failure.phase,"code":failure.code,"message":failure.message,
            })
        }
    };
    saved.record["result"] = result.clone();
    // We may have acted on the guest already. Treat a publication failure as
    // uncertain, and keep the previously published process identifiers.
    if saved.save().is_err() {
        let failure = unknown();
        return Ok(
            json!({"outcome":"unknown","phase":failure.phase,"code":failure.code,"message":failure.message}),
        );
    }
    Ok(result)
}

enum GuestFailure {
    Transport,
    Setup(Failure),
}

impl From<anyhow::Error> for GuestFailure {
    fn from(_: anyhow::Error) -> Self {
        // Executor failures can include subprocess text or arguments. The Run
        // outcome and durable record must not contain unredacted diagnostics.
        Self::Transport
    }
}

async fn execute(
    manager: &Manager,
    job: &LaunchJob,
    input: &Value,
    journal: &mut Journal,
    recovering: bool,
    lifetime: &Scope,
) -> Result<Value, GuestFailure> {
    if !recovering && job.stopping() {
        return Ok(completed(true, None));
    }
    let mut secrets = Vec::new();
    for secret in input["protectedSecrets"].as_array().unwrap() {
        let value =
            layers::open_secret(&input["identity"]["projectId"], secret, &manager.encryption)
                .map_err(GuestFailure::Setup)?;
        secrets.push((secret["reference"].clone(), value));
    }
    job.session
        .lock()
        .unwrap()
        .output
        .replace_secrets(secrets.iter().map(|(_, value)| value.as_str()));
    if recovering
        && journal
            .processes()
            .last()
            .is_none_or(|process| process["phase"] != "runtime")
    {
        if settled(&journal.record["result"]) {
            incomplete(
                job,
                journal,
                "\r\n[Earlier Linux preparation output was not recovered; preparation was not repeated.]\r\n",
            )?;
            return Ok(journal.record["result"].clone());
        }
        return Ok(json!({
            "outcome":"unknown","phase":"reconcile","code":"linux-preparation-interrupted",
            "message":"The previous preparation has no admitted runtime process; it was not repeated.",
        }));
    }
    let mut executor = Executor::capture(manager, input, lifetime).await?;
    let result = if recovering {
        async {
            executor.resume(journal).await?;
            let exit = executor.observe(job, journal, true).await?;
            if !job.stopping() && settled(&journal.record["result"]) {
                return Ok(journal.record["result"].clone());
            }
            Ok(completed(
                job.stopping() || journal.record["stopRequested"] == true,
                exit.code,
            ))
        }
        .await
    } else {
        fresh(job, input, &secrets, journal, &mut executor).await
    };
    executor.close().await;
    result
}

async fn fresh(
    job: &LaunchJob,
    input: &Value,
    secrets: &[(Value, Zeroizing<String>)],
    journal: &mut Journal,
    executor: &mut Executor<'_>,
) -> Result<Value, GuestFailure> {
    executor.open(journal).await?;
    let source = &input["definitions"]["scope"]["guestPath"];
    let target = &input["target"]["scope"]["guestPath"];
    let command = json!({"executable":HELPER,"arguments":["--plan"],"workingDirectory":target});
    let request = checked(
        "osRunPlanInputSchema",
        &json!({
            "identity":input["identity"],"sourceRoot":source,"targetRoot":target,
            "secrets":secrets.iter().map(|(reference, value)| json!({"reference":reference,"value":value.as_str()})).collect::<Vec<_>>(),
        }),
    )?;
    let plan_request = Zeroizing::new(request.stringify() + "\n");
    let prepared = executor
        .start(
            job,
            journal,
            &command,
            &json!({}),
            "prepare",
            Some(plan_request.as_bytes()),
        )
        .await?;
    if job.stopping() {
        return Ok(completed(true, prepared.code));
    }
    ensure_plan_exit(prepared.code)?;
    let plan = parse_json_text(&prepared.stdout).map_err(|_| GuestFailure::Transport)?;
    let plan = checked("osRunPlanResponseSchema", &plan)?;
    if plan["state"] == "failed" {
        return Ok(
            json!({"outcome":"failed","phase":plan["phase"],"code":plan["code"],
            "message":job.session.lock().unwrap().output.redact(text(&plan,"message")?)}),
        );
    }
    journal.record["stopGracePeriodMs"] = plan["stopGracePeriodMs"].clone();
    journal.save()?;
    job.append(text(&plan, "preparationOutput")?);
    for command in plan["beforeLaunch"].as_array().unwrap() {
        let step = executor
            .start(
                job,
                journal,
                command,
                &plan["environment"],
                "before-launch",
                None,
            )
            .await?;
        if job.stopping() {
            return Ok(completed(true, step.code));
        }
        if step.code != Some(0) {
            let code = step
                .code
                .map_or_else(|| "null".into(), |code| code.to_string());
            return Ok(
                json!({"outcome":"failed","phase":"before-launch","code":"before-launch-failed",
                "message":format!("A Linux before-launch step exited with code {code}.")}),
            );
        }
    }
    let runtime = executor
        .start(
            job,
            journal,
            &plan["command"],
            &plan["environment"],
            "runtime",
            None,
        )
        .await?;
    Ok(completed(job.stopping(), runtime.code))
}

fn ensure_plan_exit(code: Option<i32>) -> Result<(), GuestFailure> {
    if code == Some(0) {
        Ok(())
    } else {
        Err(GuestFailure::Transport)
    }
}

fn settled(result: &Value) -> bool {
    matches!(
        result["outcome"].as_str(),
        Some("exited" | "interrupted" | "failed")
    )
}

fn completed(stopped: bool, code: Option<i32>) -> Value {
    json!({"outcome":if stopped {"interrupted"} else {"exited"}, "exitCode":code,"signal":Value::Null})
}

fn as_exit(value: &Value) -> Option<super::process::Exit> {
    matches!(value["outcome"].as_str(), Some("exited" | "interrupted")).then(|| {
        super::process::Exit {
            code: value["exitCode"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok()),
            signal: value["signal"].as_str().map(str::to_owned),
        }
    })
}

fn outcome_failure(outcome: &Value) -> Failure {
    let phase = match outcome["phase"].as_str() {
        Some("definition") => "definition",
        Some("target") => "target",
        Some("environment") => "environment",
        Some("provider") => "provider",
        Some("before-launch") => "before-launch",
        _ => "reconcile",
    };
    Failure::new(
        phase,
        outcome["code"].as_str().unwrap_or("linux-outcome-unknown"),
        outcome["message"]
            .as_str()
            .unwrap_or("The Linux Run outcome is unknown."),
        true,
    )
}

fn unknown() -> Failure {
    Failure::new(
        "reconcile",
        "linux-outcome-unknown",
        "The Linux Run outcome is unknown. Its admitted process was not replaced.",
        true,
    )
}

fn incomplete(job: &LaunchJob, journal: &mut Journal, notice: &str) -> Result<()> {
    job.session.lock().unwrap().output.mark_incomplete();
    job.append(notice);
    if journal.record["outputTruncated"] != true {
        journal.record["outputTruncated"] = json!(true);
        journal.save()?;
    }
    Ok(())
}

fn started(job: &LaunchJob, journal: &Journal, manager: &Manager) {
    let mut state = job.session.lock().unwrap();
    if job.current(&state) {
        state.grace = Duration::from_millis(
            journal.record["stopGracePeriodMs"]
                .as_u64()
                .unwrap_or(DEFAULT_GRACE),
        );
        state.observation["startedAt"] = json!(now());
        state.set_phase(Phase::Running);
        manager.emit(&state);
    }
}
