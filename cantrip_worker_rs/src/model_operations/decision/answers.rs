use super::{Adapter, OPERATION, either};
use anyhow::{Context, Result};
use cantrip_wire::{Value, coercion, value::json};
use std::collections::HashMap;

pub(super) fn parse(raw: &Value, questions: &Value, adapter: Adapter) -> Result<Vec<Value>> {
    let questions = questions
        .as_array()
        .context("Validated decision questions")?;
    let mut indexed = HashMap::with_capacity(questions.len());
    if adapter == Adapter::OpenAi {
        let answers = raw
            .as_array()
            .filter(|answers| answers.len() == questions.len())
            .ok_or_else(|| OPERATION.malformed())?;
        for answer in answers {
            let name = answer["name"]
                .as_js_string()
                .ok_or_else(|| OPERATION.malformed())?;
            if indexed.insert(name, answer).is_some() {
                return Err(OPERATION.malformed());
            }
        }
    } else {
        let answers = raw
            .as_object()
            .filter(|answers| answers.len() == questions.len())
            .ok_or_else(|| OPERATION.malformed())?;
        indexed.extend(answers);
    }
    questions
        .iter()
        .map(|question| {
            let id = question["id"]
                .as_js_string()
                .context("Validated question ID")?;
            let answer = indexed.get(id).ok_or_else(|| OPERATION.malformed())?;
            normalize(answer, question, adapter)
        })
        .collect()
}

fn numeric(value: &Value, range: std::ops::RangeInclusive<f64>) -> Result<f64> {
    value
        .as_f64()
        .filter(|value| range.contains(value))
        .ok_or_else(|| OPERATION.malformed())
}

fn distribution(
    raw: &Value,
    options: &[Value],
    score: bool,
    adapter: Adapter,
) -> Result<Option<(Vec<Value>, f64)>> {
    if raw.is_null() {
        return Ok(None);
    }
    let mut probabilities = vec![None; options.len()];
    let mut sum = 0.0;
    let mut insert = |label: &Value, probability: &Value| -> Result<()> {
        let index = options
            .iter()
            .enumerate()
            .position(|(index, option)| {
                if score {
                    label.as_u64() == Some(index as u64) || label == index.to_string().as_str()
                } else {
                    label == &option["id"]
                }
            })
            .ok_or_else(|| OPERATION.malformed())?;
        let probability = numeric(probability, 0.0..=1.0)?;
        if probabilities[index].replace(probability).is_some() {
            return Err(OPERATION.malformed());
        }
        sum += probability;
        Ok(())
    };
    if adapter == Adapter::OpenAi {
        let entries = raw
            .as_array()
            .filter(|entries| entries.len() == options.len())
            .ok_or_else(|| OPERATION.malformed())?;
        for entry in entries {
            if score && let Some(label) = entry.get("label") {
                let index = coercion::number(entry.get("value"))
                    .ok()
                    .filter(|index| *index >= 0.0 && index.fract() == 0.0)
                    .and_then(|index| options.get(index as usize));
                if index.map(|option| &option["id"]) != Some(label) {
                    return Err(OPERATION.malformed());
                }
            }
            insert(&entry["value"], &entry["probability"])?;
        }
    } else {
        let entries = raw
            .as_object()
            .filter(|entries| entries.len() == options.len())
            .ok_or_else(|| OPERATION.malformed())?;
        for (key, probability) in coercion::entries(entries) {
            insert(&Value::String(key.clone()), probability)?;
        }
    }
    if (sum - 1.0).abs() > 0.01 {
        return Err(OPERATION.malformed());
    }
    let mut weighted = 0.0;
    let values = probabilities
        .into_iter()
        .zip(options)
        .enumerate()
        .map(|(index, (probability, option))| {
            let probability = probability.ok_or_else(|| OPERATION.malformed())?;
            weighted += (index as f64) * probability;
            Ok(json!({"id":option["id"],"probability":probability}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some((values, weighted)))
}

fn normalize(raw: &Value, question: &Value, adapter: Adapter) -> Result<Value> {
    if !raw.is_object() {
        return Err(OPERATION.malformed());
    }
    let mut answer = json!({"id":question["id"],"nativeAnswer":raw});
    if raw["type"] == "refusal" {
        let reason = either(&raw["refusal"], &raw["reason"]);
        if !reason.is_null() && !reason.is_string() {
            return Err(OPERATION.malformed());
        }
        answer["type"] = json!("refusal");
        answer["reason"] = reason.clone();
        return Ok(answer);
    }
    if raw["type"] == "error" || !raw["error"].is_null() {
        answer["type"] = json!("error");
        answer["error"] = either(&raw["error"], raw).clone();
        return Ok(answer);
    }
    let kind = question["type"]
        .as_str()
        .context("Validated question type")?;
    let openai = adapter == Adapter::OpenAi;
    let native_kind = if kind == "predicate" && !openai {
        "noul"
    } else {
        kind
    };
    if raw["type"] != native_kind {
        return Err(OPERATION.malformed());
    }
    answer["type"] = json!(kind);
    if kind == "predicate" {
        answer["probability"] = json!(numeric(
            &raw[if openai { "probability" } else { "noul" }],
            0.0..=1.0,
        )?);
        return Ok(answer);
    }

    let score = kind == "score";
    let options = question[if score { "levels" } else { "choices" }]
        .as_array()
        .context("Validated decision options")?;
    let confidence = &raw["confidence"];
    answer["confidence"] = if confidence.is_null() {
        Value::Null
    } else {
        json!(numeric(confidence, 0.0..=1.0)?)
    };
    let probabilities = distribution(&raw["probabilities"], options, score, adapter)?;
    if score {
        let score = numeric(&raw["score"], 0.0..=(options.len() as f64 - 1.0))?;
        if probabilities.as_ref().is_some_and(|(_, weighted)| {
            (score - weighted).abs() > 0.01 * options.len() as f64 + 0.001
        }) {
            return Err(OPERATION.malformed());
        }
        answer["score"] = json!(score);
        answer["levels"] = question["levels"].clone();
        answer["semantics"] = json!("probability-weighted-zero-based-index");
    } else {
        if !options.iter().any(|option| option["id"] == raw["choice"]) {
            return Err(OPERATION.malformed());
        }
        answer["choice"] = raw["choice"].clone();
    }
    answer["probabilities"] = probabilities.map_or(Value::Null, |(values, _)| json!(values));
    Ok(answer)
}
