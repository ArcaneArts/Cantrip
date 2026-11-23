use crate::{
    attachments::paths::MAX_BYTES,
    native_items::{obj, s},
};
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{JsString, Value};
use std::path::Path;
use tokio::{fs, io::AsyncReadExt};

pub fn parts(body: &Value) -> Vec<Value> {
    match body["type"].as_str() {
        Some("userMessage") => body["content"]
            .as_array()
            .map(|v| {
                v.iter()
                    .map(|v| {
                        if v.is_object() {
                            v.clone()
                        } else {
                            Value::Null
                        }
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("functionCallOutput") => body["output"]
            .as_array()
            .map(|v| {
                v.iter()
                    .map(|part| match part["type"].as_str() {
                        Some("input_image") => {
                            obj([("type", s("image")), ("url", part["image_url"].clone())])
                        }
                        Some("input_audio") => {
                            obj([("type", s("audio")), ("url", part["audio_url"].clone())])
                        }
                        _ => Value::Null,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("imageGeneration") => body["result"]
            .as_js_string()
            .filter(|s| !s.is_empty())
            .map(|value| {
                vec![obj([
                    ("type", s("image")),
                    (
                        "url",
                        s(crate::native_items::concat(&[
                            "data:image/png;base64,".into(),
                            value.clone(),
                        ])),
                    ),
                ])]
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|a, b| a.0.units().cmp(b.0.units()));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        Value::String(key.clone()).stringify(),
                        canonical(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.stringify(),
    }
}
const EXTENSIONS: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
    ("image/heic", "heic"),
    ("image/bmp", "bmp"),
    ("image/tiff", "tiff"),
    ("image/avif", "avif"),
    ("audio/wav", "wav"),
    ("audio/mpeg", "mp3"),
    ("audio/mp4", "m4a"),
    ("audio/ogg", "ogg"),
    ("audio/flac", "flac"),
    ("audio/aac", "aac"),
    ("audio/aiff", "aiff"),
    ("audio/webm", "webm"),
];
pub fn extension(mime: &str) -> &'static str {
    EXTENSIONS
        .iter()
        .find(|v| v.0 == mime)
        .map_or("bin", |v| v.1)
}
pub fn mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if ext == "jpeg" {
        return "image/jpeg";
    }
    if ext == "tif" {
        return "image/tiff";
    }
    EXTENSIONS
        .iter()
        .find(|v| v.1 == ext)
        .map_or("application/octet-stream", |v| v.0)
}
pub fn inline(url: &JsString, kind: &str) -> Result<(Zeroizing<Vec<u8>>, JsString)> {
    let invalid = || anyhow::anyhow!("Native inline media has an invalid data URL.");
    let rest = url
        .units()
        .strip_prefix(&[100, 97, 116, 97, 58])
        .ok_or_else(invalid)?;
    let delimiter: Vec<_> = ";base64,".encode_utf16().collect();
    let index = rest
        .windows(delimiter.len())
        .position(|v| v == delimiter)
        .ok_or_else(invalid)?;
    let mime = &rest[..index];
    let encoded = &rest[index + delimiter.len()..];
    let prefix: Vec<_> = format!("{kind}/").encode_utf16().collect();
    if mime.is_empty() || mime.iter().any(|u| matches!(u, 59 | 44)) || !mime.starts_with(&prefix) {
        return Err(invalid());
    }
    let padding = encoded.iter().rposition(|u| *u != 61).map_or(0, |i| i + 1);
    if encoded.len() - padding > 2
        || !encoded[..padding]
            .iter()
            .all(|u| matches!(u,43|47|48..=57|65..=90|97..=122))
    {
        return Err(invalid());
    }
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        bail!("Native media exceeds the attachment size limit.");
    }
    let encoded: String = encoded.iter().map(|u| *u as u8 as char).collect();
    let mut bytes = Zeroizing::new(Vec::new());
    STANDARD.decode_vec(&encoded, &mut bytes).map_err(|_| {
        anyhow::anyhow!("Native inline media has invalid or oversized base64 bytes.")
    })?;
    if bytes.len() > MAX_BYTES || STANDARD.encode(&bytes) != encoded {
        bail!("Native inline media has invalid or oversized base64 bytes.");
    }
    Ok((bytes, JsString::new(mime.to_vec())))
}
/// Open the actual source before checking its type. Nonblocking prevents a FIFO
/// from hanging import; the read budget is enforced on actual bytes, not stat.
pub async fn read(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    let mut file = options
        .open(path)
        .await
        .map_err(|e| super::super::attachments::io("open", path, e))?;
    if !file.metadata().await?.is_file() {
        bail!("Native media source is not a regular file.");
    }
    let mut chunks = Vec::new();
    let mut total = 0;
    loop {
        let mut chunk = Zeroizing::new(vec![0; (64 * 1024).min(MAX_BYTES + 1 - total)]);
        let n = file
            .read(&mut chunk)
            .await
            .map_err(|e| super::super::attachments::io("read", path, e))?;
        if n == 0 {
            break;
        }
        chunk.truncate(n);
        chunks.push(chunk);
        total += n;
        if total > MAX_BYTES {
            bail!("Native media exceeds the attachment size limit.");
        }
    }
    let mut result = Zeroizing::new(Vec::with_capacity(total));
    for chunk in chunks {
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}
