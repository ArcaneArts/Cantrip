use crate::{
    codex::{
        catalog::account_home,
        guest_environment::{self, Environment},
        managed::Profile,
        provider_errors::surround,
    },
    filesystem::paths,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, parse_json_text, payload_digest, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::ErrorKind,
    path::{Path, PathBuf},
};

pub(in crate::codex) enum Source<'a> {
    Current(Option<&'a JsString>),
    Held(&'a crate::codex::suspension_store::Opened),
    Staged {
        thread: &'a JsString,
        operation: &'a str,
    },
}

pub(in crate::codex) async fn profile(
    data: &Path,
    scope: &Value,
    source: Source<'_>,
    chat: Option<&JsString>,
    provider: &Value,
    execution: &str,
    global_skill_root: Option<PathBuf>,
    environment: Option<&Environment>,
) -> Result<Profile> {
    let standalone = execution == "standalone-chat";
    let skill_root = if standalone { None } else { global_skill_root };
    let skill_roots = skill_root
        .iter()
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>();
    let provider_key = provider["credentialHomeKey"]
        .as_js_string()
        .or_else(|| provider["id"].as_js_string())
        .ok_or_else(|| anyhow!("Missing native provider identity."))?;
    let configuration = sha256(&json!({
        "providerId":provider["id"], "providerName":provider["name"], "providerKind":provider["kind"],
        "providerAccountId":provider["accountId"], "credentialHomeKey":provider["credentialHomeKey"],
        "baseUrl":provider["baseUrl"], "apiKey":provider["apiKey"], "executionProfile":execution,
        "globalSkillRoots":skill_roots
    }).stringify());
    let mut id = surround("", provider_key, &format!(":{}", &configuration[..16]));
    let configuration_home = if matches!(provider["kind"].as_str(), Some("chatgpt" | "grok")) {
        account_home(data, provider_key)
    } else {
        data.join("codex-home")
    };
    // Callers without the admitted guest authority must never reopen a
    // recorded OS conversation in the default worker-local environment.
    if environment.is_none()
        && let Some(chat) = chat
        && guest_environment::stored(&guest_environment::record_path(data, scope, chat))?.is_some()
    {
        bail!("Native observation of an OS-hosted conversation is not implemented yet.");
    }

    let mut overlay = None;
    let guest_home = environment.map(|environment| {
        id = surround("", &id, &format!(":os:{}", environment.id));
        overlay = Some(configuration_home.clone());
        let home = sha256(
            &Value::Array(vec![
                json!(&environment.id),
                json!(paths::text(&configuration_home)),
                provider["id"].clone(),
                provider["credentialHomeKey"].clone(),
            ])
            .stringify(),
        );
        data.join("codex-os-homes").join(home)
    });
    let runtime_home = match source {
        Source::Held(saved) => {
            let operation = cantrip_history::source_digest(&json!([
                json!(
                    saved
                        .home
                        .to_str()
                        .ok_or_else(|| anyhow!("Invalid native suspension home."))?
                ),
                json!(chat.context("The saved suspension requires its chat identity.")?),
                saved.source["threadId"].clone(),
                saved.evidence["suspension"]["checkpointId"].clone(),
            ]));
            id = surround("", &id, &format!(":namespace:suspension:{operation}"));
            overlay = Some(configuration_home);
            saved.home.clone()
        }
        Source::Staged { thread, operation } => {
            id = surround("", &id, &format!(":namespace:{operation}"));
            overlay = Some(configuration_home);
            root(data, scope, thread).join("homes").join(operation)
        }
        Source::Current(thread) => {
            if let Some(thread) = thread
                && let Some((operation, home)) =
                    selection(data, scope, thread, chat, provider).await?
            {
                id = surround("", &id, &format!(":namespace:{operation}"));
                overlay = Some(configuration_home);
                home
            } else if standalone {
                data.join("codex-standalone-homes")
                    .join(sha256(&id.lossy()))
            } else {
                guest_home.unwrap_or(configuration_home)
            }
        }
    };
    let mut profile = Profile::new(id, runtime_home);
    profile.configuration_home = overlay;
    profile.extra_skill_roots.extend(skill_root);
    Ok(profile)
}

async fn selection(
    data: &Path,
    scope: &Value,
    thread: &JsString,
    chat: Option<&JsString>,
    provider: &Value,
) -> Result<Option<(String, PathBuf)>> {
    let root = root(data, scope, thread);
    let Some(head) = current(&root, scope, thread).await? else {
        return Ok(None);
    };
    if chat.is_some_and(|chat| head["chatId"].as_js_string() != Some(chat))
        || ["id", "kind", "accountId"]
            .iter()
            .any(|field| head["provider"][*field] != provider[*field])
    {
        bail!("The managed runtime route changed. Reload the canonical conversation binding.");
    }
    let operation = head["operationId"].as_str().unwrap().to_owned();
    Ok(Some((
        operation.clone(),
        root.join("homes").join(operation),
    )))
}

fn root(data: &Path, scope: &Value, thread: &JsString) -> PathBuf {
    let scope_key = payload_digest(&json!([
        scope["serverId"].clone(),
        scope["ownerId"].clone(),
        scope["workerId"].clone()
    ]));
    data.join("managed-native-namespaces")
        .join(scope_key)
        .join(payload_digest(&json!(thread)))
}

async fn current(root: &Path, scope: &Value, thread: &JsString) -> Result<Option<Value>> {
    let mut directory = match tokio::fs::read_dir(root.join("selections")).await {
        Ok(directory) => directory,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut records = HashMap::<String, Value>::new();
    let mut parents = HashSet::new();
    while let Some(entry) = directory.next_entry().await? {
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(".json") {
            continue;
        }
        let raw = tokio::fs::read(entry.path()).await?;
        let record = parse_json_text(&String::from_utf8_lossy(&raw))
            .map_err(|_| anyhow!("Invalid managed runtime namespace journal JSON."))?;
        let operation = validate_record(&record, scope, thread)?;
        if name != format!("{operation}.json").as_str() {
            bail!("Managed runtime namespace journal identity mismatch.");
        }
        if let Some(parent) = record["previousOperationId"].as_str() {
            parents.insert(parent.to_owned());
        }
        records.insert(operation.to_owned(), record);
    }
    if records.is_empty() {
        return Ok(None);
    }
    let mut heads = records
        .iter()
        .filter(|(operation, _)| !parents.contains(*operation));
    let Some((_, head)) = heads.next().filter(|_| heads.next().is_none()) else {
        bail!("Managed runtime namespace history has conflicting selections.");
    };
    let mut visited = HashSet::new();
    let mut cursor = head;
    loop {
        if !visited.insert(cursor["operationId"].as_str().unwrap())
            || cursor["chatId"] != head["chatId"]
        {
            bail!("Managed runtime namespace history is inconsistent.");
        }
        let Some(parent) = cursor["previousOperationId"].as_str() else {
            break;
        };
        cursor = records
            .get(parent)
            .ok_or_else(|| anyhow!("Managed runtime namespace history is incomplete."))?;
    }
    if visited.len() != records.len() {
        bail!("Managed runtime namespace history has disconnected selections.");
    }
    Ok(Some(head.clone()))
}

pub(in crate::codex) async fn current_operation(
    data: &Path,
    scope: &Value,
    thread: &JsString,
) -> Result<Value> {
    Ok(current(&root(data, scope, thread), scope, thread)
        .await?
        .map_or(Value::Null, |record| record["operationId"].clone()))
}

/// Publish the native home only after Core commits the matching destination.
pub(in crate::codex) async fn select_committed(
    data: &Path,
    scope: &Value,
    handoff: &Value,
    provider: &Value,
    previous: &Value,
) -> Result<()> {
    use cantrip_history::files::{ensure_directory, queue, read_json, write_immutable};
    let source = &handoff["source"];
    let binding = &handoff["binding"];
    let prepared = &handoff["prepared"];
    let attributed = &prepared["snapshot"]["modelAttribution"]["selection"];
    let thread = source["threadId"]
        .as_js_string()
        .context("Missing handoff thread")?
        .clone();
    if !matches!(handoff["phase"].as_str(), Some("committed" | "completed"))
        || handoff["workerId"] != scope["workerId"]
        || source["workerId"] != scope["workerId"]
        || source["chatId"] != handoff["chatId"]
        || binding["chatId"] != handoff["chatId"]
        || binding["threadId"] != source["threadId"]
        || binding["runtimeGeneration"] != prepared["runtimeGeneration"]
        || prepared["threadId"] != source["threadId"]
        || attributed["status"] != "resolved"
        || attributed["workerId"] != scope["workerId"]
        || attributed["routeId"] != handoff["targetModelRouteId"]
        || attributed["providerId"] != provider["id"]
        || attributed["providerAccountId"] != provider["accountId"]
        || provider["accountId"] != handoff["targetProviderAccountId"]
    {
        bail!("A namespace selection requires the committed destination binding.");
    }
    let record = json!({
        "version":1, "scope":scope, "chatId":handoff["chatId"], "threadId":thread,
        "operationId":handoff["operationId"], "previousOperationId":previous,
        "provider":json!({"id":provider["id"],"kind":provider["kind"],"accountId":provider["accountId"]}),
    });
    let operation = validate_record(&record, scope, &thread)?.to_owned();
    let root = root(data, scope, &thread);
    let directory = root.join("selections");
    let scope = scope.clone();
    queue(&directory)
        .run_async(async move {
            let last = current(&root, &scope, &thread).await?;
            if let Some(last) = last.as_ref()
                && last["operationId"] == record["operationId"]
            {
                if last != &record {
                    bail!("Conflicting managed namespace retry.");
                }
                return Ok(());
            }
            if last
                .as_ref()
                .map_or(&Value::Null, |last| &last["operationId"])
                != &record["previousOperationId"]
                || last
                    .as_ref()
                    .is_some_and(|last| last["chatId"] != record["chatId"])
            {
                bail!("Managed runtime namespace source was replaced.");
            }
            ensure_directory(&directory)?;
            let filename = directory.join(format!("{operation}.json"));
            if !write_immutable(&filename, &record.stringify())? && read_json(&filename)? != record
            {
                bail!("Conflicting managed namespace publication.");
            }
            if current(&root, &scope, &thread).await?.as_ref() != Some(&record) {
                bail!("Managed runtime namespace was superseded during publication.");
            }
            Ok(())
        })
        .await
}

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_id(value: &Value) -> bool {
    value
        .as_js_string()
        .is_some_and(|text| (1..=255).contains(&text.units().len()))
}

fn uuid(value: &Value) -> Option<&str> {
    let value = value.as_str()?;
    let parsed = uuid::Uuid::parse_str(value).ok()?;
    (parsed.hyphenated().to_string().eq_ignore_ascii_case(value)
        && (parsed.is_nil()
            || parsed.is_max()
            || (parsed.get_variant() == uuid::Variant::RFC4122
                && (1..=8).contains(&parsed.get_version_num()))))
    .then_some(value)
}

fn validate_record<'a>(record: &'a Value, scope: &Value, thread: &JsString) -> Result<&'a str> {
    let operation = uuid(&record["operationId"]);
    let provider = &record["provider"];
    if record.as_object().is_none_or(|fields| fields.len() != 7)
        || record["version"].as_i64() != Some(1)
        || !is_id(&record["chatId"])
        || !is_id(&record["threadId"])
        || operation.is_none()
        || record
            .get("previousOperationId")
            .is_none_or(|parent| !parent.is_null() && uuid(parent).is_none())
        || provider.as_object().is_none_or(|fields| fields.len() != 3)
        || !is_id(&provider["id"])
        || !is_id(&provider["kind"])
        || provider
            .get("accountId")
            .is_none_or(|account| !account.is_null() && !is_id(account))
        || ["serverId", "ownerId", "workerId"]
            .iter()
            .any(|field| !is_id(&record["scope"][*field]))
    {
        bail!("Invalid managed runtime namespace journal record.");
    }
    if &record["scope"] != scope || record["threadId"].as_js_string() != Some(thread) {
        bail!("Managed runtime namespace journal identity mismatch.");
    }
    Ok(operation.unwrap())
}
