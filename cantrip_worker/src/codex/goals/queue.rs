//! Materialize authenticated queued actions for their selected native session.
use super::Goals;
use crate::{
    attachments::{Store, content},
    chat_content::{Scope, queue},
    codex::{
        preparation::command::collaboration_mode,
        turn::{Turns, runtime_text, settings::UPDATE, shell},
    },
    native_items::{array, concat, join, text},
};
use anyhow::{Context, Result, bail};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use cantrip_crypto::Zeroizing;
use cantrip_history::{
    canonical::open_message,
    content::Encryption,
    files::{ensure_directory, write_immutable, write_immutable_bytes},
};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use uuid::Uuid;

pub(crate) const EXECUTE: &str = "chat.queue.execute";

impl Goals {
    pub(crate) async fn execute_queued(
        &self,
        command: &Value,
        turns: &Turns,
        acknowledge: impl FnOnce(&Value) + Send,
    ) -> Result<Value> {
        let method = match command["executionMethod"].as_str() {
            Some("thread/goal/set") => "thread/goal/set",
            Some("thread/goal/clear") => "thread/goal/clear",
            Some(UPDATE) => UPDATE,
            Some(shell::METHOD) => shell::METHOD,
            _ => bail!("This queued native action is unavailable."),
        };
        let bound = self.encryption.bound_identity()?;
        let mut command = self.preparation.resolve_routing(command).await?;
        let scope = Scope::new(self.encryption.clone())?;
        if scope.owner != bound.0 || bound.1.as_js_string() != Some(&scope.server) {
            bail!("The worker binding changed before opening queued native input.");
        }
        let input = open_input(&scope, &command)?;
        command["operationId"] = json!(concat(&[
            "queue:".into(),
            text(&command["queueClaim"]["id"])?.clone()
        ]));
        if method == shell::METHOD {
            if input.action != "runShell" {
                bail!("The queued shell action differs from its protected input.");
            }
            let program = queue::native_text(&input.items)?;
            let units = program.units();
            let program = if units.first() == Some(&(b'!' as u16)) {
                JsString::new(units[1..].to_vec())
            } else {
                program
            };
            return turns
                .run_queued_shell(&command, scope, program, acknowledge)
                .await;
        }
        let (thread, owner) = self.chat_goal_thread(&command, &bound).await?;
        if command["threadId"].as_js_string() != Some(&thread) || owner.session.is_none() {
            bail!("The queued action requires its bound managed thread.");
        }
        let mut params = json!({"threadId":thread});
        if method == UPDATE {
            let submitted = queue::native_text(&input.items)?;
            if input.action != "parseSlash"
                || !queue::slash_argument(&submitted, "/plan")
                    .is_some_and(|argument| argument.is_empty())
            {
                bail!("The queued settings action differs from its protected input.");
            }
            params["operationId"] = command["operationId"].clone();
            params["collaborationMode"] =
                collaboration_mode(&owner.runtime, &json!("plan"), &command["model"]).await?;
            return self
                .apply_mutation(&command, turns, &bound, owner, method, params)
                .await;
        }
        let home = owner.runtime.codex_home().to_path_buf();
        let work = command.clone();
        let store = self.attachments.clone();
        let keys = content::ServiceKeys(self.encryption.clone());
        let action = tokio::task::spawn_blocking(move || {
            scope.identity()?;
            goal_action(input, &work, &home, &store, &keys, &scope)
        })
        .await??;
        match (method, action) {
            ("thread/goal/clear", Action::Clear) => {}
            ("thread/goal/set", Action::Status(status)) => params["status"] = json!(status),
            ("thread/goal/set", Action::Objective(objective)) => {
                params["objective"] = json!(objective)
            }
            _ => bail!("The queued Goal classification changed."),
        }
        self.watch_project(&command, &bound, &thread, &owner.runtime);
        self.apply_mutation(&command, turns, &bound, owner, method, params)
            .await
    }
}

struct Input {
    action: String,
    items: Vec<Value>,
    represented: Vec<Value>,
}

