//! Version-checked binary saves. The original upload ID, encrypted records,
//! frame positions, and prepared publication survive a worker replacement.
mod publication;
mod storage;

use super::{paths, stamp};
use crate::{encryption::ComponentKey, filesystem::paths as host};
use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine, alphabet,
    engine::{GeneralPurpose, general_purpose::PAD},
};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{JsString, Value, value::json};
use publication::Destination;
use std::{
    io,
    path::{Path, PathBuf},
};
use storage::Storage;
use subtle::ConstantTimeEq;
use uuid::Uuid;

const CHUNK: u64 = 256 * 1024;
const MAX_SAFE: u64 = (1 << 53) - 1;
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    PAD.with_decode_allow_trailing_bits(true),
);

#[derive(Debug)]
pub(crate) struct Conflict;

impl std::fmt::Display for Conflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "This file changed on disk. Keep the draft and reload or save it to another path.",
        )
    }
}
impl std::error::Error for Conflict {}

#[derive(Clone)]
pub(crate) struct Writer {
    data: PathBuf,
    locks: PathBuf,
}

impl Writer {
    pub(crate) fn new(data: &Path, locks: &Path) -> Self {
        Self {
            data: data.to_owned(),
            locks: locks.to_owned(),
        }
    }

    pub(crate) async fn execute(
        &self,
        root: &JsString,
        context: &Value,
        request: &Value,
        owner: Value,
        key: ComponentKey,
    ) -> Result<Value> {
        let root = json!(root);
        let binding = Value::Array(vec![
            context["serverId"].clone(),
            owner.clone(),
            context["surfaceKind"].clone(),
            context["surfaceId"].clone(),
            root.clone(),
            request["path"].clone(),
            request["uploadId"].clone(),
        ]);
        let upload = stamp::hash(binding.stringify().as_bytes());
        let writer = self.clone();
        let request = request.clone();
        tokio::task::spawn_blocking(move || {
            let storage = Storage::new(
                &writer.data,
                &writer.locks,
                &owner,
                &key.key,
                key.key_revision,
            );
            let _lock = storage.lock("upload", &upload)?;
            let receipt = run(&storage, &root, &upload, &request)?;
            Ok(json!({"type":"explorer.binary.write","value":receipt}))
        })
        .await?
    }
}

pub(crate) fn action(request: &Value) -> Option<&str> {
    request["type"]
        .as_str()?
        .strip_prefix("explorer.binary.write.")
}

fn run(storage: &Storage<'_>, root: &Value, upload: &str, request: &Value) -> Result<Value> {
    let action = action(request).context("Missing binary write action.")?;
    let saved = storage.read(upload)?;
    let record = saved
        .map(|record| validated(record, root, upload, request))
        .transpose()?;
    if action == "begin" {
        if let Some(mut record) = record {
            if record["state"] != "aborted" {
                ensure!(
                    record["expected"] == request["version"],
                    "The binary upload baseline changed."
                );
                publication::reconcile(storage, &mut record, true)?;
            }
            return Ok(receipt(&record));
        }
        let target = publication::inspect(root, &request["path"], &request["version"], None)?;
        match storage.create(upload) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                storage.discard(upload)?;
                storage.create(upload)?;
            }
            Err(error) => return Err(error.into()),
        }
        let record = fresh(root, upload, request, Some(target));
        storage.save(upload, &record)?;
        return Ok(receipt(&record));
    }
    let Some(mut record) = record else {
        match action {
            "abort" => {
                let record = fresh(root, upload, request, None);
                storage.save(upload, &record)?;
                return Ok(receipt(&record));
            }
            "status" => {
                return Ok(receipt(&json!({
                    "path":request["path"],"uploadId":request["uploadId"],"state":"unknown",
                    "offset":0,"size":Value::Null,"sha256":Value::Null,"error":Value::Null,
                })));
            }
            _ => bail!("Binary upload is unavailable. Start a new save."),
        }
    };
    match action {
        "status" => publication::reconcile(storage, &mut record, true)?,
        "abort" => abort(storage, &mut record)?,
        "commit" => commit(storage, &mut record, request)?,
        "chunk" => append(storage, &mut record, request)?,
        _ => bail!("Unknown binary write action."),
    }
    Ok(receipt(&record))
}

fn receipt(record: &Value) -> Value {
    let version = (record["state"] == "committed")
        .then(|| format!("binary-sha256:{}", record["sha256"].as_str().unwrap()));
    json!({
        "path":record["path"],"uploadId":record["uploadId"],"state":record["state"],
        "offset":record["offset"],"size":record["size"],"sha256":record["sha256"],
        "version":version,"error":record["error"],
    })
}

fn fresh(root: &Value, upload: &str, request: &Value, destination: Option<Destination>) -> Value {
    let (target, publication, expected, mode, state) = if let Some(destination) = destination {
        let sibling = destination
            .path
            .with_file_name(format!(".cantrip-publish-{}", Uuid::new_v4()));
        (
            host::text(&destination.path),
            host::text(&sibling),
            request["version"].clone(),
            destination.mode,
            "uploading",
        )
    } else {
        (
            JsString::from(""),
            JsString::from(""),
            Value::Null,
            0,
            "aborted",
        )
    };
    json!({
        "formatVersion":1,"key":upload,"root":root,"path":request["path"],"uploadId":request["uploadId"],
        "target":target,"publication":publication,"publicationVersion":Value::Null,"expected":expected,
        "mode":mode,"offset":0,"frames":0,"final":false,"state":state,
        "size":Value::Null,"sha256":Value::Null,"error":Value::Null,
    })
}

