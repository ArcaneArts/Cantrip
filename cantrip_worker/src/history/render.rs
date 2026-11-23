//! Presentation of reduced native evidence. Authorized materialization is
//! supplied by the caller; this code never reads a path or reserves an identity.
mod display;
use crate::native_items::{self, array, checked, concat, join, obj, s, text};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value};

struct Renderer<'a> {
    item: &'a Value,
    context: &'a Value,
    correlation: Value,
}
impl Renderer<'_> {
    fn activity(&self, mut value: Value) -> Result<Value> {
        value["correlation"] = self.correlation.clone();
        if let Some(scope) = self.context.get("agentScope") {
            value["agentScope"] = scope.clone();
        }
        Ok(obj([
            ("type", s("activity")),
            ("activity", checked("agentActivitySchema", &value)?),
        ]))
    }
    fn notice(&self, message: &str, details: JsString, suffix: &str) -> Result<Value> {
        self.activity(obj([
            ("type", s("notice")),
            (
                "id",
                s(concat(&[
                    text(&self.item["id"])?.clone(),
                    format!(":{suffix}").into(),
                ])),
            ),
            ("status", s("completed")),
            ("level", s("warning")),
            ("message", s(message)),
            ("details", s(details)),
            ("willRetry", Value::Null),
        ]))
    }
    fn missing(kind: &str, index: Option<usize>) -> Value {
        obj([
            ("kind", s(kind)),
            (
                "index",
                index.map_or(Value::Null, |v| Value::Number(v as f64)),
            ),
        ])
    }
    fn unresolved(kind: JsString, index: usize) -> Value {
        obj([("kind", s(kind)), ("index", Value::Number(index as f64))])
    }
    fn resolved(&self, index: usize) -> Option<&[Value]> {
        self.context["inputParts"]
            .get(&index.to_string())
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty())
            .map(Vec::as_slice)
    }
    fn timestamps(&self, value: &mut Value) {
        if !self.item["startedAtMs"].is_null() {
            value["startedAtMs"] = self.item["startedAtMs"].clone();
        }
        value["completedAtMs"] = self.item["completedAtMs"].clone();
    }
    fn finish(
        &self,
        component: &str,
        role: &str,
        mut content: Vec<Value>,
        mut unresolved: Vec<Value>,
    ) -> Result<Vec<Value>> {
        if !array(&self.item["conflicts"])?.is_empty() {
            content.push(self.notice("Conflicting native item versions were retained.","The available ordering evidence does not establish which version supersedes the other.".into(),"conflict")?);
            unresolved.push(Self::missing("conflicting-item-versions", None));
        }
        let identity = obj([
            ("threadId", self.context["threadId"].clone()),
            ("turnId", self.context["turnId"].clone()),
            ("itemId", self.item["id"].clone()),
            ("identityKind", self.item["identityKind"].clone()),
            ("component", s(component)),
        ]);
        let mut message = obj([("role", s(role))]);
        if let Some(mode) = self.context.get("mode") {
            message["mode"] = mode.clone();
        }
        message["content"] = checked("chatMessageContentSchema", &Value::Array(content))?;
        Ok(vec![obj([
            ("identity", identity),
            ("source", self.item.clone()),
            ("message", message),
            ("unresolved", Value::Array(unresolved)),
        ])])
    }
}

