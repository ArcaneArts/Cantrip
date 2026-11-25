//! The worker opens protected conditions and prepares turns. Core owns the
//! schedule, occurrence lease, idempotency key, and any turn admission.
mod scheduler;
pub(crate) use scheduler::Scheduler;

use crate::{
    chat_content,
    encryption::Service,
    filesystem::{Scope, paths},
    github,
    http::checked,
    routing::Registry,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::content::{ProjectAutomationField, open_project_automation};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{path::Path, sync::Arc, time::Duration};

pub(crate) const PROTECT: &str = "automation.dispatch.protect";

fn open(
    service: &Service,
    identity: &(JsString, JsString),
    automation: &Value,
    name: ProjectAutomationField,
    envelope: &Value,
) -> Result<Value> {
    let revision = envelope["keyRevision"]
        .as_u64()
        .context("Automation key revision.")?;
    let grant = service.bound_component("workflow-content", Some(revision))?;
    ensure!(
        grant.owner_id == identity.0 && grant.server_id.as_js_string() == Some(&identity.1),
        "The worker binding changed during protected automation dispatch."
    );
    open_project_automation(
        &grant.component.key,
        &json!(grant.owner_id),
        automation,
        name,
        grant.component.key_revision,
        envelope,
    )
}

async fn script(scope: &Scope, cwd: &Path, source: &JsString) -> Result<bool> {
    #[cfg(windows)]
    let (program, arguments) = (
        "powershell.exe",
        &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"][..],
    );
    #[cfg(not(windows))]
    let (program, arguments) = ("/bin/sh", &["-lc"][..]);
    let mut child = tokio::process::Command::new(program);
    child
        .args(arguments)
        .arg(paths::native(source).as_os_str())
        .current_dir(cwd);
    let result =
        Box::pin(scope.capture_configured(child, 1024 * 1024, Duration::from_secs(30), None))
            .await
            .map_err(|_| anyhow!("Could not execute the protected automation condition."))?;
    ensure!(!result.timed_out, "The automation condition timed out.");
    ensure!(
        result.overflow.is_none(),
        "The automation condition exceeded its output limit."
    );
    Ok(result
        .code
        .context("The automation condition was interrupted.")?
        == 0)
}

async fn allowed(
    condition: &Value,
    command: &Value,
    routing: &Registry,
    github: &github::Client,
    scope: &Scope,
    chat: &chat_content::Scope,
) -> Result<bool> {
    if condition.is_null() {
        return Ok(true);
    }
    match condition["type"].as_str() {
        Some("script") => {
            let resolved = routing.resolve(&json!({"cwd":command["cwd"]})).await?;
            let cwd = resolved["cwd"]
                .as_js_string()
                .context("Missing automation checkout.")?;
            let source = condition["script"]
                .as_js_string()
                .context("Missing automation condition.")?;
            chat.identity()?;
            script(scope, &paths::native(cwd), source).await
        }
        Some("open-issues") => {
            let resolved = routing
                .resolve(&json!({"repository":command["repository"]}))
                .await?;
            let repository = resolved["repository"]
                .as_js_string()
                .context("Open-issue conditions require a GitHub-backed project repository.")?;
            chat.identity()?;
            let count = github
                .count_open_issues(repository, scope)
                .await
                .map_err(|_| anyhow!("Could not read the automation's GitHub issue count."))?;
            Ok(count
                >= condition["minimum"]
                    .as_f64()
                    .context("Missing automation issue threshold.")?)
        }
        _ => Err(anyhow!("Unsupported project automation condition.")),
    }
}

pub(crate) async fn protect(
    service: Arc<Service>,
    routing: &Registry,
    github: &github::Client,
    scope: &Scope,
    command: &Value,
) -> Result<Value> {
    let chat = chat_content::Scope::new(service.clone())?;
    let identity = chat.identity()?;
    let content = &command["content"];
    let id = &command["automationId"];
    let name = open(
        &service,
        &identity,
        id,
        ProjectAutomationField::Name,
        &content["protectedName"],
    )?;
    let prompt = open(
        &service,
        &identity,
        id,
        ProjectAutomationField::Prompt,
        &content["protectedPrompt"],
    )?;
    let condition = open(
        &service,
        &identity,
        id,
        ProjectAutomationField::Condition,
        &content["protectedCondition"],
    )?;
    chat.identity()?;
    scope.check()?;
    let council = command["targetKind"] == "council";
    let allowed = if council {
        ensure!(
            condition["condition"].is_null(),
            "Council routines schedule prompts without shell or project conditions."
        );
        true
    } else {
        allowed(
            &condition["condition"],
            command,
            routing,
            github,
            scope,
            &chat,
        )
        .await?
    };
    scope.check()?;
    chat.identity()?;
    let turn = if allowed {
        let mut draft = command.clone();
        draft["text"] = prompt["prompt"].clone();
        if command["runId"].is_string() {
            draft["automation"] = json!({
                "automationId":id, "runId":command["runId"], "name":name["name"],
                "targetKind":if council { "council" } else { "project" },
            });
        }
        chat_content::turn_with_attachments(&chat, &draft, &[])?
    } else {
        Value::Null
    };
    chat.identity()?;
    checked(
        "projectAutomationProtectedDispatchResultSchema",
        &json!({"allowed":allowed,"protectedTurn":turn}),
    )
}
