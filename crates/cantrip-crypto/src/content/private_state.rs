//! Surface private-state records shared by terminals, Explorer/file documents,
//! browsers and desktop surfaces. Policy and grant selection stay with consumers.
use super::{aad, authenticate, decode_json, encode_json, open_field, seal_field};
use crate::{checked, decryption_error, encode};
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};

pub const SURFACE_PRIVATE_STATE_BYTES_LIMIT: usize = 4 * 1024 * 1024;

fn validated_context(input: &Value) -> Result<Value> {
    let binding = checked("surfacePrivateStateContextSchema", input)?;
    let resource = binding["resource"].as_str().unwrap();
    let allowed: &[&str] = match binding["recordKind"].as_str().unwrap() {
        "terminal-state" => &["terminal-row", "terminal-operation"],
        "explorer-state" => &["explorer-row", "explorer-operation"],
        "file-document-state" => &["file-document-row"],
        "browser-state" => &["browser-row", "browser-remote-surface", "browser-operation"],
        "remote-desktop-state" => &[
            "remote-desktop-row",
            "remote-desktop-surface",
            "remote-desktop-operation",
        ],
        "remote-desktop-inventory" => &["remote-desktop-inventory"],
        _ => unreachable!(),
    };
    if !allowed.contains(&resource) {
        bail!("Surface private-state kind and resource do not agree.");
    }
    let persistent = resource.ends_with("-row") || resource.ends_with("-surface");
    if persistent != binding["operationId"].is_null() {
        bail!(if persistent {
            "Persistent surface state cannot carry an operation ID."
        } else {
            "Ephemeral surface state requires an operation ID."
        });
    }
    Ok(binding)
}

pub fn surface_private_state_associated_data(context: &Value) -> Result<Value> {
    let binding = validated_context(&context["context"])?;
    let table = match binding["resource"].as_str().unwrap() {
        "terminal-row" => "terminals",
        "explorer-row" => "explorers",
        "file-document-row" => "file_documents",
        "browser-row" => "browsers",
        "browser-remote-surface" | "remote-desktop-surface" => "remote_surfaces",
        "remote-desktop-row" => "project_views",
        "terminal-operation" => "protocol:terminal-operation",
        "explorer-operation" => "protocol:explorer-operation",
        "browser-operation" => "protocol:browser-operation",
        "remote-desktop-operation" => "protocol:remote-desktop-operation",
        "remote-desktop-inventory" => "protocol:remote-desktop-inventory",
        _ => unreachable!(),
    };
    let field = match binding["recordKind"].as_str().unwrap() {
        "terminal-state" => "protected_terminal_state",
        "explorer-state" => "protected_explorer_state",
        "file-document-state" => "protected_file_document_state",
        "browser-state" => "protected_browser_state",
        "remote-desktop-state" => "protected_remote_desktop_state",
        "remote-desktop-inventory" => "protected_remote_desktop_inventory",
        _ => unreachable!(),
    };
    let server = binding["serverId"].as_js_string().unwrap().lossy();
    let row = json!([
        json!(encode(&Sha256::digest(server.as_bytes()))),
        binding["resourceId"].clone(),
        binding["operationId"].clone(),
        binding["recordKind"].clone()
    ])
    .stringify();
    aad(
        context,
        &json!("surface-private-state"),
        &json!(table),
        &json!(row),
        &json!(field),
    )
}

pub fn encrypt_surface_private_state(
    key: &[u8],
    context: &Value,
    content: &Value,
) -> Result<Value> {
    let binding = validated_context(&context["context"])?;
    let content = checked("surfacePrivateStateProtectedContentSchema", content)?;
    if content["classification"]["recordKind"] != binding["recordKind"] {
        bail!("Surface private-state content and context do not agree.");
    }
    let plaintext = encode_json(
        "surfacePrivateStateProtectedContentSchema",
        &content,
        SURFACE_PRIVATE_STATE_BYTES_LIMIT,
        "Protected surface state exceeds its encoded byte limit.",
    )?;
    let envelope = seal_field(
        key,
        &surface_private_state_associated_data(context)?,
        &plaintext,
    )?;
    checked(
        "surfacePrivateStateOpaqueSchema",
        &json!({"classification":content["classification"],"protectedState":json!({"formatVersion":1,"keyRevision":context["keyRevision"],"envelope":envelope})}),
    )
}

pub fn decrypt_surface_private_state(key: &[u8], context: &Value, opaque: &Value) -> Result<Value> {
    let (binding, opaque) = authenticate(|| {
        let binding = validated_context(&context["context"])?;
        let opaque = checked("surfacePrivateStateOpaqueSchema", opaque)?;
        if opaque["protectedState"]["keyRevision"] != context["keyRevision"]
            || opaque["classification"]["recordKind"] != binding["recordKind"]
        {
            return Err(decryption_error());
        }
        Ok((binding, opaque))
    })?;
    let associated_data = surface_private_state_associated_data(context)?;
    authenticate(|| {
        let plaintext = open_field(key, &associated_data, &opaque["protectedState"]["envelope"])?;
        let content = decode_json(
            "surfacePrivateStateProtectedContentSchema",
            &plaintext,
            SURFACE_PRIVATE_STATE_BYTES_LIMIT,
        )?;
        if content["classification"]["recordKind"] != opaque["classification"]["recordKind"]
            || content["classification"]["recordKind"] != binding["recordKind"]
        {
            return Err(decryption_error());
        }
        Ok(content)
    })
}
