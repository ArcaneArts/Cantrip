use super::*;
use super::{
    capture::capture,
    mcp::{failure, result_text},
};
fn status(value: &Value) -> Value {
    if value == "inProgress" {
        s("running")
    } else {
        value.clone()
    }
}
fn tail(value: &JsString) -> JsString {
    slice(value, value.len().saturating_sub(8192), value.len())
}
pub fn latest_changed_line(diff: &JsString) -> Option<JsString> {
    let (mut added, mut removed) = (None, None);
    for line in diff.units().split(|&u| u == 10) {
        if line.starts_with(&[43]) && !line.starts_with(&[43, 43, 43, 32]) {
            added = Some(JsString::new(line[1..].to_vec()));
        } else if line.starts_with(&[45]) && !line.starts_with(&[45, 45, 45, 32]) {
            removed = Some(JsString::new(line[1..].to_vec()));
        }
    }
    added.or(removed).map(|v| tail(&v))
}
pub fn changed_lines_preview(diff: &JsString) -> Option<JsString> {
    let lines = diff
        .units()
        .split(|&u| u == 10)
        .filter(|line| {
            (line.starts_with(&[43]) && !line.starts_with(&[43, 43, 43, 32]))
                || (line.starts_with(&[45]) && !line.starts_with(&[45, 45, 45, 32]))
        })
        .map(|v| JsString::new(v.to_vec()));
    let joined = join(lines, "\n");
    (!joined.is_empty()).then(|| tail(&joined))
}
fn file_preview(change: &Value) -> Result<Value> {
    let mut result = obj([]);
    if !cantrip_wire::coercion::truthy(change.get("diff")) {
        return Ok(result);
    }
    let diff = text(&change["diff"])?;
    if change["kind"]["type"] == "update" {
        if let Some(v) = latest_changed_line(diff) {
            result["latestLine"] = s(v);
        }
        if let Some(v) = changed_lines_preview(diff) {
            result["diffPreview"] = s(v);
        }
    } else {
        let mut diff = tail(diff).units().to_vec();
        if diff.last() == Some(&10) {
            diff.pop();
            if diff.last() == Some(&13) {
                diff.pop();
            }
        }
        let count = diff.iter().filter(|&&u| u == 10).count();
        let lines: Vec<_> = diff
            .split(|&u| u == 10)
            .enumerate()
            .map(|(i, line)| {
                if i < count {
                    line.strip_suffix(&[13]).unwrap_or(line)
                } else {
                    line
                }
            })
            .collect();
        result["latestLine"] = s(JsString::new(lines.last().unwrap().to_vec()));
        let marker = if change["kind"]["type"] == "add" {
            "+"
        } else {
            "-"
        };
        result["diffPreview"] = s(tail(&join(
            lines
                .iter()
                .map(|line| concat(&[marker.into(), JsString::new(line.to_vec())])),
            "\n",
        )));
    }
    Ok(result)
}
fn safe_url(value: &Value) -> Result<JsString> {
    let value = text(value)?;
    if let Ok(mut url) = url::Url::parse(&value.lossy()) {
        // WHATWG opaque paths percent-encode a trailing space before query/hash.
        if url.cannot_be_a_base()
            && (url.query().is_some() || url.fragment().is_some())
            && let Some(path) = url.path().strip_suffix(' ')
        {
            url.set_path(&format!("{path}%20"));
        }
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        Ok(url.to_string().into())
    } else {
        Ok(JsString::new(
            value
                .units()
                .split(|u| matches!(u, 35 | 63))
                .next()
                .unwrap()
                .to_vec(),
        ))
    }
}
fn search_action(item: &Value) -> Result<Value> {
    let action = &item["action"];
    if !cantrip_wire::coercion::truthy(Some(action)) {
        return Ok(Value::Null);
    }
    let has_url = cantrip_wire::coercion::truthy(action.get("url"));
    Ok(match action["type"].as_str() {
        Some("open_page") => s(if has_url {
            concat(&["Opened ".into(), safe_url(&action["url"])?])
        } else {
            "Opened a page".into()
        }),
        Some("find_in_page") => {
            let location = if has_url {
                concat(&[" in ".into(), safe_url(&action["url"])?])
            } else {
                "".into()
            };
            s(if cantrip_wire::coercion::truthy(action.get("pattern")) {
                concat(&[
                    "Found “".into(),
                    cantrip_wire::coercion::string(&action["pattern"])
                        .map_err(|_| anyhow!("Invalid search pattern."))?,
                    "”".into(),
                    location,
                ])
            } else {
                concat(&["Searched within a page".into(), location])
            })
        }
        Some("search") => {
            let queries = if !action["queries"].is_null() {
                array(&action["queries"])?.to_vec()
            } else if cantrip_wire::coercion::truthy(action.get("query")) {
                vec![action["query"].clone()]
            } else {
                Vec::new()
            };
            s(if queries.is_empty() {
                "Searched".into()
            } else {
                concat(&[
                    "Searched ".into(),
                    join(
                        queries.iter().map(|v| {
                            cantrip_wire::coercion::string(v).unwrap_or_else(|_| "".into())
                        }),
                        ", ",
                    ),
                ])
            })
        }
        Some("other") => s("Web search"),
        _ => action["type"].clone(),
    })
}
/// The actual thread-item normalizer. Telemetry retains independent observed
/// timestamps, command tails, file-change previews and an optional status override.
pub fn normalize(
    item: &Value,
    cwd: &Value,
    lifecycle: &str,
    correlation: &Value,
    telemetry: &Value,
) -> Result<Option<Value>> {
    let kind = item["type"].as_str().unwrap_or("");
    let mut v = obj([("id", item["id"].clone())]);
    let raw = if cantrip_wire::coercion::truthy(telemetry.get("captureRaw")) {
        Some(capture(item, telemetry)?)
    } else {
        None
    };
    let running = if lifecycle == "started" {
        "running"
    } else {
        "completed"
    };
    match kind {
        "interAgentCommunication" => {
            let Some(description) = communication(item) else {
                return Ok(None);
            };
            v["type"] = s("nativeItem");
            v["kind"] = s(kind);
            copy(&mut v, &description, &["title"]);
            v["details"] = description
                .get("details")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| {
                    s(
                        if description["unavailable"] == "encrypted-agent-communication" {
                            "Encrypted agent message; text unavailable."
                        } else {
                            "Agent message text unavailable."
                        },
                    )
                });
            v["status"] = s(running);
            v["durationMs"] = match (
                telemetry["startedAtMs"].as_f64(),
                telemetry["completedAtMs"].as_f64(),
            ) {
                (Some(a), Some(b)) if b >= a => Value::Number(b - a),
                _ => Value::Null,
            };
        }
        "commandExecution" => {
            v["type"] = s("command");
            copy(&mut v, item, &["command", "exitCode"]);
            v["cwd"] = paths::display(cwd, &item["cwd"])?;
            v["status"] = status(&item["status"]);
            if let Some(output) = item.get("aggregatedOutput") {
                v["output"] = command_output::transcript(Some(output))?;
            }
            let tail = telemetry
                .get("commandOutput")
                .filter(|v| !v.is_null())
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| command_output::bounded(item.get("aggregatedOutput")))?;
            if let Some(output) = tail.get("output") {
                v["outputTail"] = output.clone();
            }
            if let Some(truncated) = tail.get("truncated") {
                v["outputTruncated"] = truncated.clone();
            }
            v["durationMs"] = item["durationMs"].clone();
        }
        "fileChange" => {
            v["type"] = s("fileChange");
            v["status"] = status(&item["status"]);
            v["changes"] =
                if let Some(changes) = telemetry.get("fileChanges").filter(|v| !v.is_null()) {
                    changes.clone()
                } else {
                    Value::Array(
                        array(&item["changes"])?
                            .iter()
                            .map(|change| {
                                let mut v = obj([
                                    ("path", paths::display(cwd, &change["path"])?),
                                    ("kind", change["kind"]["type"].clone()),
                                ]);
                                let preview = file_preview(change)?;
                                copy(&mut v, &preview, &["latestLine", "diffPreview"]);
                                if let Some(time) = telemetry.get("updatedAtMs") {
                                    v["lastActivityAtMs"] = time.clone();
                                }
                                Ok(v)
                            })
                            .collect::<Result<Vec<_>>>()?,
                    )
                };
        }
        "plan" => {
            v["type"] = s("plan");
            v["status"] = s(running);
            v["text"] = bounded(item.get("text"), 20_000)?
                .as_js_string()
                .cloned()
                .map(s)
                .unwrap_or_else(|| s(""));
            v["explanation"] = Value::Null;
            v["steps"] = Value::Array(Vec::new());
        }
        "reasoning" => {
            v["type"] = s("reasoning");
            v["status"] = s(running);
            v["summary"] = Value::Array(
                array(&item["summary"])?
                    .iter()
                    .map(|part| {
                        bounded(Some(part), 20_000).map(|v| {
                            v.as_js_string()
                                .map(JsString::trim)
                                .unwrap_or_else(|| "".into())
                        })
                    })
                    .collect::<Result<Vec<_>>>()?
                    .into_iter()
                    .filter(|v| !v.is_empty())
                    .take(100)
                    .map(s)
                    .collect(),
            );
        }
        "mcpToolCall" => {
            let codegraph = text(&item["server"])?.lowercase() == JsString::from("codegraph");
            let failure = failure(item)?;
            v["type"] = s("mcpToolCall");
            v["status"] = if failure.is_some() {
                s("failed")
            } else {
                status(&item["status"])
            };
            copy(&mut v, item, &["server", "tool", "durationMs"]);
            v["query"] = if codegraph {
                bounded(
                    item["arguments"].get("query").filter(|v| v.is_string()),
                    4000,
                )?
            } else {
                Value::Null
            };
            v["resultText"] = if codegraph && failure.is_none() {
                result_text(&item["result"])?
            } else {
                Value::Null
            };
            v["error"] = failure
                .as_ref()
                .map_or(Value::Null, |v| v["message"].clone());
            v["errorCode"] = failure.as_ref().map_or(Value::Null, |v| v["code"].clone());
            v["retryable"] = failure
                .as_ref()
                .map_or(Value::Null, |v| v["retryable"].clone());
        }
        "dynamicToolCall" => {
            v["type"] = s(kind);
            v["status"] = status(&item["status"]);
            v["namespace"] = if item["namespace"].is_null() {
                Value::Null
            } else {
                let value = text(&item["namespace"])?.trim();
                if value.is_empty() {
                    Value::Null
                } else {
                    s(value)
                }
            };
            copy(&mut v, item, &["tool", "success", "durationMs"]);
        }
        "collabAgentToolCall" => {
            v["type"] = s("collabToolCall");
            v["status"] = status(&item["status"]);
            copy(&mut v, item, &["tool", "senderThreadId", "model"]);
            v["receiverThreadIds"] = Value::Array(
                array(&item["receiverThreadIds"])?
                    .iter()
                    .take(100)
                    .cloned()
                    .collect(),
            );
            v["prompt"] = bounded(item.get("prompt"), 100_000)?;
            let states = item["agentsStates"]
                .as_object()
                .ok_or_else(|| anyhow!("Invalid native agent states."))?;
            v["agentStates"] = Value::Array(
                cantrip_wire::coercion::entries(states)
                    .into_iter()
                    .filter(|(_, v)| cantrip_wire::coercion::truthy(Some(v)))
                    .take(100)
                    .map(|(id, state)| {
                        let mut v = obj([
                            ("threadId", s(id.clone())),
                            ("message", bounded(state.get("message"), 4000)?),
                        ]);
                        copy(&mut v, state, &["status"]);
                        Ok(v)
                    })
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        "subAgentActivity" => {
            v["type"] = s("subAgent");
            v["status"] = s(if item["kind"] == "started" {
                "running"
            } else if item["kind"] == "interrupted" {
                "failed"
            } else {
                "completed"
            });
            copy(&mut v, item, &["kind", "agentThreadId"]);
            v["agentPath"] = if cantrip_wire::coercion::truthy(item.get("agentPath")) {
                item["agentPath"].clone()
            } else {
                item["agentThreadId"].clone()
            };
        }
        "webSearch" => {
            v["type"] = s(kind);
            v["status"] = s(running);
            let query = bounded(item.get("query"), 4000)?;
            v["query"] = if query.is_null() { s("") } else { query };
            v["action"] = bounded(Some(&search_action(item)?), 4000)?;
        }
        "imageView" => {
            v["type"] = s(kind);
            v["status"] = s(running);
            v["path"] = paths::display(cwd, &item["path"])?;
        }
        "enteredReviewMode" | "exitedReviewMode" => {
            v["type"] = s("reviewMode");
            v["status"] = s(running);
            v["state"] = s(if kind == "enteredReviewMode" {
                "entered"
            } else {
                "exited"
            });
            let review = bounded(item.get("review"), 20_000)?;
            v["review"] = if review.is_null() { s("") } else { review };
        }
        "contextCompaction" => {
            v["type"] = s(kind);
            v["status"] = s(running);
        }
        _ => return Ok(None),
    }
    if kind != "interAgentCommunication"
        && let Some(raw) = raw
    {
        v["raw"] = raw;
    }
    copy(
        &mut v,
        telemetry,
        &["startedAtMs", "updatedAtMs", "completedAtMs"],
    );
    if kind == "commandExecution"
        && let Some(status) = telemetry.get("status")
    {
        v["status"] = status.clone();
    }
    v["correlation"] = correlation.clone();
    Ok(Some(checked("agentActivitySchema", &v)?))
}
