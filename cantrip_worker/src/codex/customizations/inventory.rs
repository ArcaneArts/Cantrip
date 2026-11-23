use super::{TIMEOUT, Target, entries, external, integer, mcp, nonempty, optional, skills};
use crate::codex::discovery::feature_usable;
use anyhow::Result;
use cantrip_wire::{Value, value::json};

pub(super) async fn read(target: &Target<'_>) -> Result<Value> {
    let native = if available(target.report, "skills/list") {
        skills::list(target.runtime, target.cwd, target.force_reload, TIMEOUT).await?
    } else {
        (Vec::new(), Vec::new())
    };
    let skills = skill_inventory(native.0, &native.1)?;
    let hooks = if available(target.report, "hooks/list") {
        let response = target
            .runtime
            .request(
                "hooks/list".into(),
                Some(json!({"cwds":[target.cwd]})),
                Some(TIMEOUT),
                None,
            )
            .await?
            .unwrap_or(Value::Null);
        hook_inventory(skills::group_for_cwd(&response, target.cwd)?.unwrap_or(&Value::Null))
    } else {
        hook_inventory(&Value::Null)
    };
    let servers = if available(target.report, "mcpServerStatus/list") {
        mcp::inventory(target).await?
    } else {
        Vec::new()
    };
    let roots = target.runtime.project_skill_roots().read().await;
    Ok(
        json!({"capabilities":capabilities(target.report),"skills":skills,"skillRoots":&*roots,"hooks":hooks,"mcpServers":servers}),
    )
}

fn errors<'a>(entries: impl IntoIterator<Item = &'a Value>) -> Vec<Value> {
    entries.into_iter().filter_map(|error| {
        let message = nonempty(&error["message"])?;
        Some(json!({"path":error["path"].as_js_string().cloned().unwrap_or_else(|| "".into()),"message":message}))
    }).collect()
}

fn skill_inventory(items: Vec<Value>, issues: &[Value]) -> Result<Value> {
    let mut items = items.iter().filter_map(|entry| {
        let path = skills::settings::native_skill_path(entry)?;
        let name = entry["name"].as_js_string()?.trim();
        Some(json!({
            "name":name,"description":entry["description"].as_js_string().cloned().unwrap_or_else(|| "".into()),
            "displayName":optional(&entry["interface"]["displayName"]),"path":path,"scope":entry["scope"],
            "enabled":entry["enabled"] != false,
        }))
    }).collect::<Vec<_>>();
    let collator = skills::settings::sorting()?;
    items.sort_by(|a, b| skills::settings::compare(&collator, a, b, "name"));
    Ok(json!({"items":items,"errors":errors(issues)}))
}

fn hook_inventory(group: &Value) -> Value {
    let hooks = entries(group,"hooks").filter_map(|hook| {
        let key = nonempty(&hook["key"])?;
        let event = nonempty(&hook["eventName"])?;
        let handler = nonempty(&hook["handlerType"])?;
        let source_path = nonempty(&hook["sourcePath"])?;
        let trust = hook["trustStatus"].as_str().unwrap_or("untrusted");
        let command = if matches!(trust,"managed" | "trusted") { optional(&hook["command"]) } else { Value::Null };
        Some(json!({
            "key":key,"eventName":event,"handlerType":handler,"sourcePath":source_path,"trust":trust,
            "matcher":optional(&hook["matcher"]),"command":command,"statusMessage":optional(&hook["statusMessage"]),
            "timeoutSeconds":integer(&hook["timeoutSec"]).unwrap_or_default(),
            "source":hook["source"].as_str().unwrap_or("unknown"),"pluginId":optional(&hook["pluginId"]),
            "enabled":hook["enabled"] == true,"managed":hook["isManaged"] == true,
        }))
    }).collect::<Vec<_>>();
    let warnings = entries(group, "warnings")
        .filter_map(Value::as_js_string)
        .collect::<Vec<_>>();
    json!({"items":hooks,"warnings":warnings,"errors":errors(entries(group,"errors"))})
}

fn available(report: &Value, name: &str) -> bool {
    report["methods"][name] == "available"
}

fn capability(ready: bool, reason: &str, stability: &str) -> Value {
    json!({"available":ready,"reason":if ready {None} else {Some(reason)},"stability":stability})
}

fn capabilities(report: &Value) -> Value {
    let method = |name: &str, stability| {
        capability(
            available(report, name),
            &format!("The installed Codex runtime does not advertise {name}."),
            stability,
        )
    };
    let feature = |name: &str, methods: &[&str]| {
        let usable = feature_usable(report, &json!(name));
        let methods = methods.iter().all(|name| available(report, name));
        let reason = if usable {
            format!("The installed Codex runtime is missing one or more {name} App Server methods.")
        } else {
            format!("The installed Codex runtime does not enable the {name} feature.")
        };
        capability(usable && methods, &reason, "stable")
    };
    let subagents = &report["nativeSubagents"];
    let subagents_available =
        subagents["available"] == true && subagents["protocolVersion"].as_u64() == Some(1);
    let mut native_subagents = capability(
        subagents_available,
        subagents["reason"]
            .as_str()
            .unwrap_or("The installed Codex runtime does not support native subagents."),
        "stable",
    );
    if subagents_available {
        native_subagents["protocolVersion"] = subagents["protocolVersion"].clone();
    } else {
        native_subagents["protocolVersion"] = Value::Null;
    }
    let plugins = capability(
        false,
        "Plugin operations are unavailable in Cantrip.",
        "unsupported",
    );
    let external_apply = capability(
        available(report, external::DETECT) && available(report, external::IMPORT),
        "The installed Codex runtime is missing one or more methods required for validated external configuration imports.",
        "experimental",
    );
    json!({
        "isolatedCodexHome":true,
        "collaborationModes":method("collaborationMode/list","experimental"),
        "threadGoals":feature("goals",&["thread/goal/get","thread/goal/set","thread/goal/clear"]),
        "nativeSubagents":native_subagents,
        "customAgents":capability(false,"This Codex App Server version has no project or personal custom-agent discovery method. Native subagents remain available independently.","unsupported"),
        "hooks":feature("hooks",&["hooks/list"]),
        "skills":json!({
            "list":method("skills/list","stable"), "extraRoots":method("skills/extraRoots/set","stable"),
            "configure":capability(available(report,"skills/list") && available(report,"skills/config/write"),
                "The installed Codex runtime is missing one or more methods required for validated skill configuration.","stable"),
        }),
        "mcp":json!({
            "status":method("mcpServerStatus/list","stable"),"resourceRead":method("mcpServer/resource/read","stable"),
            "reload":method("config/mcpServer/reload","stable"),"oauth":method(super::oauth::LOGIN,"stable"),
        }),
        "plugins":json!({"list":plugins,"read":plugins,"install":plugins,"uninstall":plugins}),
        "externalImports":json!({"detect":method(external::DETECT,"experimental"),"apply":external_apply}),
    })
}
