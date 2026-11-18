use super::*;
struct Display<'a, 'b> {
    r: &'a Renderer<'b>,
    content: Vec<Value>,
    unresolved: Vec<Value>,
}
impl Display<'_, '_> {
    fn activity(
        &mut self,
        title: JsString,
        details: Value,
        suffix: &str,
        failed: bool,
    ) -> Result<()> {
        let item = self.r.item;
        let mut value = obj([
            ("type", s("nativeItem")),
            ("kind", item["body"]["type"].clone()),
            (
                "id",
                s(concat(&[text(&item["id"])?.clone(), suffix.into()])),
            ),
            ("title", s(title)),
            ("details", details),
            (
                "status",
                s(if failed {
                    "failed"
                } else if item["lifecycle"] == "started" {
                    "running"
                } else {
                    "completed"
                }),
            ),
            (
                "durationMs",
                match (item["startedAtMs"].as_f64(), item["completedAtMs"].as_f64()) {
                    (Some(a), Some(b)) if b >= a => Value::Number(b - a),
                    _ => Value::Null,
                },
            ),
        ]);
        self.r.timestamps(&mut value);
        self.content.push(self.r.activity(value)?);
        Ok(())
    }
    fn missing(&mut self, kind: JsString, index: usize) -> Result<()> {
        self.unresolved
            .push(Renderer::unresolved(kind.clone(), index));
        self.content.push(self.r.notice(
            "Native output content is unavailable in this view.",
            concat(&[
                format!("Output part {}: ", index + 1).into(),
                kind,
                ". Its source record is retained.".into(),
            ]),
            &format!("unavailable:{index}"),
        )?);
        Ok(())
    }
}
type Rendered = Option<(Vec<Value>, Vec<Value>)>;
pub(super) fn render(r: &Renderer<'_>) -> Result<Rendered> {
    let body = &r.item["body"];
    let kind = body["type"].as_str().unwrap_or("");
    if r.item["lifecycle"] == "unknown"
        || !matches!(
            kind,
            "hookPrompt"
                | "interAgentCommunication"
                | "functionCallOutput"
                | "sleep"
                | "imageGeneration"
        )
    {
        return Ok(None);
    }
    let mut d = Display {
        r,
        content: Vec::new(),
        unresolved: Vec::new(),
    };
    match kind {
        "interAgentCommunication" => {
            let Some(description) = native_items::communication(body) else {
                return Ok(None);
            };
            d.activity(
                text(&description["title"])?.clone(),
                description["details"].clone(),
                "",
                false,
            )?;
            if let Some(kind) = description["unavailable"].as_js_string() {
                d.missing(kind.clone(), 0)?;
            }
        }
        "hookPrompt" => {
            let Some(fragments) = body["fragments"].as_array() else {
                return Ok(None);
            };
            if !fragments
                .iter()
                .all(|v| v.is_object() && v["text"].is_string() && v["hookRunId"].is_string())
            {
                return Ok(None);
            }
            for (index, fragment) in fragments.iter().enumerate() {
                d.activity(
                    concat(&[
                        "Hook prompt · ".into(),
                        text(&fragment["hookRunId"])?.clone(),
                    ]),
                    fragment["text"].clone(),
                    &if index > 0 {
                        format!(":fragment:{index}")
                    } else {
                        String::new()
                    },
                    false,
                )?;
            }
            if d.content.is_empty() {
                d.activity("Hook prompt".into(), Value::Null, "", false)?;
            }
        }
        "functionCallOutput" => {
            if body["name"].as_js_string().is_none_or(|v| v.is_empty())
                || (!body["namespace"].is_null() && !body["namespace"].is_string())
            {
                return Ok(None);
            }
            let namespace = body["namespace"]
                .as_js_string()
                .filter(|v| !v.is_empty())
                .map(|v| concat(&[v.clone(), "/".into()]))
                .unwrap_or_else(|| "".into());
            let title = concat(&[
                "Tool output · ".into(),
                namespace,
                text(&body["name"])?.clone(),
            ]);
            if body["output"].is_string() {
                d.activity(title, body["output"].clone(), "", false)?;
            } else if let Some(parts) = body["output"].as_array() {
                d.activity(title.clone(), Value::Null, "", false)?;
                for (index, part) in parts.iter().enumerate() {
                    if part.is_object() {
                        if part["type"] == "input_text" && part["text"].is_string() {
                            d.activity(
                                title.clone(),
                                part["text"].clone(),
                                &format!(":output:{index}"),
                                false,
                            )?;
                            continue;
                        }
                        if (part["type"] == "input_image" || part["type"] == "input_audio")
                            && let Some(resolved) = r.resolved(index)
                        {
                            d.content.extend_from_slice(resolved);
                            continue;
                        }
                        d.missing(
                            part["type"]
                                .as_js_string()
                                .cloned()
                                .unwrap_or_else(|| "unknown".into()),
                            index,
                        )?;
                    } else {
                        d.missing("invalid-tool-output".into(), index)?;
                    }
                }
            } else {
                return Ok(None);
            }
        }
        "sleep" => {
            if !body["durationMs"].as_f64().is_some_and(|v| {
                v.is_finite() && v.fract() == 0. && (0. ..=9_007_199_254_740_991.).contains(&v)
            }) {
                return Ok(None);
            }
            d.activity(
                if r.item["lifecycle"] == "started" {
                    "Waiting"
                } else {
                    "Wait ended"
                }
                .into(),
                s(concat(&[
                    "Requested wait: ".into(),
                    cantrip_wire::coercion::string(&body["durationMs"]).unwrap(),
                    " ms".into(),
                ])),
                "",
                false,
            )?;
        }
        _ => {
            if !body["status"].is_string() || !body["result"].is_string() {
                return Ok(None);
            }
            let failed = body["status"] == "failed" || !body["failure"].is_null();
            let mut details = vec![concat(&["Status: ".into(), text(&body["status"])?.clone()])];
            if let Some(v) = body["revisedPrompt"].as_js_string() {
                details.push(v.clone());
            }
            if let Some(v) = body["savedPath"].as_js_string() {
                details.push(concat(&["Saved path: ".into(), v.clone()]));
            }
            if let Some(v) = body["transparentBackground"].as_bool() {
                details.push(format!("Transparent background: {v}").into());
            }
            if !body["failure"].is_null() {
                details.push(format!("Failure: {}", body["failure"].stringify()).into());
            }
            d.activity(
                "Image generation".into(),
                s(join(details, "\n\n")),
                "",
                failed,
            )?;
            if !text(&body["result"])?.is_empty() {
                if let Some(resolved) = r.resolved(0) {
                    d.content.extend_from_slice(resolved);
                } else {
                    d.missing("generated-image".into(), 0)?;
                }
            } else if r.item["lifecycle"] == "completed" && !failed {
                d.missing("generated-image".into(), 0)?;
            }
        }
    }
    Ok(Some((d.content, d.unresolved)))
}