/// inputParts is an index-keyed object of already authorized content arrays.
/// Rendering preserves their exact source position and grants no file authority.
pub fn item(item: &Value, context: &Value) -> Result<Vec<Value>> {
    if let Some(thread) = context["agentScope"].get("agentThreadId")
        && thread != &context["threadId"]
    {
        bail!("Native history render scope belongs to another thread.");
    }
    let r = Renderer {
        item,
        context,
        correlation: obj([
            ("sourceMethod", s("native-history")),
            ("diagnosticId", Value::Null),
            ("threadId", context["threadId"].clone()),
            ("turnId", context["turnId"].clone()),
            ("itemId", item["id"].clone()),
        ]),
    };
    let body = &item["body"];
    if body["type"] == "userMessage" {
        let mut content = Vec::new();
        let mut unresolved = Vec::new();
        if let Some(parts) = body["content"].as_array() {
            for (index, part) in parts.iter().enumerate() {
                if part.is_object() && part["type"] == "text" && part["text"].is_string() {
                    if !text(&part["text"])?.is_empty() {
                        content.push(obj([("type", s("text")), ("text", part["text"].clone())]));
                    }
                    continue;
                }
                if let Some(resolved) = r.resolved(index) {
                    content.extend_from_slice(resolved);
                    continue;
                }
                let kind = if part.is_object() {
                    part["type"].as_js_string().cloned()
                } else {
                    None
                }
                .unwrap_or_else(|| "unknown".into());
                unresolved.push(Renderer::unresolved(kind.clone(), index));
                content.push(r.notice(
                    "Native input content is unavailable in this view.",
                    concat(&[
                        format!("Input part {}: ", index + 1).into(),
                        kind,
                        ". Its source record is retained.".into(),
                    ]),
                    &format!("input:{index}"),
                )?);
            }
        } else {
            unresolved.push(Renderer::missing("invalid-user-content", None));
        }
        if content.is_empty() {
            content.push(r.notice(
                "This native input has no displayable content.",
                "The input identity and source record are retained.".into(),
                "notice",
            )?);
        }
        if let Some(scope) = context.get("agentScope")
            && scope["isRoot"] != true
        {
            for part in &mut content {
                if part["type"] == "text" {
                    part["agentScope"] = scope.clone();
                    part["correlation"] = r.correlation.clone();
                }
            }
            if !content
                .iter()
                .any(|p| p["type"] == "text" || p["type"] == "activity")
            {
                content.insert(
                    0,
                    r.activity(obj([
                        ("type", s("subAgent")),
                        (
                            "id",
                            s(concat(&[text(&item["id"])?.clone(), ":input".into()])),
                        ),
                        ("status", s("completed")),
                        ("kind", s("interacted")),
                        ("agentThreadId", context["threadId"].clone()),
                        (
                            "agentPath",
                            s(join(
                                array(&scope["agentPath"])?
                                    .iter()
                                    .map(|v| text(v).cloned())
                                    .collect::<Result<Vec<_>>>()?,
                                "/",
                            )),
                        ),
                    ]))?,
                );
            }
        }
        return r.finish("user", "user", content, unresolved);
    }
    if body["type"] == "agentMessage" {
        let content = if body["text"].as_js_string().is_some_and(|v| !v.is_empty()) {
            let mut part = obj([
                ("type", s("text")),
                ("text", body["text"].clone()),
                (
                    "phase",
                    if body["phase"] == "commentary" || body["phase"] == "final_answer" {
                        body["phase"].clone()
                    } else {
                        Value::Null
                    },
                ),
                ("streaming", Value::Bool(item["lifecycle"] == "started")),
                ("correlation", r.correlation.clone()),
            ]);
            if let Some(scope) = context.get("agentScope") {
                part["agentScope"] = scope.clone();
            }
            vec![part]
        } else {
            vec![r.notice(
                "This native assistant item has no displayable text.",
                "The item identity and source record are retained.".into(),
                "notice",
            )?]
        };
        return r.finish(
            "assistant",
            "assistant",
            content,
            if body["text"].is_string() {
                Vec::new()
            } else {
                vec![Renderer::missing("invalid-agent-text", None)]
            },
        );
    }
    if let Some((content, unresolved)) = display::render(&r)? {
        return r.finish("activity", "assistant", content, unresolved);
    }
    if body["type"] == "reasoning" && item["lifecycle"] != "unknown" {
        let summary = if let Some(parts) = body["summaryParts"].as_object() {
            let mut entries: Vec<_> = parts
                .iter()
                .filter(|(key, _)| {
                    key.units() == [48]
                        || key.units().first().is_some_and(|u| (49..=57).contains(u))
                            && key.units().iter().all(|u| (48..=57).contains(u))
                })
                .collect();
            entries.sort_by(|(a, _), (b, _)| {
                a.len().cmp(&b.len()).then_with(|| a.units().cmp(b.units()))
            });
            entries
                .into_iter()
                .map(|(_, value)| value.clone())
                .collect()
        } else {
            body["summary"].as_array().cloned().unwrap_or_default()
        };
        if summary.iter().all(Value::is_string) {
            let mut parts: Vec<_> = summary
                .into_iter()
                .filter(|v| !text(v).unwrap().is_empty())
                .collect();
            if parts.len() > 100 {
                let overflow = join(parts.drain(99..).map(|v| text(&v).unwrap().clone()), "\n\n");
                parts.push(s(overflow));
            }
            let mut activity = obj([
                ("type", s("reasoning")),
                ("id", item["id"].clone()),
                ("summary", Value::Array(parts)),
                (
                    "status",
                    s(if item["lifecycle"] == "completed" {
                        "completed"
                    } else {
                        "running"
                    }),
                ),
            ]);
            r.timestamps(&mut activity);
            return r.finish(
                "activity",
                "assistant",
                vec![r.activity(activity)?],
                Vec::new(),
            );
        }
    }
    let mut limitation = "unsupported-item";
    if item["lifecycle"] != "unknown" {
        let mut telemetry = obj([("captureRaw", Value::Bool(true))]);
        r.timestamps(&mut telemetry);
        match native_items::normalize(
            body,
            &context["cwd"],
            item["lifecycle"].as_str().unwrap_or(""),
            &r.correlation,
            &telemetry,
        ) {
            Ok(Some(mut activity)) => {
                if activity["type"] == "command" && body["aggregatedOutput"].is_string() {
                    activity["output"] = body["aggregatedOutput"].clone();
                }
                if activity["type"] == "plan" && body["text"].is_string() {
                    activity["text"] = body["text"].clone();
                }
                if let Some(scope) = context.get("agentScope") {
                    activity["agentScope"] = scope.clone();
                }
                return r.finish(
                    "activity",
                    "assistant",
                    vec![obj([("type", s("activity")), ("activity", activity)])],
                    Vec::new(),
                );
            }
            Err(_) => limitation = "invalid-item-presentation",
            Ok(None) => {}
        }
    } else {
        limitation = "unknown-item-lifecycle";
    }
    let kind = body["type"]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    r.finish(
        "activity",
        "assistant",
        vec![r.notice(
            "A native history item could not be fully rendered.",
            concat(&[
                "Item type: ".into(),
                kind,
                format!("; {limitation}. Its source record is retained.").into(),
            ]),
            "notice",
        )?],
        vec![Renderer::missing(limitation, None)],
    )
}
