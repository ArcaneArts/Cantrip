use super::{either, error, invalid, media, unsupported};
use crate::codex::observation::normalize_base_url;
use anyhow::{Context, Result};
use cantrip_wire::{
    JsString, Value,
    value::{Object, json},
};
use url::Url;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Adapter {
    OpenAi,
    SystemOne,
    OpenRouter,
}

impl Adapter {
    pub fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "openai-decisions",
            Self::SystemOne => "system-one",
            Self::OpenRouter => "openrouter-decisions",
        }
    }

    fn select(route: &Value, family: &str) -> Result<Self> {
        let unavailable = || {
            error(
                "configuration-required",
                "This connection does not expose the configured native decision API.",
            )
        };
        if matches!(family, "chatgpt" | "grok") {
            return Err(unavailable());
        }
        let adapter = either(
            &route["adapter"],
            &route["capabilities"]["decision"]["adapter"],
        );
        Ok(match adapter.as_str() {
            Some("openai-decisions") => Self::OpenAi,
            Some("system-one") => Self::SystemOne,
            Some("openrouter-decisions") => Self::OpenRouter,
            None if family == "openrouter" => Self::OpenRouter,
            None if matches!(family, "ollama" | "llama-cpp" | "vllm" | "unsloth") => {
                Self::SystemOne
            }
            None => Self::OpenAi,
            _ => return Err(unavailable()),
        })
    }

    fn endpoint(self, base: &Url, family: &str) -> Result<Url> {
        let root = base.as_str().trim_end_matches('/');
        if root.ends_with("/decisions") || root.ends_with("/systemone") {
            return Ok(Url::parse(root)?);
        }
        let uri = match self {
            Self::OpenRouter => match root.strip_suffix("/v1") {
                Some(prefix) => format!("{prefix}/alpha/decisions"),
                None => format!("{root}/decisions"),
            },
            Self::SystemOne
                if !root.ends_with("/v1") && (family == "ollama" || base.path() == "/") =>
            {
                format!("{root}/v1/systemone")
            }
            Self::SystemOne => format!("{root}/systemone"),
            Self::OpenAi => format!("{root}/decisions"),
        };
        Ok(Url::parse(&uri)?)
    }
}

pub(super) struct Payload {
    pub adapter: Adapter,
    pub url: Url,
    pub body: Value,
}

const EMBEDDING_OPTIONS: &[&str] = &[
    "dimensions",
    "inputType",
    "encodingFormat",
    "normalization",
    "embeddingSpace",
    "vectorRepresentation",
    "poolingTask",
    "messageRole",
];
const RESERVED: &[&str] = &[
    "model",
    "input",
    "state",
    "questions",
    "images",
    "audio",
    "videos",
    "files",
    "assets",
    "messages",
    "provider",
    "stream",
    "api_key",
    "apikey",
    "api-key",
    "access_token",
    "base_url",
    "api_base",
    "baseurl",
    "headers",
    "extra_headers",
    "authorization",
];

fn combined_state(state: &Value, parts: Vec<Value>) -> Value {
    if parts.is_empty() {
        return state.clone();
    }
    Value::Array(std::iter::once(state.clone()).chain(parts).collect())
}

