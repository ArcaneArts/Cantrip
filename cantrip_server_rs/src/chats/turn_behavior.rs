//! Content-free reduction of worker observations. Native evidence stays distinct
//! from bootstrap defaults, including missing captures and conflicting evidence.
use crate::wire::{JsString, Value, coercion::truthy, value::json};
use anyhow::{Context, Result};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

pub fn empty_attribution() -> Value {
    json!({"version":1,"turnIds":Vec::<Value>::new(),"captures":Vec::<Value>::new(),"conflictingTurnKeys":Vec::<Value>::new()})
}
fn string(value: &Value) -> Result<JsString> {
    value
        .as_js_string()
        .cloned()
        .context("Behavior observation identity")
}
fn sorted_strings(values: HashSet<JsString>) -> Value {
    let mut values: Vec<_> = values.into_iter().collect();
    values.sort_by(|a, b| a.units().cmp(b.units()));
    Value::Array(values.into_iter().map(Value::String).collect())
}
pub fn merge_attribution(previous: Option<&Value>, incoming: &Value) -> Result<Value> {
    // localeCompare can consider canonically equivalent spellings equal.
    // Stable sorting must then retain the original JavaScript Map order.
    let mut captures = indexmap::IndexMap::<String, Value>::new();
    let (mut conflicts, mut turns) = (HashSet::new(), HashSet::new());
    for raw in [previous, Some(incoming)]
        .into_iter()
        .flatten()
        .filter(|value| truthy(Some(value)))
    {
        let evidence =
            crate::settings::parse_response("nativeBehaviorAttributionSchema", Some(raw))?;
        for turn in evidence["turnIds"].as_array().context("Behavior turns")? {
            turns.insert(string(turn)?);
        }
        for key in evidence["conflictingTurnKeys"]
            .as_array()
            .context("Behavior conflicts")?
        {
            conflicts.insert(string(key)?);
        }
        for capture in evidence["captures"]
            .as_array()
            .context("Behavior captures")?
        {
            turns.insert(string(&capture["turnId"])?);
            let key = Value::Array(vec![capture["threadId"].clone(), capture["turnId"].clone()])
                .stringify();
            if let Some(existing) = captures.get(&key) {
                if existing.stringify() != capture.stringify() {
                    conflicts.insert(key.into());
                }
            } else {
                captures.insert(key, capture.clone());
            }
        }
    }
    let collator = crate::projects::placement::collator()?;
    let mut captures: Vec<_> = captures.into_iter().collect();
    captures.sort_by(|(a, _), (b, _)| {
        collator.compare_utf16_icu4c(
            JsString::from(a.as_str()).units(),
            JsString::from(b.as_str()).units(),
        )
    });
    Ok(
        json!({"version":1,"turnIds":sorted_strings(turns),"captures":Value::Array(captures.into_iter().map(|(_,v)|v).collect()),"conflictingTurnKeys":sorted_strings(conflicts)}),
    )
}
pub fn is_test_command(command: &JsString) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let regex = PATTERN.get_or_init(|| {
        // JavaScript's Unicode RegExp whitespace includes BOM and excludes NEL.
        // Rust's default Unicode \s has different membership.
        let whitespace = r"[\x09-\x0d\x20\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
        let pattern = r"(?iu)(?:^|[;&|]\s*|\s)(?:(?:pnpm|npm|yarn|bun)(?:\s+[^;&|]+)*\s+(?:test|check)(?:\s|$)|vitest(?:\s|$)|jest(?:\s|$)|pytest(?:\s|$)|cargo\s+test(?:\s|$)|go\s+test(?:\s|$)|mvn(?:\s+[^;&|]+)*\s+test(?:\s|$)|(?:\./)?gradlew?(?:\s+[^;&|]+)*\s+test(?:\s|$)|dotnet\s+test(?:\s|$))";
        regex::Regex::new(&pattern.replace(r"\s",whitespace)).expect("Static test-command expression")
    });
    regex.is_match(&command.lossy())
}
fn tool_failed(activity: &Value) -> bool {
    if matches!(activity["status"].as_str(), Some("failed" | "declined")) {
        return true;
    }
    match activity["type"].as_str() {
        Some("command") => {
            activity.get("exitCode") != Some(&Value::Null) && activity["exitCode"] != json!(0)
        }
        Some("mcpToolCall") => activity.get("error") != Some(&Value::Null),
        Some("dynamicToolCall") => activity["success"] == false,
        _ => false,
    }
}
pub struct ModelBehaviorTracker {
    native: Value,
    approvals: HashSet<JsString>,
    compactions: HashSet<JsString>,
    paths: HashSet<JsString>,
    first_activity: Option<i64>,
    first_visible: Option<i64>,
    final_answer: bool,
    tests: HashMap<JsString, (bool, bool)>,
    tools: HashMap<JsString, bool>,
    usage: Value,
}
impl Default for ModelBehaviorTracker {
    fn default() -> Self {
        Self {
            native: empty_attribution(),
            approvals: HashSet::new(),
            compactions: HashSet::new(),
            paths: HashSet::new(),
            first_activity: None,
            first_visible: None,
            final_answer: false,
            tests: HashMap::new(),
            tools: HashMap::new(),
            usage: json!({"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"modelContextWindow":Value::Null,"contextUsedPercent":Value::Null}),
        }
    }
}
impl ModelBehaviorTracker {
    pub fn observe_native_turn(
        &mut self,
        turn: Option<&Value>,
        capture: Option<&Value>,
    ) -> Result<()> {
        let capture = capture.filter(|value| truthy(Some(value)));
        let turn = turn.filter(|value| truthy(Some(value)));
        if capture.is_none()
            && (turn.is_none()
                || self.native["turnIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| Some(v) == turn))
        {
            return Ok(());
        }
        let incoming = json!({"version":1,"turnIds":Value::Array(turn.into_iter().cloned().collect()),"captures":Value::Array(capture.into_iter().cloned().collect()),"conflictingTurnKeys":Vec::<Value>::new()});
        self.native = merge_attribution(Some(&self.native), &incoming)?;
        Ok(())
    }
    pub fn observe_native_event(&mut self, event: &Value) -> Result<()> {
        let (turn, capture) = match event["type"].as_str() {
            Some("agent.protected-message" | "agent.protected-task-message") => (
                event["telemetry"].get("turnId"),
                event["telemetry"].get("nativeModelAttribution"),
            ),
            Some("agent.activity") => (
                event["activity"]["correlation"].get("turnId"),
                event["activity"].get("nativeModelAttribution"),
            ),
            Some("agent.message") => (event["message"]["correlation"].get("turnId"), None),
            Some("agent.checkpoint") => (event.get("turnId"), None),
            Some("agent.interaction.requested" | "agent.interaction.requested.protected") => {
                (event["request"].get("turnId"), None)
            }
            _ => return Ok(()),
        };
        self.observe_native_turn(turn, capture)
    }
    pub fn mark_activity(&mut self, at: i64) {
        self.first_activity.get_or_insert(at);
    }
    pub fn mark_visible(&mut self, final_answer: bool, at: i64) {
        self.mark_activity(at);
        self.first_visible.get_or_insert(at);
        if final_answer {
            self.final_answer = true;
        }
    }
    pub fn mark_approval(&mut self, key: &JsString, at: i64) {
        self.mark_activity(at);
        self.approvals.insert(key.clone());
    }
    pub fn observe_usage(&mut self, usage: &Value, at: i64) {
        self.mark_activity(at);
        self.usage = usage.clone();
    }
    pub fn observe_activity(&mut self, activity: &Value, at: i64) -> Result<()> {
        let kind = activity["type"].as_str();
        if kind == Some("usage") {
            let mut usage = Value::object([] as [(&str, Value); 0]);
            for key in [
                "inputTokens",
                "cachedInputTokens",
                "cacheWriteInputTokens",
                "outputTokens",
                "reasoningOutputTokens",
            ] {
                if let Some(value) = activity["last"].get(key) {
                    usage[key] = value.clone();
                }
            }
            for key in ["modelContextWindow", "contextUsedPercent"] {
                if let Some(value) = activity.get(key) {
                    usage[key] = value.clone();
                }
            }
            self.observe_usage(&usage, at);
            return Ok(());
        }
        self.mark_activity(at);
        if matches!(
            kind,
            Some(
                "command"
                    | "mcpToolCall"
                    | "dynamicToolCall"
                    | "collabToolCall"
                    | "webSearch"
                    | "imageView"
            )
        ) {
            self.tools
                .insert(string(&activity["id"])?, tool_failed(activity));
        }
        if kind == Some("command") && is_test_command(&string(&activity["command"])?) {
            self.tests.insert(
                string(&activity["id"])?,
                (
                    tool_failed(activity),
                    matches!(
                        activity["status"].as_str(),
                        Some("completed" | "failed" | "declined")
                    ),
                ),
            );
        }
        if kind == Some("fileChange") {
            for change in activity["changes"]
                .as_array()
                .context("Behavior file changes")?
            {
                self.paths.insert(string(&change["path"])?);
            }
        }
        if kind == Some("contextCompaction") {
            self.compactions.insert(string(&activity["id"])?);
        }
        Ok(())
    }
    pub fn snapshot(&self) -> Value {
        let date = |at: Option<i64>| {
            at.and_then(crate::wire::date_iso_milliseconds)
                .map(|s| json!(s))
                .unwrap_or(Value::Null)
        };
        let mut result = json!({"nativeAttribution":self.native,"firstActivityAt":date(self.first_activity),"firstVisibleResponseAt":date(self.first_visible),"finalAnswerAppeared":self.final_answer,"toolCallCount":self.tools.len(),"invalidToolCallCount":self.tools.values().filter(|v|**v).count(),"compactionCount":self.compactions.len(),"approvalRequestCount":self.approvals.len()});
        if let Some(usage) = self.usage.as_object() {
            for (key, value) in usage {
                if let Value::Object(object) = &mut result {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
        for (key, value) in [
            ("filesChangedCount", self.paths.len()),
            ("testCommandCount", self.tests.len()),
            (
                "testPassCount",
                self.tests
                    .values()
                    .filter(|(failed, terminal)| *terminal && !*failed)
                    .count(),
            ),
            (
                "testFailureCount",
                self.tests
                    .values()
                    .filter(|(failed, terminal)| *terminal && *failed)
                    .count(),
            ),
        ] {
            result[key] = json!(value);
        }
        result
    }
}
