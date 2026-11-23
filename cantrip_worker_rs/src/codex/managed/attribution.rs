//! Preserve the model selection witnessed at native turn start.
use crate::http::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use std::collections::HashMap;

const RECENT_TURNS: usize = 4096;

#[derive(Clone)]
struct Models {
    root: Value,
    child: Value,
    scope: Value,
}

struct Turn {
    anchor: Value,
    scope: Value,
    is_root: bool,
    evidence: Option<Value>,
}

pub(super) struct Attribution {
    native_provider: &'static str,
    inventory: Value,
    roots: HashMap<JsString, Models>,
    active: HashMap<JsString, (JsString, Models)>,
    captures: IndexMap<(JsString, JsString), Turn>,
}

impl Attribution {
    pub(super) fn new(native_provider: &'static str, inventory: Value) -> Self {
        Self {
            native_provider,
            inventory,
            roots: HashMap::new(),
            active: HashMap::new(),
            captures: IndexMap::new(),
        }
    }

    pub(super) fn bind(&mut self, thread: &JsString, root: &Value, child: &Value, scope: Value) {
        let anchor = |model: &Value| {
            json!({
                "id":model["id"], "routeId":model["routeId"], "name":model["name"],
            })
        };
        self.roots.insert(
            thread.clone(),
            Models {
                root: anchor(root),
                child: anchor(if child.is_object() { child } else { root }),
                scope,
            },
        );
    }

    pub(super) fn notification(&mut self, method: &JsString, params: &Value) -> Option<Value> {
        let thread = params["threadId"].as_js_string()?;
        match method.as_str()? {
            "turn/started" => {
                let turn = params["turn"]["id"].as_js_string()?;
                let mut enriched = params.clone();
                if let Some(capture) = self.capture(thread, turn, params) {
                    enriched["cantripModelAttribution"] = capture;
                    return Some(enriched);
                }
                if let Value::Object(fields) = &mut enriched
                    && fields
                        .shift_remove(&JsString::from("cantripModelAttribution"))
                        .is_some()
                {
                    return Some(enriched);
                }
            }
            "turn/completed" => {
                if let Some(turn) = params["turn"]["id"].as_js_string()
                    && self
                        .active
                        .get(turn)
                        .is_some_and(|(root, _)| root == thread)
                {
                    self.active.remove(turn);
                }
            }
            "thread/closed" | "thread/status/changed"
                if method.as_str() == Some("thread/closed")
                    || params["status"]["type"] == "notLoaded" =>
            {
                self.roots.remove(thread);
                self.active.retain(|_, (root, _)| root != thread);
            }
            _ => {}
        }
        None
    }

    fn capture(&mut self, thread: &JsString, turn: &JsString, params: &Value) -> Option<Value> {
        let key = (thread.clone(), turn.clone());
        if !self.captures.contains_key(&key) {
            let (models, is_root) = if let Some(models) = self.roots.get(thread) {
                self.active.retain(|_, (root, _)| root != thread);
                self.active
                    .insert(turn.clone(), (thread.clone(), models.clone()));
                (models, true)
            } else {
                // The causal root can arrive before the native spawn item.
                // History independently verifies the child's actual ancestry.
                let root = params["turn"]["rootTurnId"].as_js_string()?;
                (&self.active.get(root)?.1, false)
            };
            let native = Turn {
                anchor: if is_root {
                    models.root.clone()
                } else {
                    models.child.clone()
                },
                scope: models.scope.clone(),
                is_root,
                evidence: None,
            };
            if self.captures.len() >= RECENT_TURNS {
                self.captures.shift_remove_index(0);
            }
            self.captures.insert(key.clone(), native);
        }
        self.evidence(&key, &params["initialSettings"])
    }

    fn evidence(&mut self, key: &(JsString, JsString), observed: &Value) -> Option<Value> {
        let turn = self.captures.get_mut(key)?;
        if let Some(evidence) = &turn.evidence {
            return Some(evidence.clone());
        }
        let settings = checked("nativeHistoryInitialTurnSettingsSchema", observed).ok()?;
        let effort = settings
            .get("effectiveReasoningEffort")
            .filter(|value| !value.is_null())
            .unwrap_or(&settings["reasoningEffort"]);
        let evidence = checked(
            "nativeTurnModelAttributionSchema",
            &json!({
                "threadId":key.0, "turnId":key.1, "isRoot":turn.is_root,
                "selection":selection(self.native_provider, &self.inventory, &settings, turn),
                "reasoningEffort":effort,
            }),
        )
        .ok()?;
        turn.evidence = Some(evidence.clone());
        Some(evidence)
    }

    pub(super) fn add_to_snapshot(&mut self, thread: &JsString, snapshot: &mut Value) {
        if let Value::Object(snapshot) = snapshot
            && let Some(Value::Object(history)) = snapshot.get_mut(&JsString::from("history"))
            && let Some(Value::Array(turns)) = history.get_mut(&JsString::from("turns"))
        {
            let missing = Value::Null;
            for turn in turns {
                let settings = if turn["initialSettingsConflict"] == true {
                    &missing
                } else {
                    &turn["initialSettings"]
                };
                let capture = turn["turnId"]
                    .as_js_string()
                    .and_then(|id| self.evidence(&(thread.clone(), id.clone()), settings));
                let Value::Object(fields) = turn else {
                    continue;
                };
                let field = JsString::from("cantripModelAttribution");
                if let Some(capture) = capture {
                    fields.insert(field, capture);
                } else {
                    fields.shift_remove(&field);
                }
            }
        }
    }
}

fn selection(native_provider: &str, inventory: &Value, settings: &Value, turn: &Turn) -> Value {
    let unavailable = json!({"status":"unavailable"});
    if settings["modelProvider"] != native_provider {
        return unavailable;
    }
    let name = &settings["model"];
    let resolved = |model: &Value| {
        checked(
            "nativeModelAttributionSchema",
            &json!({
                "status":"resolved",
                "workerId":turn.scope["workerId"], "providerId":turn.scope["providerId"],
                "providerAccountId":turn.scope["providerAccountId"],
                "modelId":model["id"], "routeId":model["routeId"],
            }),
        )
        .unwrap_or_else(|_| unavailable.clone())
    };
    if turn.anchor["name"] == *name {
        return resolved(&turn.anchor);
    }
    if inventory.is_null()
        || ["workerId", "providerId", "providerAccountId"]
            .iter()
            .any(|field| inventory[*field] != turn.scope[*field])
    {
        return unavailable;
    }
    let mut matches = inventory["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["name"] == *name);
    match (matches.next(), matches.next()) {
        (Some(model), None) => resolved(model),
        (Some(_), Some(_)) => json!({"status":"ambiguous"}),
        _ => json!({"status":"unmapped"}),
    }
}
