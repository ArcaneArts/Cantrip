use super::{invalid, unsupported};
use anyhow::Result;
use cantrip_wire::{
    JsString, Value,
    value::{Object, json},
};
use uuid::Uuid;

struct Inline<'a> {
    mime: String,
    base64: &'a str,
}

fn inline<'a>(url: &'a Value, kind: &str) -> Result<Inline<'a>> {
    let parsed = url.as_str().and_then(|url| {
        let (format, encoded) = url.strip_prefix("data:")?.split_once(',')?;
        let mime = format.strip_suffix(";base64")?.to_lowercase();
        let unpadded = encoded.trim_end_matches('=');
        if mime.contains(';')
            || mime.split_once('/').is_none_or(|(major, _)| major != kind)
            || encoded.len() % 4 == 1
            || encoded.len() - unpadded.len() > 2
            || unpadded.is_empty()
            || !unpadded
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        {
            return None;
        }
        Some(Inline {
            mime,
            base64: encoded,
        })
    });
    parsed.ok_or_else(|| unsupported(format!(
        "This decision interface requires an inline base64 {kind} data URL. Remote media is not fetched or converted."
    )))
}

fn kind(part: &Value) -> &str {
    part["type"]
        .as_str()
        .expect("Validated decision media type")
}

fn field(kind: &str) -> &'static str {
    match kind {
        "image" => "images",
        "audio" => "audio",
        _ => "videos",
    }
}

fn append(fields: &mut Object, field: &str, value: Value) {
    let field = fields
        .entry(field.into())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Value::Array(values) = field {
        values.push(value);
    }
}

pub(super) fn clips(media: &[Value]) -> Result<Object> {
    let mut fields = Object::new();
    for part in media.iter().filter(|part| kind(part) != "image") {
        inline(&part["url"], kind(part))?;
        append(&mut fields, field(kind(part)), part["url"].clone());
    }
    Ok(fields)
}

pub(super) fn image_asset(url: &Value) -> Result<(JsString, Value)> {
    let encoded = inline(url, "image")?;
    if !matches!(
        encoded.mime.as_str(),
        "image/png" | "image/jpeg" | "image/jpg"
    ) {
        return Err(unsupported(
            "TypeSafe image assets require PNG or JPEG; no conversion is performed.",
        ));
    }
    Ok((
        format!("cantrip-image-{}", Uuid::new_v4()).into(),
        json!({"type":"image","format":&encoded.mime[6..],"data_base64":encoded.base64}),
    ))
}

#[derive(Default)]
pub(super) struct Native {
    pub fields: Object,
    pub references: Vec<Value>,
}

pub(super) fn system_one(family: &str, options: &Value, media: &[Value]) -> Result<Native> {
    let typesafe = options["typesafeImages"] == true;
    let explicit = options["mediaFormat"].as_str();
    let format = explicit.unwrap_or(if typesafe || matches!(family, "vllm" | "litellm") {
        "media-urls"
    } else if matches!(family, "llama-cpp" | "lm-studio") {
        "data-url-files"
    } else {
        "base64-images"
    });
    if !matches!(format, "base64-images" | "data-url-files" | "media-urls") {
        return Err(invalid(
            "Select a System One media encoding: raw base64, data-URL files, or typed media URL arrays.",
        ));
    }
    let mut native = Native::default();
    if family == "unsloth" && explicit.is_none() {
        for part in media {
            let kind = kind(part);
            if kind == "video" {
                return Err(unsupported(
                    "Unsloth System One accepts images and audio, not video.",
                ));
            }
            let encoded = inline(&part["url"], kind)?;
            if kind == "image" && !matches!(encoded.mime.as_str(), "image/png" | "image/jpeg") {
                return Err(unsupported(
                    "Unsloth decision images require PNG or JPEG data URLs.",
                ));
            }
            append(&mut native.fields, field(kind), part["url"].clone());
        }
        if typesafe {
            return Err(invalid(
                "Unsloth uses native image arrays. Select a gateway media encoding explicitly for a TypeSafe extension.",
            ));
        }
        return Ok(native);
    }
    if typesafe {
        if format != "media-urls" {
            return Err(invalid(
                "The TypeSafe image extension requires the gateway media encoding.",
            ));
        }
        let mut assets = Object::new();
        for part in media.iter().filter(|part| kind(part) == "image") {
            let (reference, asset) = image_asset(&part["url"])?;
            native.references.push(Value::String(reference.clone()));
            assets.insert(reference, asset);
        }
        if !assets.is_empty() {
            native.fields.insert("assets".into(), Value::Object(assets));
        }
        native.fields.extend(clips(media)?);
    } else if format == "media-urls" {
        for part in media {
            let kind = kind(part);
            if part["url"]
                .as_js_string()
                .is_some_and(|url| url.lossy().starts_with("data:"))
            {
                inline(&part["url"], kind)?;
            } else if family == "litellm" && kind != "image" {
                return Err(unsupported(
                    "LiteLLM decision audio and video require inline base64 data URLs.",
                ));
            }
            append(&mut native.fields, field(kind), part["url"].clone());
        }
    } else {
        let raw = format == "base64-images";
        let field = if raw || family == "lm-studio" {
            "images"
        } else {
            "files"
        };
        for part in media {
            let kind = kind(part);
            if kind == "video" {
                return Err(unsupported(
                    "This System One file encoding accepts images and supported audio, not video.",
                ));
            }
            let encoded = inline(&part["url"], kind)?;
            if raw
                && kind == "audio"
                && !matches!(
                    encoded.mime.as_str(),
                    "audio/wav" | "audio/x-wav" | "audio/wave"
                )
            {
                return Err(unsupported(
                    "Raw-base64 System One audio must be WAV; no transcoding is performed.",
                ));
            }
            let value = if raw {
                json!(encoded.base64)
            } else {
                part["url"].clone()
            };
            append(&mut native.fields, field, value);
        }
    }
    Ok(native)
}

pub(super) fn openrouter_part(part: &Value) -> Result<Value> {
    let kind = kind(part);
    let url = &part["url"];
    let encoded = inline(url, kind)?;
    Ok(match kind {
        "image" => json!({"type":"image_url","image_url":json!({"url":url})}),
        "video" => json!({"type":"video_url","video_url":json!({"url":url})}),
        _ => {
            let format = encoded.mime.strip_prefix("audio/").expect("Validated MIME");
            let format = format.strip_prefix("x-").unwrap_or(format);
            if !matches!(
                format,
                "wav"
                    | "mp3"
                    | "mpeg"
                    | "m4a"
                    | "mp4"
                    | "aac"
                    | "aiff"
                    | "aif"
                    | "flac"
                    | "ogg"
                    | "opus"
                    | "webm"
            ) {
                return Err(unsupported(
                    "This audio encoding is not supported by the OpenRouter decision envelope.",
                ));
            }
            json!({"type":"input_audio","input_audio":json!({"data":encoded.base64,"format":format})})
        }
    })
}
