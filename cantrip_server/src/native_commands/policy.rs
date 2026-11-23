use super::CommandError;
use crate::wire::{Value, coercion::truthy};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Read,
    Attach,
    Start,
    Control,
    Settings,
    Defaults,
    Mutation,
    Reply,
}
#[derive(Debug, Serialize)]
pub struct Policy {
    pub kind: Kind,
    pub active: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    methods: HashMap<String, Kind>,
    server_requests: HashSet<String>,
    sets: HashMap<String, HashSet<String>>,
}
static INVENTORY: LazyLock<Inventory> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../contracts/native-command-policy.json"))
        .expect("Embedded native command inventory")
});

pub fn classify(method: &str) -> Option<Kind> {
    INVENTORY.methods.get(method).copied()
}
pub fn managed_server_request(method: &str) -> bool {
    INVENTORY.server_requests.contains(method)
}
pub fn contains(set: &str, value: &str) -> bool {
    INVENTORY
        .sets
        .get(set)
        .is_some_and(|set| set.contains(value))
}
fn reject<T>(code: &'static str) -> Result<T> {
    Err(CommandError::new(code, None, 409).into())
}
fn unsupported_keys(input: &Value, set: &str) -> Result<bool> {
    let keys = input["intent"]["settingKeys"]
        .as_array()
        .context("Native setting keys")?;
    Ok(keys
        .iter()
        .any(|key| key.as_str().is_none_or(|key| !contains(set, key))))
}
/// Classify the actual method independently of the caller's authority labels.
pub fn classify_admission(input: &Value) -> Result<Policy> {
    // Registry entries are ASCII; a lossy UTF-8 view of an unpaired UTF-16
    // surrogate still cannot match any entry, just like the Source Map lookup.
    let name = input["method"]
        .as_js_string()
        .context("Native command method")?
        .lossy();
    let method = name.as_ref();
    let intent = &input["intent"];
    if truthy(intent.get("settingsBindingId"))
        && !((method == "thread/settings/update"
            && truthy(intent.get("nativeSettingsOperationId")))
            || matches!(method, "config/value/write" | "config/batchWrite"))
    {
        return reject("invalid-settings-binding-scope");
    }
    if truthy(intent.get("nativeSettingsOperationId")) && method != "thread/settings/update" {
        return reject("invalid-settings-operation-scope");
    }
    if method == "serverRequest/reply" {
        if !truthy(input.get("reply"))
            || !input["reply"]["requestMethod"]
                .as_str()
                .is_some_and(|method| INVENTORY.server_requests.contains(method))
        {
            return reject("unsupported-reply");
        }
        return Ok(Policy {
            kind: Kind::Reply,
            active: true,
        });
    }
    if truthy(input.get("reply")) {
        return reject("invalid-reply-scope");
    }
    let Some(kind) = (if method == "thread/queue/start" {
        Some(Kind::Mutation)
    } else {
        classify(method)
    })
    .filter(|kind| *kind != Kind::Read) else {
        return reject("unsupported-mutation");
    };
    if kind == Kind::Defaults {
        if intent["scope"] != "account-defaults"
            || intent["configTarget"] != "account-defaults"
            || !matches!(method, "config/value/write" | "config/batchWrite")
            || unsupported_keys(input, "defaultKeys")?
        {
            return reject("unsupported-default-scope");
        }
    } else if intent["scope"] != "thread" {
        return reject("invalid-target-scope");
    }
    if kind == Kind::Settings
        && (method == "thread/managedConfig/update" || unsupported_keys(input, "settingKeys")?)
    {
        return reject("unsupported-settings");
    }
    if kind == Kind::Mutation
        && !contains("activeMutations", method)
        && !contains("scopedMutations", method)
    {
        return reject("unsupported-mutation");
    }
    Ok(Policy {
        kind,
        active: kind == Kind::Control
            || contains("activeMutations", method)
            || method == "turn/settings/update",
    })
}