fn open_input(scope: &Scope, command: &Value) -> Result<Input> {
    let prompt = &command["protectedPrompt"];
    if prompt["classification"]["role"] != "user" {
        bail!("Queued native input must be a protected user message.");
    }
    let material = scope.material(None)?;
    let parts = open_message(&material.key, &json!(material.owner_id), prompt)?;
    let display = join(
        array(&parts)?
            .iter()
            .filter(|part| part["type"] == "text")
            .map(runtime_text)
            .collect::<Result<Vec<_>>>()?,
        "\n\n",
    )
    .trim();
    let display = if display.is_empty() {
        "Review the attached files and respond to the user.".into()
    } else {
        display
    };
    let payload = &command["protectedNativeInput"];
    let declared = command["nativeAction"].as_str();
    if payload.is_null() {
        return Ok(Input {
            action: declared.unwrap_or("literal").into(),
            items: vec![queue::text_input(&display)],
            represented: Vec::new(),
        });
    }
    let opened = queue::open_native(
        scope,
        &command["chatId"],
        &command["queuedPromptId"],
        payload,
        &display,
        array(&prompt["classification"]["attachmentIds"])?,
    )?;
    let action = opened["action"]
        .as_str()
        .context("Missing protected queue action.")?;
    if opened["executionMethod"] != command["executionMethod"]
        || declared.is_some_and(|declared| declared != action)
    {
        bail!("The queued action differs from its protected input.");
    }
    let mut represented = opened["representedAttachmentIds"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    represented.extend(
        array(&opened["attachmentMap"])?
            .iter()
            .map(|mapping| mapping["id"].clone()),
    );
    let items = array(&opened["input"])?.to_vec();
    Ok(Input {
        action: action.into(),
        items,
        represented,
    })
}

enum Action {
    Clear,
    Status(&'static str),
    Objective(JsString),
}

fn goal_action(
    mut input: Input,
    command: &Value,
    home: &Path,
    store: &Store,
    keys: &content::ServiceKeys,
    scope: &Scope,
) -> Result<Action> {
    if input.action == "runShell" {
        bail!("The queued Goal cannot be a shell action.");
    }
    if command["executionMethod"] == "thread/goal/set" {
        for raw in array(&command["attachments"])? {
            if input.represented.contains(&raw["id"]) {
                continue;
            }
            if raw["chatId"] != command["chatId"] {
                bail!("The queued attachment belongs to another chat.");
            }
            let metadata = content::open_for(keys, raw, Some((&scope.owner, &scope.server)))?;
            let path = store.resolve(
                text(&raw["chatId"])?,
                text(&raw["id"])?,
                text(&metadata["fileName"])?,
            )?;
            let mime = text(&metadata["mimeType"])?.lossy();
            let kind = metadata["kind"]
                .as_str()
                .context("Missing queued attachment kind.")?;
            if matches!(kind, "image" | "audio") {
                let bytes = Zeroizing::new(fs::read(path)?);
                let url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes[..]));
                input.items.push(json!({"type":kind,"url":url}));
            } else {
                let reference = format!(
                    "\n\nAttachments are stored outside the repository on this worker. Read them from these paths as needed:\n- {} ({mime}, {} bytes): {}",
                    text(&metadata["fileName"])?.lossy(),
                    metadata["sizeBytes"].stringify(),
                    path.display(),
                );
                input.items.push(queue::text_input(&reference.into()));
            }
        }
    }
    let original = queue::native_text(&input.items)?;
    let objective = if input.action == "parseSlash" {
        let argument = queue::slash_argument(&original, "/goal")
            .context("This queued slash command has no native Goal mapping.")?;
        match argument.lossy().to_lowercase().as_str() {
            "" | "edit" => bail!("This queued Goal opens an interactive native view."),
            "clear" => return Ok(Action::Clear),
            "pause" => return Ok(Action::Status("paused")),
            "resume" => return Ok(Action::Status("active")),
            _ => argument,
        }
    } else {
        original.trim()
    };
    if command["executionMethod"] != "thread/goal/set" || objective.is_empty() {
        bail!("The queued Goal objective is empty or has a different action.");
    }
    scope.identity()?;
    Ok(Action::Objective(materialize(
        home,
        &command["queuedPromptId"],
        input.items,
        objective,
    )?))
}

fn materialize(
    home: &Path,
    prompt: &Value,
    items: Vec<Value>,
    objective: JsString,
) -> Result<JsString> {
    let rich = items.iter().any(|item| item["type"] != "text");
    if !rich && char::decode_utf16(objective.units().iter().copied()).count() <= 4000 {
        return Ok(objective);
    }
    let identity = Value::Array(vec![prompt.clone(), Value::Array(items), json!(objective)]);
    let hash = Sha256::digest(identity.stringify().as_bytes());
    let mut id: [u8; 16] = hash[..16].try_into().unwrap();
    id[6] = (id[6] & 15) | 64;
    id[8] = (id[8] & 63) | 128;
    let directory = home
        .join("attachments")
        .join(Uuid::from_bytes(id).to_string());
    ensure_directory(&directory)?;
    let mut full = objective.lossy().into_owned();
    if rich {
        full.push_str("\n\nReferenced input:");
    }
    let inputs = &array(&identity)?[1];
    for (index, item) in array(inputs)?
        .iter()
        .filter(|item| item["type"] != "text")
        .enumerate()
    {
        let kind = item["type"]
            .as_str()
            .context("Missing rich Goal input kind.")?;
        let reference = match kind {
            "image" | "audio" => {
                let url = text(&item["url"])?.lossy();
                if let Some((mime, bytes)) = url
                    .strip_prefix("data:")
                    .and_then(|url| url.split_once(";base64,"))
                    .filter(|(mime, bytes)| {
                        !mime.contains([',', ';'])
                            && !mime.is_empty()
                            && !bytes.is_empty()
                            && bytes.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || b"+/=\r\n".contains(&byte)
                            })
                    })
                {
                    let bytes = bytes.replace(['\r', '\n'], "");
                    let content = Zeroizing::new(
                        STANDARD
                            .decode(&bytes)
                            .or_else(|_| STANDARD_NO_PAD.decode(&bytes))?,
                    );
                    let extension = match mime {
                        "image/png" => "png",
                        "image/jpeg" => "jpg",
                        "image/webp" => "webp",
                        "image/gif" => "gif",
                        "audio/wav" => "wav",
                        "audio/mpeg" => "mp3",
                        "audio/ogg" => "ogg",
                        "audio/mp4" => "m4a",
                        _ => "bin",
                    };
                    let path = directory.join(format!("{kind}-{}.{extension}", index + 1));
                    write_immutable_bytes(&path, &content)?;
                    path.display().to_string()
                } else {
                    url.into_owned()
                }
            }
            "localImage" | "localAudio" => text(&item["path"])?.lossy().into_owned(),
            "skill" | "mention" => {
                full.push_str(&format!(
                    "\n- {kind} {}: {}",
                    text(&item["name"])?.lossy(),
                    text(&item["path"])?.lossy()
                ));
                continue;
            }
            _ => bail!("Unknown rich Goal input."),
        };
        full.push_str(&format!("\n- {kind}: {reference}"));
    }
    if full.chars().count() <= 4000 {
        return Ok(full.into());
    }
    let path = directory.join("goal-objective.md");
    write_immutable(&path, &full)?;
    Ok(format!(
        "Read the Codex goal objective file at {} before continuing.",
        path.display()
    )
    .into())
}
