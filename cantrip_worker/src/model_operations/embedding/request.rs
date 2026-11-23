use super::*;
use crate::codex::observation::normalize_base_url;
use url::Url;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Adapter {
    OpenAi,
    Ollama,
    Llama,
    Vllm,
    Pooling,
    Bge,
    Cohere,
}

impl Adapter {
    pub fn select(route: &Value, provider: &Value) -> Result<Self> {
        if matches!(provider["kind"].as_str(), Some("chatgpt" | "grok")) {
            return Err(unavailable());
        }
        Ok(match route["adapter"].as_str() {
            None if provider["kind"] == "ollama" => Self::Ollama,
            None if provider["kind"] == "vllm" => Self::Vllm,
            None | Some("openai-embeddings") => Self::OpenAi,
            Some("ollama-embed") => Self::Ollama,
            Some("llama-embeddings") => Self::Llama,
            Some("vllm-embeddings") => Self::Vllm,
            Some("vllm-pooling") => Self::Pooling,
            Some("vllm-bge-m3") => Self::Bge,
            Some("cohere-embed") => Self::Cohere,
            _ => return Err(unavailable()),
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "openai-embeddings",
            Self::Ollama => "ollama-embed",
            Self::Llama => "llama-embeddings",
            Self::Vllm => "vllm-embeddings",
            Self::Pooling => "vllm-pooling",
            Self::Bge => "vllm-bge-m3",
            Self::Cohere => "cohere-embed",
        }
    }

    pub fn vllm_chat(self) -> bool {
        matches!(self, Self::Vllm | Self::Pooling)
    }

    pub fn uses_chat(self, options: &Value, items: &[Value]) -> bool {
        self.vllm_chat()
            && (set(options, &["messageRole", "inputType", "mediaFormat"]) || !text_only(items))
    }

    fn url(self, base: &Url) -> Result<Url> {
        let base = base.as_str().trim_end_matches('/');
        let trim_v1 = || base.strip_suffix("/v1").unwrap_or(base);
        let (complete, root, suffix) = match self {
            Self::Ollama => {
                let root = trim_v1();
                (
                    "/api/embed",
                    root,
                    if root.ends_with("/api") {
                        "/embed"
                    } else {
                        "/api/embed"
                    },
                )
            }
            Self::Llama => ("/embeddings", trim_v1(), "/embeddings"),
            Self::Pooling | Self::Bge => ("/pooling", trim_v1(), "/pooling"),
            Self::Cohere => (
                "/embed",
                base.strip_suffix("/v2").unwrap_or_else(trim_v1),
                "/v2/embed",
            ),
            _ => ("/embeddings", base, "/embeddings"),
        };
        let url = if base.ends_with(complete) {
            base.to_owned()
        } else {
            format!("{root}{suffix}")
        };
        Ok(Url::parse(&url)?)
    }
}

#[derive(Clone)]
pub(super) struct Payload {
    pub url: Url,
    pub body: Value,
    pub adapter: Adapter,
}

const RESERVED: &[&str] = &[
    "model",
    "input",
    "inputs",
    "texts",
    "images",
    "messages",
    "questions",
    "state",
    "data",
    "task",
    "embed_task",
    "provider",
    "dimensions",
    "output_dimension",
    "input_type",
    "encoding_format",
    "embedding_types",
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

fn unavailable() -> anyhow::Error {
    error(
        "configuration-required",
        "This connection does not expose the configured embedding API.",
    )
}
fn invalid(message: &str) -> anyhow::Error {
    error("invalid-request", message)
}
fn unsupported(message: &str) -> anyhow::Error {
    error("unsupported-input", message)
}

fn set(options: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| !options[*key].is_null())
}
fn parts_of(item: &Value) -> &[Value] {
    item["content"].as_array().unwrap()
}
fn text_only(items: &[Value]) -> bool {
    items
        .iter()
        .flat_map(parts_of)
        .all(|part| part["type"] == "text")
}
fn texts(items: &[Value]) -> Value {
    json!(
        items
            .iter()
            .map(|item| JsString::new(
                parts_of(item)
                    .iter()
                    .filter_map(|part| part["text"].as_js_string())
                    .flat_map(|text| text.units().iter().copied())
                    .collect()
            ))
            .collect::<Vec<_>>()
    )
}

#[derive(Clone, Copy)]
enum Media {
    Images,
    Llama,
    Vllm,
}
fn media_part(part: &Value, native: Media) -> Result<Value> {
    let kind = part["type"].as_str().unwrap();
    if kind == "text" {
        return Ok(part.clone());
    }
    let key = match (kind, native) {
        ("image", _) => "image_url",
        ("audio", Media::Llama) => "input_audio",
        ("video", Media::Llama) => "input_video",
        ("audio", Media::Vllm) => "audio_url",
        ("video", Media::Vllm) => "video_url",
        _ => {
            return Err(unsupported(
                "The selected embedding envelope accepts text and images. Select a native audio/video adapter for these inputs.",
            ));
        }
    };
    let mut value = json!({"type":key});
    value[key] = json!({"url":part["url"]});
    Ok(value)
}
fn content(items: &[Value], media: Media) -> Result<Value> {
    let items = items
        .iter()
        .map(|item| {
            let parts = parts_of(item)
                .iter()
                .map(|part| media_part(part, media))
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({"content":parts}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!(items))
}
fn base64_images(items: &[Value]) -> Result<Value> {
    let images = items.iter().map(|item| {
        let parts = parts_of(item);
        if parts.len() != 1 || parts[0]["type"] != "image" {
            return Err(unsupported("The base64 image format requires one image per item; mixed parts are not discarded."));
        }
        let encoded = parts[0]["url"].as_str().and_then(|url| {
            let (mime, encoded) = url.split_once(',')?;
            let mime = mime.to_ascii_lowercase();
            let subtype = mime.strip_prefix("data:image/")?.strip_suffix(";base64")?;
            let text = encoded.trim_end_matches('=');
            (!subtype.is_empty() && !subtype.contains(';') && !text.is_empty()
                && encoded.len() - text.len() <= 2
                && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')))
                .then_some(encoded)
        }).ok_or_else(|| unsupported("This embedding format requires an inline base64 image. The worker does not download or convert media."))?;
        Ok(encoded)
    }).collect::<Result<Vec<_>>>()?;
    Ok(json!(images))
}

pub(super) fn payload(
    adapter: Adapter,
    route: &Value,
    provider: &Value,
    options: &Value,
    items: &[Value],
) -> Result<Payload> {
    if options["typesafeImages"] == true {
        return Err(invalid(
            "TypeSafe decision image options cannot be used for embeddings.",
        ));
    }
    let params = object(&options["parameters"]);
    let nonmatching = |key: &str, value: &str| params.get(key).is_some_and(|v| v != value);
    let base64 = options["encodingFormat"] == "base64";
    if base64 && (nonmatching("embed_dtype", "float32") || nonmatching("endianness", "little")) {
        return Err(unsupported(
            "Base64 embedding decoding requires little-endian float32. Select float encoding for another native numeric format.",
        ));
    }
    if params.keys().any(|key| {
        key.lowercase()
            .as_str()
            .is_some_and(|key| RESERVED.contains(&key))
    }) {
        return Err(invalid(
            "Additional parameters cannot replace embedding inputs, routing, credentials or typed options.",
        ));
    }
    if params
        .get("truncate")
        .is_some_and(|v| v != &json!(false) && v != "NONE")
    {
        return Err(invalid(
            "Embedding content is not implicitly truncated. Configure preprocessing separately.",
        ));
    }
    if !options["poolingTask"].is_null() && adapter != Adapter::Pooling {
        return Err(invalid(
            "The pooling task option requires the vLLM embedding pooling adapter.",
        ));
    }
    if !options["messageRole"].is_null() && !adapter.vllm_chat() {
        return Err(invalid(
            "The embedding message role requires a chat-style vLLM adapter.",
        ));
    }

    let base = normalize_base_url(
        provider["baseUrl"]
            .as_str()
            .context("Embedding provider URL")?,
    )?;
    let kind = provider["kind"].as_str().unwrap_or_default();
    let routing = &options["providerRouting"];
    let media = options["mediaFormat"].as_str();
    let representation = options["vectorRepresentation"].as_str();
    let encoding = options["encodingFormat"].as_str().unwrap_or("float");
    let dims = &options["dimensions"];
    let all_text = text_only(items);
    let mut body = Value::Object(params.clone());
    body["model"] = route["modelName"].clone();
    if !dims.is_null() && adapter != Adapter::Cohere {
        body["dimensions"] = dims.clone();
    }

    match adapter {
        Adapter::Ollama => {
            if !all_text {
                return Err(unsupported("Ollama's embed API accepts text inputs."));
            }
            if base64 || set(options, &["inputType", "providerRouting", "mediaFormat"]) {
                return Err(invalid(
                    "The selected Ollama embed API does not accept these operation options.",
                ));
            }
            body["input"] = texts(items);
            body["truncate"] = json!(false);
        }
        Adapter::Bge => {
            if !all_text {
                return Err(unsupported(
                    "The configured BGE-M3 sparse plugin accepts text inputs.",
                ));
            }
            if base64 || set(options, &["inputType", "providerRouting", "mediaFormat"]) {
                return Err(invalid(
                    "The BGE-M3 plugin requires native text/float options.",
                ));
            }
            let task = match representation {
                Some("multi-vector") => {
                    return Err(unsupported(
                        "Use vLLM token_embed pooling for ColBERT multi-vector output.",
                    ));
                }
                None | Some("hybrid") => "dense&sparse",
                Some(task) => task,
            };
            let mut data = Value::Object(params);
            data["input"] = texts(items);
            data["embed_task"] = json!(task);
            if data["return_tokens"].is_null() {
                data["return_tokens"] = json!(true);
            }
            if !dims.is_null() {
                data["dimensions"] = dims.clone();
            }
            body = json!({"model":route["modelName"],"task":"plugin","data":data});
        }
        Adapter::Cohere => {
            if !routing.is_null() || media.is_some_and(|media| media != "content-parts") {
                return Err(invalid(
                    "The Cohere-compatible adapter uses mixed input content parts.",
                ));
            }
            if all_text {
                body["texts"] = texts(items);
            } else {
                body["inputs"] = content(items, Media::Images)?;
            }
            body["embedding_types"] = json!([encoding]);
            body["truncate"] = json!("NONE");
            if !dims.is_null() {
                body["output_dimension"] = dims.clone();
            }
            if !options["inputType"].is_null() {
                body["input_type"] = options["inputType"].clone();
            }
        }
        Adapter::Vllm | Adapter::Pooling => {
            if !routing.is_null()
                || media.is_some_and(|media| !matches!(media, "content-parts" | "media-urls"))
            {
                return Err(invalid(
                    "The native vLLM embedding adapter uses chat media parts without gateway routing.",
                ));
            }
            if base64 {
                if adapter == Adapter::Pooling {
                    return Err(unsupported(
                        "Use float encoding for nested pooling tensors; a shape-less base64 tensor is ambiguous.",
                    ));
                }
                if representation != Some("dense") {
                    return Err(unsupported(
                        "Select dense representation for native vLLM base64, or use float encoding to preserve an automatically detected tensor shape.",
                    ));
                }
            }
            if adapter.uses_chat(options, items) {
                if items.len() != 1 {
                    return Err(invalid(
                        "A chat-style embedding request must contain exactly one item.",
                    ));
                }
                let mut messages = content(items, Media::Vllm)?;
                let Value::Array(messages) = &mut messages else {
                    unreachable!()
                };
                messages[0]["role"] = either(
                    &options["messageRole"],
                    either(&options["inputType"], &json!("user")),
                )
                .clone();
                body["messages"] = json!(messages);
            } else {
                body["input"] = texts(items);
            }
            body["encoding_format"] = json!(encoding);
            if adapter == Adapter::Pooling {
                body["task"] = json!(options["poolingTask"].as_str().unwrap_or(
                    if representation == Some("dense") {
                        "embed"
                    } else {
                        "token_embed"
                    }
                ));
            }
        }
        Adapter::OpenAi | Adapter::Llama => {
            if kind == "unsloth" && !all_text {
                return Err(unsupported("Unsloth's embedding API accepts text inputs."));
            }
            if adapter == Adapter::Llama && base64 {
                return Err(unsupported(
                    "Use float encoding for llama.cpp native nested embeddings.",
                ));
            }
            body["input"] = match media {
                Some("base64-images") => base64_images(items)?,
                None | Some("content-parts") if all_text => texts(items),
                None | Some("content-parts") => content(
                    items,
                    if adapter == Adapter::Llama || kind == "llama-cpp" {
                        Media::Llama
                    } else {
                        Media::Images
                    },
                )?,
                _ => {
                    return Err(unsupported(
                        "Select a supported content-parts or base64-images embedding format.",
                    ));
                }
            };
            if kind == "unsloth" {
                body["truncate"] = json!(false);
            }
            body["encoding_format"] = json!(encoding);
            if !options["inputType"].is_null() {
                body["input_type"] = options["inputType"].clone();
            }
            let openrouter = kind == "openrouter"
                || (kind == "openai-compatible"
                    && base.host_str().is_some_and(|host| {
                        host == "openrouter.ai" || host.ends_with(".openrouter.ai")
                    }));
            if openrouter {
                if routing["allow_fallbacks"] == true {
                    return Err(invalid(
                        "Gateway fallback requires established embedding-space compatibility.",
                    ));
                }
                let mut selection = Value::Object(object(routing));
                selection["allow_fallbacks"] = json!(false);
                body["provider"] = selection;
            } else if !routing.is_null() {
                body["provider"] = routing.clone();
            }
        }
    }
    Ok(Payload {
        url: adapter.url(&base)?,
        body,
        adapter,
    })
}
