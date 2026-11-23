//! Pure existing usage reconciliation. The caller supplies its locale comparator.
use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value, coercion::truthy, value::json};

pub fn reconcile(
    previous: Option<&Value>,
    incoming: &Value,
    compare: impl Fn(&JsString, &JsString) -> std::cmp::Ordering,
) -> Result<(Value, Option<Value>)> {
    let mut responses: Vec<Value> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();
    for evidence in previous.into_iter().chain(std::iter::once(incoming)) {
        for id in evidence["conflictingResponseIds"]
            .as_array()
            .context("Native usage conflicts")?
        {
            if !conflicts.contains(id) {
                conflicts.push(id.clone());
            }
        }
    }
    for evidence in previous.into_iter().chain(std::iter::once(incoming)) {
        for response in evidence["responses"]
            .as_array()
            .context("Native usage responses")?
        {
            if let Some(retained) = responses
                .iter()
                .find(|r| r["responseId"] == response["responseId"])
            {
                if response["usage"]
                    .as_object()
                    .context("Native usage counts")?
                    .iter()
                    .any(|(key, value)| retained["usage"].get(key.as_str().unwrap()) != Some(value))
                    && !conflicts.contains(&response["responseId"])
                {
                    conflicts.push(response["responseId"].clone());
                }
            } else {
                responses.push(response.clone());
            }
        }
    }
    responses.sort_by(|a, b| {
        compare(
            a["responseId"].as_js_string().unwrap(),
            b["responseId"].as_js_string().unwrap(),
        )
    });
    conflicts.sort_by(|a, b| {
        a.as_js_string()
            .unwrap()
            .units()
            .cmp(b.as_js_string().unwrap().units())
    });
    let complete_set = |e: Option<&Value>| {
        e.is_some_and(|e| {
            truthy(e.get("complete"))
                && responses.iter().all(|r| {
                    e["responses"].as_array().is_some_and(|rows| {
                        rows.iter().any(|row| row["responseId"] == r["responseId"])
                    })
                })
        })
    };
    let retained = previous.and_then(|p| p.get("modelAttribution"));
    let capture = incoming.get("modelAttribution");
    if let Some((a, b)) = retained.zip(capture) {
        let a = crate::response::parse_response("nativeTurnModelAttributionSchema", Some(a))?;
        let b = crate::response::parse_response("nativeTurnModelAttributionSchema", Some(b))?;
        anyhow::ensure!(
            a.stringify() == b.stringify(),
            "Native usage model attribution conflicts with retained evidence."
        );
    }
    let complete = conflicts.is_empty() && (complete_set(previous) || complete_set(Some(incoming)));
    let mut evidence = json!({"version":1,"responses":responses,"conflictingResponseIds":conflicts,"complete":complete});
    if let Some(capture) = retained.or(capture) {
        evidence["modelAttribution"] = capture.clone();
    }
    let mut totals = json!({"totalTokens":0,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0});
    for response in evidence["responses"].as_array().unwrap() {
        if evidence["conflictingResponseIds"]
            .as_array()
            .unwrap()
            .contains(&response["responseId"])
        {
            continue;
        }
        for key in [
            "totalTokens",
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
            "reasoningOutputTokens",
        ] {
            let total = totals[key].as_f64().unwrap()
                + response["usage"][key]
                    .as_f64()
                    .context("Response usage count")?;
            if !total.is_finite() || total.fract() != 0.0 || total.abs() > 9007199254740991.0 {
                evidence["complete"] = json!(false);
                return Ok((evidence, None));
            }
            totals[key] = json!(total);
        }
    }
    Ok((evidence, Some(totals)))
}