pub(super) fn payload(
    route: &Value,
    provider: &Value,
    input: &Value,
    options: &Value,
) -> Result<Payload> {
    let base = normalize_base_url(
        provider["baseUrl"]
            .as_str()
            .context("Decision provider URL")?,
    )?;
    let mut family = provider["kind"]
        .as_str()
        .context("Decision provider kind")?;
    if family == "openai-compatible"
        && base
            .host_str()
            .is_some_and(|host| host == "openrouter.ai" || host.ends_with(".openrouter.ai"))
    {
        family = "openrouter";
    }
    let adapter = Adapter::select(route, family)?;
    if EMBEDDING_OPTIONS.iter().any(|key| !options[*key].is_null()) {
        return Err(invalid(
            "Embedding options cannot be used for a native decision request.",
        ));
    }
    let mut body = super::super::object(&options["parameters"]);
    if body.keys().any(|key| {
        key.lowercase()
            .as_str()
            .is_some_and(|key| RESERVED.contains(&key))
    }) {
        return Err(invalid(
            "Additional parameters cannot replace decision inputs, routing, credentials or typed questions.",
        ));
    }
    body.insert("model".into(), route["modelName"].clone());
    let parts = input["media"].as_array().map_or(&[][..], Vec::as_slice);
    let questions = input["questions"]
        .as_array()
        .context("Validated decision questions")?;
    let state = &input["state"];
    let format = options["mediaFormat"].as_str();
    let routing = &options["providerRouting"];
    let typesafe = options["typesafeImages"] == true;

    if adapter == Adapter::OpenAi {
        let gateway_media = family == "litellm" || format == Some("media-urls");
        if !gateway_media && parts.iter().any(|part| part["type"] != "image") {
            return Err(unsupported(
                "The OpenAI Decisions envelope accepts images, text and JSON, not audio or video.",
            ));
        }
        if !routing.is_null()
            || format.is_some_and(|format| !matches!(format, "content-parts" | "media-urls"))
        {
            return Err(invalid(
                "The OpenAI Decisions adapter does not accept these routing or media-format options.",
            ));
        }
        let state = if state.is_string() {
            json!({"type":"input_text","text":state})
        } else {
            json!({"type":"input_json","data":state})
        };
        let content = std::iter::once(state)
            .chain(
                parts
                    .iter()
                    .filter(|part| part["type"] == "image")
                    .map(openai_image),
            )
            .collect::<Vec<_>>();
        body.insert(
            "input".into(),
            json!(vec![json!({"role":"user","content":content})]),
        );
        body.insert(
            "questions".into(),
            json!(questions.iter().map(openai_question).collect::<Vec<_>>()),
        );
        if gateway_media {
            body.extend(media::clips(parts)?);
        }
    } else {
        let mut assets = Object::new();
        let questions = questions
            .iter()
            .map(|question| {
                let id = question["id"]
                    .as_js_string()
                    .context("Validated question ID")?;
                Ok((
                    id.clone(),
                    native_question(question, adapter, typesafe, &mut assets)?,
                ))
            })
            .collect::<Result<Object>>()?;
        if adapter == Adapter::SystemOne {
            if !routing.is_null() {
                return Err(invalid(
                    "System One does not accept OpenRouter routing options.",
                ));
            }
            let mut native = media::system_one(family, options, parts)?;
            if !assets.is_empty() {
                let mut all = native
                    .fields
                    .get("assets")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                all.extend(assets);
                native.fields.insert("assets".into(), Value::Object(all));
            }
            body.insert("state".into(), combined_state(state, native.references));
            body.insert("questions".into(), Value::Object(questions));
            body.extend(native.fields);
        } else {
            if typesafe {
                return Err(invalid(
                    "OpenRouter Decisions uses its own image parts and does not need the TypeSafe gateway header.",
                ));
            }
            if format.is_some_and(|format| format != "content-parts") {
                return Err(invalid(
                    "OpenRouter Decisions uses native top-level state content parts.",
                ));
            }
            let parts = parts
                .iter()
                .map(media::openrouter_part)
                .collect::<Result<Vec<_>>>()?;
            body.insert("state".into(), combined_state(state, parts));
            body.insert("questions".into(), Value::Object(questions));
            if !routing.is_null() {
                body.insert("provider".into(), routing.clone());
            }
        }
    }
    Ok(Payload {
        adapter,
        url: adapter.endpoint(&base, family)?,
        body: Value::Object(body),
    })
}

fn openai_image(image: &Value) -> Value {
    json!({"type":"input_image","image_url":image["url"]})
}

