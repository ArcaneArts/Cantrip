//! Retained labels are presentation evidence; immutable bound ancestry supplies
//! authority. Preserve all observed parents so a later label cannot erase one.
use crate::native_items::{obj, s};
use cantrip_wire::{JsString, Value};
fn optional(value: &Value) -> Value {
    value
        .as_js_string()
        .map(JsString::trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, s)
}
fn fallback<'a>(first: &'a Value, second: &'a Value) -> &'a Value {
    if first.is_null() { second } else { first }
}
pub fn segments(value: &Value) -> Vec<Value> {
    let Some(value) = value.as_js_string() else {
        return Vec::new();
    };
    value
        .units()
        .split(|u| matches!(u, 47 | 46 | 62))
        .map(|v| JsString::new(v.to_vec()).trim())
        .filter(|s| !s.is_empty())
        .take(32)
        .map(s)
        .collect()
}
pub fn child(thread: &Value) -> Option<Value> {
    let id = optional(&thread["id"]);
    if id.is_null() {
        return None;
    }
    let source = &thread["source"];
    let sub = fallback(&source["subAgent"], &source["subagent"]);
    let spawn = fallback(&sub["thread_spawn"], &sub["threadSpawn"]);
    let mut parent = optional(&thread["parentThreadId"]);
    if parent.is_null() {
        parent = optional(fallback(
            &spawn["parent_thread_id"],
            &spawn["parentThreadId"],
        ));
    }
    if parent.is_null() {
        return None;
    }
    let depth = spawn["depth"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0. && v.fract() == 0.)
        .map_or(Value::Null, |v| Value::Number(v.min(32.)));
    let mut nickname = optional(&thread["agentNickname"]);
    if nickname.is_null() {
        nickname = optional(fallback(&spawn["agent_nickname"], &spawn["agentNickname"]));
    }
    let mut role = optional(&thread["agentRole"]);
    if role.is_null() {
        role = optional(fallback(&spawn["agent_role"], &spawn["agentRole"]));
    }
    Some(obj([
        ("threadId", id),
        ("parentThreadId", parent),
        ("depth", depth),
        (
            "agentPath",
            optional(fallback(&spawn["agent_path"], &spawn["agentPath"])),
        ),
        ("nickname", nickname),
        ("role", role),
    ]))
}
