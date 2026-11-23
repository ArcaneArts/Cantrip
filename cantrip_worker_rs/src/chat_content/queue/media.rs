//! Make native queue media portable before the prompt can be admitted.
use super::Scope;
use crate::{
    attachments::{
        Store,
        content::{self, Keys},
        paths::{MAX_BYTES, safe_filename},
    },
    filesystem::paths,
    history::input_materializer::media,
    http::checked,
    native_items::text,
};
use anyhow::{Result, ensure};
use base64::{
    Engine,
    alphabet::STANDARD as ALPHABET,
    engine::general_purpose::{GeneralPurpose, NO_PAD, STANDARD},
};
use cantrip_crypto::{Zeroizing, content::attachment_digest, hmac_sha256};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{collections::HashMap, fmt::Write, path::Path};

pub(crate) struct Captured {
    pub input: Vec<Value>,
    local: HashMap<usize, (JsString, Zeroizing<Vec<u8>>)>,
}

pub(crate) async fn capture(mut input: Vec<Value>, directory: &Path) -> Result<Captured> {
    let mut local = HashMap::new();
    for (index, item) in input.iter_mut().enumerate() {
        let kind = match item["type"].as_str() {
            Some("localImage") => "image",
            Some("localAudio") => "audio",
            _ => continue,
        };
        let supplied = text(&item["path"])?.clone();
        let path = directory.join(paths::native(&supplied));
        let bytes = media::read(&path).await?;
        let mime = local_mime(&path);
        let url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
        let detail = item.get("detail").cloned();
        *item = json!({"type":kind, "url":url});
        if let Some(detail) = detail {
            item["detail"] = detail;
        }
        local.insert(index, (supplied, bytes));
    }
    Ok(Captured { input, local })
}

#[derive(Default)]
pub(crate) struct Projection {
    pub input: Vec<Value>,
    pub attachments: Vec<Value>,
    pub summaries: Vec<Value>,
    pub map: Vec<Value>,
}

pub(crate) async fn project(
    scope: &Scope,
    store: &Store,
    chat: &JsString,
    prompt: &JsString,
    operation: &JsString,
    mut captured: Captured,
    mut output: Projection,
) -> Result<Projection> {
    for (index, item) in captured.input.iter().enumerate() {
        if output
            .map
            .iter()
            .any(|entry| entry["index"].as_u64() == Some(index as u64))
        {
            continue;
        }
        let Some(kind @ ("image" | "audio")) = item["type"].as_str() else {
            continue;
        };
        let Some(url) = item["url"].as_str().filter(|url| url.starts_with("data:")) else {
            continue;
        };
        let (source_name, bytes, mime) = if let Some((name, bytes)) = captured.local.remove(&index)
        {
            let mime = url
                .strip_prefix("data:")
                .unwrap()
                .split_once(';')
                .unwrap()
                .0
                .into();
            (Some(name), bytes, mime)
        } else {
            let (mime, bytes) = inline(&item["url"])?;
            (None, bytes, mime)
        };
        let grant = scope.attachment_material()?;
        let seed = json!((
            "managed-queue-media",
            &scope.server,
            &scope.owner,
            chat,
            prompt,
            operation,
            index,
            &mime,
            &source_name,
        ))
        .stringify();
        let tag = hmac_sha256(&grant.key, &[seed.as_bytes(), &bytes])?;
        let mut id = String::with_capacity(70);
        id.push_str("queue-");
        for byte in tag {
            write!(&mut id, "{byte:02x}").unwrap();
        }
        let id = JsString::from(id);
        let file_name = safe_filename(&source_name.unwrap_or_else(|| {
            format!("queued-{kind}-{}.{}", index + 1, queue_extension(&mime)).into()
        }));
        let digest = attachment_digest(&bytes);
        let created = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let metadata = json!({
            "version":1, "fileName":file_name, "mimeType":mime, "kind":kind,
            "source":"file", "previewText":Value::Null, "sha256":digest, "error":Value::Null,
        });
        let protected = content::protect(scope, &json!(chat), &json!(id), &metadata)?;
        let attachment = checked(
            "chatAttachmentOpaqueSummarySchema",
            &json!({
                "id":id, "chatId":chat, "sizeBytes":bytes.len(), "status":"ready",
                "createdAt":created, "protectedMetadata":protected,
            }),
        )?;
        let summary = checked(
            "chatAttachmentSummarySchema",
            &content::open(scope, &attachment)?,
        )?;
        scope.identity()?;
        let saved = store.resolve(chat, &id, &file_name)?;
        let directory = saved.parent().unwrap().to_path_buf();
        let parent = directory.clone();
        tokio::task::spawn_blocking(move || cantrip_history::files::ensure_directory(&parent))
            .await??;
        store
            .store_bytes(chat, &id, file_name, &bytes, digest)
            .await?;
        tokio::fs::File::open(&saved).await?.sync_all().await?;
        tokio::task::spawn_blocking(move || cantrip_history::files::flush_directory(&directory))
            .await??;
        output.map.push(json!({"id":id,"index":index}));
        output.attachments.push(attachment);
        output.summaries.push(summary);
    }
    scope.identity()?;
    output.input = captured.input;
    Ok(output)
}

fn local_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("tiff") => "image/tiff",
        Some(
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "heic" | "bmp" | "wav" | "mp3" | "m4a"
            | "ogg" | "flac" | "aac" | "aiff" | "webm",
        ) => media::mime(path),
        _ => "application/octet-stream",
    }
}

fn queue_extension(mime: &JsString) -> &'static str {
    match mime.as_str() {
        Some(
            "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "audio/wav" | "audio/mpeg"
            | "audio/mp4" | "audio/ogg",
        ) => media::extension(mime.as_str().unwrap()),
        _ => "bin",
    }
}

fn inline(url: &Value) -> Result<(JsString, Zeroizing<Vec<u8>>)> {
    let invalid = || anyhow::anyhow!("Queued inline media must contain a base64 data URL.");
    let url = text(url)?.as_str().ok_or_else(invalid)?;
    let rest = url.strip_prefix("data:").ok_or_else(invalid)?;
    let (mime, encoded) = rest.split_once(";base64,").ok_or_else(invalid)?;
    let body = encoded.trim_end_matches('=');
    ensure!(
        !mime.is_empty()
            && !mime.contains([';', ','])
            && encoded.len() - body.len() <= 2
            && body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/')),
        invalid()
    );
    // Buffer.from accepts unpadded input, nonzero unused bits, and ignores an
    // incomplete final sextet. Keep the original URL in the retained vector.
    let body = if body.len() % 4 == 1 {
        &body[..body.len() - 1]
    } else {
        body
    };
    ensure!(
        body.len() * 3 / 4 <= MAX_BYTES,
        "Queued media exceeds the attachment size limit."
    );
    let decoder = GeneralPurpose::new(&ALPHABET, NO_PAD.with_decode_allow_trailing_bits(true));
    let mut bytes = Zeroizing::new(Vec::new());
    decoder
        .decode_vec(body, &mut bytes)
        .map_err(|_| invalid())?;
    Ok((mime.into(), bytes))
}