fn join_lines<'a>(lines: impl IntoIterator<Item = &'a JsString>) -> Value {
    let mut result = Vec::new();
    for (index, line) in lines.into_iter().enumerate() {
        if index != 0 {
            result.push(u16::from(b'\n'));
        }
        result.extend(line.units());
    }
    Value::String(JsString::new(result))
}

fn instruction_line(label: &str, value: &Value) -> JsString {
    let text = value.as_js_string().expect("Validated decision criterion");
    JsString::new(
        label
            .encode_utf16()
            .chain(text.units().iter().copied())
            .collect(),
    )
}

fn openai_question(question: &Value) -> Value {
    let text = question["instructions"].as_js_string();
    let criteria = &question["criteria"];
    let mut output = json!({"type":question["type"],"name":question["id"]});
    let instructions = if question["type"] == "predicate" && !criteria.is_null() {
        let truth = instruction_line("True: ", &criteria["true"]);
        let falsehood = instruction_line("False: ", &criteria["false"]);
        join_lines(text.into_iter().chain([&truth, &falsehood]))
    } else {
        question["instructions"].clone()
    };
    if let Some(images) = question["instructionImages"].as_array() {
        let text =
            (!instructions.is_null()).then(|| json!({"type":"input_text","text":instructions}));
        output["instructions"] = json!(
            text.into_iter()
                .chain(images.iter().map(openai_image))
                .collect::<Vec<_>>()
        );
    } else if !instructions.is_null() {
        output["instructions"] = instructions;
    }
    let options = |key: &str, label: &str| {
        question[key].as_array().map(|items| {
            items
                .iter()
                .map(|item| {
                    let mut option = Value::Object(Object::new());
                    option[label] = item["id"].clone();
                    if item["description"].is_string() {
                        option["description"] = item["description"].clone();
                    }
                    option
                })
                .collect::<Vec<_>>()
        })
    };
    if let Some(choices) = options("choices", "value") {
        output["choices"] = json!(choices);
    }
    if let Some(levels) = options("levels", "label") {
        output["levels"] = json!(levels);
    }
    output
}

fn native_question(
    question: &Value,
    adapter: Adapter,
    typesafe: bool,
    assets: &mut Object,
) -> Result<Value> {
    let kind = question["type"]
        .as_str()
        .context("Validated question type")?;
    let mut output = json!({"type":if kind == "predicate" {"noul"} else {kind}});
    let text = question["instructions"].as_js_string();
    if let Some(images) = question["instructionImages"].as_array() {
        if adapter == Adapter::SystemOne {
            if !typesafe {
                return Err(unsupported(
                    "This System One envelope has no question-specific image placement. Use shared media or an adapter that supports instruction images.",
                ));
            }
            let mut references = Vec::with_capacity(images.len());
            for image in images {
                let (reference, asset) = media::image_asset(&image["url"])?;
                assets.insert(reference.clone(), asset);
                references.push(reference);
            }
            output["instructions"] = join_lines(text.into_iter().chain(references.iter()));
        } else {
            let parts = images
                .iter()
                .map(media::openrouter_part)
                .collect::<Result<Vec<_>>>()?;
            output["instructions"] = json!(
                text.map(|value| json!(value))
                    .into_iter()
                    .chain(parts)
                    .collect::<Vec<_>>()
            );
        }
    } else if let Some(text) = text {
        output["instructions"] = json!(text);
    }

    if let Some(criteria) = question.get("criteria") {
        output["criteria"] = criteria.clone();
    }
    if let Some(choices) = question["choices"].as_array() {
        output["criteria"] = Value::object(choices.iter().map(|choice| {
            (
                choice["id"]
                    .as_js_string()
                    .expect("Validated choice ID")
                    .clone(),
                choice["description"].clone(),
            )
        }));
    }
    if let Some(levels) = question["levels"].as_array() {
        output["criteria"] = json!(
            levels
                .iter()
                .map(|level| { either(&level["description"], &level["id"]).clone() })
                .collect::<Vec<_>>()
        );
    }
    Ok(output)
}
