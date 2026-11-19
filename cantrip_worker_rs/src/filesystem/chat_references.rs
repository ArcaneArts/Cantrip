//! Resolve chat citations on the filesystem that owns the checkout.
use super::{paths, source_path};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use futures::{StreamExt, stream};
use regress::Regex;
use std::{path::Path, sync::OnceLock};

pub(crate) async fn resolve(root: &Path, request: &Value) -> Result<Value> {
    let display = paths::resolve(root)?;
    let canonical = paths::canonical(root)
        .await
        .map_err(|e| super::explorer::io_error("realpath", root, e))?;
    let (display, canonical) = (display.as_path(), canonical.as_path());
    let entries = stream::iter(request["references"].as_array().unwrap().iter().cloned())
        .map(|value| async move {
            let reference = value.as_js_string().unwrap();
            match lexical(display, canonical, reference) {
                Ok(path) => json!({"reference":reference,"path":path,"kind":kind(display, canonical, &path).await}),
                Err(_) => json!({"reference":reference,"path":reference,"kind":Value::Null}),
            }
        })
        .buffered(32)
        .collect::<Vec<_>>()
        .await;
    checked(
        "chatFileReferencesResultContentSchema",
        &json!({"root":paths::text(display),"entries":entries}),
    )
}

fn lexical(display: &Path, canonical: &Path, reference: &JsString) -> Result<JsString> {
    static LINE: OnceLock<Regex> = OnceLock::new();
    static COLON: OnceLock<Regex> = OnceLock::new();
    let value = crate::native_items::replace(
        &reference.trim(),
        LINE.get_or_init(|| Regex::with_flags(r"#L\d+(?:C\d+)?$", "iu").unwrap()),
        |_, _| Vec::new(),
    );
    let mut value = crate::native_items::replace(
        &value,
        COLON.get_or_init(|| Regex::with_flags(r":\d+(?::\d+)?$", "u").unwrap()),
        |_, _| Vec::new(),
    );
    if source_path::is_file_url(&value) {
        value = source_path::file_url(&value, cfg!(windows))?;
    }
    let value = JsString::new(
        value
            .units()
            .iter()
            .map(|&c| if c == 92 { 47 } else { c })
            .collect(),
    );
    let resolved = resolve_text(display, &value)?;
    if relative(display, &resolved).is_none()
        && let Some(relative) = relative(canonical, &resolved)
    {
        return resolve_text(display, &relative);
    }
    Ok(resolved)
}

#[cfg(windows)]
fn resolve_text(root: &Path, value: &JsString) -> Result<JsString> {
    Ok(paths::text(&cantrip_config::resolve(
        root,
        &paths::native(value),
    )))
}

#[cfg(not(windows))]
fn resolve_text(root: &Path, value: &JsString) -> Result<JsString> {
    if value.units().first() == Some(&47) {
        return source_path::posix_path(value, false);
    }
    // Node uses UTF-16 for lexical resolution even when the filesystem asks
    // for UTF-8. Convert to a native path only when opening the reference.
    let absolute = crate::native_items::concat(&[paths::text(root), "/".into(), value.clone()]);
    source_path::posix_path(&absolute, false)
}

#[cfg(windows)]
fn relative(root: &Path, path: &JsString) -> Option<JsString> {
    let path = paths::native(path);
    paths::within(root, &path).then(|| paths::relative(root, &path))
}

#[cfg(not(windows))]
fn relative(root: &Path, path: &JsString) -> Option<JsString> {
    let root = paths::text(root);
    let suffix = path.units().strip_prefix(root.units())?;
    match suffix {
        [] => Some(".".into()),
        [47, rest @ ..] => Some(JsString::new(rest.into())),
        rest if root.units() == [47] => Some(JsString::new(rest.into())),
        _ => None,
    }
}

async fn kind(display: &Path, canonical: &Path, path: &JsString) -> Option<&'static str> {
    relative(display, path)?;
    let target = paths::canonical(&paths::native(path)).await.ok()?;
    if !paths::within(canonical, &target) {
        return None;
    }
    let metadata = tokio::fs::metadata(target).await.ok()?;
    if metadata.is_file() {
        Some("file")
    } else if metadata.is_dir() {
        Some("directory")
    } else {
        None
    }
}