fn validated(record: Value, root: &Value, upload: &str, request: &Value) -> Result<Value> {
    ensure!(
        record["formatVersion"] == 1
            && record["key"] == upload
            && record["root"] == *root
            && record["path"] == request["path"]
            && record["uploadId"] == request["uploadId"],
        "Binary write receipt belongs to another document."
    );
    let counter = |key| record[key].as_u64().is_some_and(|value| value <= MAX_SAFE);
    let state = record["state"]
        .as_str()
        .context("Invalid binary write state.")?;
    ensure!(
        matches!(
            state,
            "uploading" | "prepared" | "committed" | "conflict" | "aborted"
        ) && counter("offset")
            && counter("frames")
            && (record["size"].is_null() || counter("size"))
            && record["mode"].as_u64().is_some_and(|mode| mode <= 0o777)
            && record["final"].as_bool().is_some()
            && (record["sha256"].is_null() || digest(&record["sha256"]))
            && (record["error"].is_null() || record["error"].is_string())
            && (record["expected"].is_null() || binary_version(&record["expected"]))
            && (record["publicationVersion"].is_null()
                || binary_version(&record["publicationVersion"])),
        "Invalid binary write receipt."
    );
    if matches!(state, "prepared" | "committed" | "conflict") {
        ensure!(
            counter("size")
                && digest(&record["sha256"])
                && binary_version(&record["publicationVersion"]),
            "The binary publication receipt is incomplete."
        );
    }
    let target = record["target"]
        .as_js_string()
        .context("Invalid binary write target.")?;
    let pending = record["publication"]
        .as_js_string()
        .context("Invalid binary publication path.")?;
    if state == "aborted" && target.is_empty() && pending.is_empty() {
        return Ok(record);
    }
    let target = host::native(target);
    let pending = host::native(pending);
    ensure!(
        target.is_absolute()
            && pending.parent() == target.parent()
            && pending
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix(".cantrip-publish-"))
                .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok()),
        "Invalid binary publication path."
    );
    Ok(record)
}

fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn binary_version(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|value| {
            value
                .strip_prefix("binary-v1:")
                .or_else(|| value.strip_prefix("binary-sha256:"))
        })
        .is_some_and(|value| digest(&json!(value)))
}

fn abort(storage: &Storage<'_>, record: &mut Value) -> Result<()> {
    if record["state"] == "prepared" {
        publication::reconcile(storage, record, false)?;
    }
    if record["state"] == "committed" {
        return Ok(());
    }
    let upload = record["key"].as_str().unwrap().to_owned();
    record["state"] = json!("aborted");
    record["error"] = Value::Null;
    storage.save(&upload, record)?;
    storage.discard(&upload)?;
    let pending = record["publication"].as_js_string().unwrap();
    if !pending.is_empty() {
        storage::remove_file(&host::native(pending))?;
    }
    Ok(())
}

fn commit(storage: &Storage<'_>, record: &mut Value, request: &Value) -> Result<()> {
    match record["state"].as_str() {
        Some("committed") => {
            ensure!(
                record["size"] == request["size"] && record["sha256"] == request["sha256"],
                "The committed upload does not match this save."
            );
            return Ok(());
        }
        Some("prepared") => {
            ensure!(
                record["size"] == request["size"] && record["sha256"] == request["sha256"],
                "The prepared upload does not match this save."
            );
            return publication::reconcile(storage, record, true);
        }
        _ => ensure!(
            record["state"] == "uploading"
                && record["final"] == true
                && record["offset"] == request["size"],
            "The binary upload is not complete."
        ),
    }
    record["size"] = request["size"].clone();
    record["sha256"] = request["sha256"].clone();
    publication::materialize(storage, record)?;
    record["state"] = json!("prepared");
    storage.save(record["key"].as_str().unwrap(), record)?;
    publication::reconcile(storage, record, true)
}

fn append(storage: &Storage<'_>, record: &mut Value, request: &Value) -> Result<()> {
    ensure!(
        record["state"] == "uploading",
        "This binary upload no longer accepts chunks."
    );
    let bytes =
        Zeroizing::new(BASE64.decode(request["data"].as_str().context("Binary chunk data")?)?);
    let offset = request["offset"].as_u64().context("Binary chunk offset")?;
    let final_page = request["final"] == true;
    ensure!(
        offset.is_multiple_of(CHUNK)
            && bytes.len() <= CHUNK as usize
            && (final_page || bytes.len() == CHUNK as usize),
        "Binary chunks require ordered full pages and one final page."
    );
    let upload = record["key"].as_str().unwrap().to_owned();
    let captured = record["offset"].as_u64().unwrap();
    let frames = record["frames"].as_u64().unwrap();
    if record["final"] == true || offset < captured {
        let index = offset / CHUNK;
        ensure!(index < frames, "Binary retry offset is unavailable.");
        let (prior, was_final) =
            storage.frame(&upload, &mut storage.open_stage(&upload)?, index)?;
        ensure!(
            was_final == final_page
                && prior.len() == bytes.len()
                && bool::from(prior.as_slice().ct_eq(bytes.as_slice())),
            "A retried binary chunk has different content."
        );
        return Ok(());
    }
    ensure!(
        offset == captured,
        "Binary chunk offset does not match the uploaded prefix."
    );
    let next = offset + bytes.len() as u64;
    ensure!(
        next <= MAX_SAFE,
        "Binary upload exceeds supported byte addressing."
    );
    storage.append(&upload, offset, &bytes, final_page, frames)?;
    record["offset"] = json!(next);
    record["frames"] = json!(frames + 1);
    record["final"] = json!(final_page);
    storage.save(&upload, record)
}
