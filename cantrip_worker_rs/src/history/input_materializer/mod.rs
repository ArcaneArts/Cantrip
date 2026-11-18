pub mod media;
use super::{
    attachments::{self, Input, Store},
    projector::Materialization,
};
use crate::{
    attachments::{
        Store as Files,
        content::{self, Keys},
    },
    filesystem::paths,
    native_items::{array, checked, obj, s, text},
};
use anyhow::{Result, bail};
use cantrip_crypto::content::attachment_digest as hash;
use cantrip_history::{files, projection::Work};
use cantrip_wire::{Value, value::json};
use std::{path::PathBuf, sync::Arc};

pub type Published = Arc<dyn Fn(Value) -> Work<Value> + Send + Sync>;
struct Inner {
    directory: PathBuf,
    binding: Value,
    keys: Arc<dyn Keys>,
    files: Files,
    store: Store,
    published: Option<Published>,
}
#[derive(Clone)]
pub struct Materializer(Arc<Inner>);
impl Materializer {
    pub fn new(
        directory: PathBuf,
        binding: Value,
        keys: Arc<dyn Keys>,
        files: Files,
        store: Store,
        published: Option<Published>,
    ) -> Result<Self> {
        Ok(Self(Arc::new(Inner {
            directory: paths::resolve(&directory)?,
            binding,
            keys,
            files,
            store,
            published,
        })))
    }
    pub fn materialize(
        &self,
        item: Value,
        turn: Value,
        context: Value,
        mut published: Option<Value>,
    ) -> Work<Materialization> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let mut input_parts = obj([]);
            let mut result = Vec::new();
            let parts = media::parts(&item["body"]);
            if parts.is_empty() {
                return Ok(Materialization {
                    input_parts: Some(input_parts),
                    attachments: Value::Array(result),
                });
            }
            let identity = obj([
                ("threadId", this.0.binding["threadId"].clone()),
                ("turnId", turn["id"].clone()),
                ("itemId", item["id"].clone()),
                ("identityKind", item["identityKind"].clone()),
                (
                    "component",
                    s(if item["body"]["type"] == "userMessage" {
                        "user"
                    } else {
                        "activity"
                    }),
                ),
            ]);
            for (index, value) in parts.into_iter().enumerate() {
                if !value.is_object() {
                    continue;
                }
                if matches!(value["type"].as_str(), Some("skill" | "mention"))
                    && value["name"].is_string()
                    && value["path"].is_string()
                {
                    input_parts[index.to_string().as_str()] = Value::Array(vec![
                        json!({"type":"text","text":crate::native_items::concat(&[if value["type"] == "skill" { "[Skill: ".into() } else { "[Mention: ".into() },text(&value["name"])?.clone(),"] ".into(),text(&value["path"])?.clone()])}),
                    ]);
                    continue;
                }
                let kind = match value["type"].as_str() {
                    Some("image" | "localImage") => "image",
                    Some("audio" | "localAudio") => "audio",
                    _ => continue,
                };
                let local = matches!(value["type"].as_str(), Some("localImage" | "localAudio"));
                if !local
                    && value["url"]
                        .as_js_string()
                        .is_some_and(|v| !v.units().starts_with(&[100, 97, 116, 97, 58]))
                {
                    continue;
                }
                let (owner, server) = this.0.keys.attachment_identity()?;
                let source_key = hash(
                    media::canonical(&Value::Array(vec![
                        s(server),
                        s(owner),
                        this.0.binding["chatId"].clone(),
                        this.0.binding["workerId"].clone(),
                        identity.clone(),
                        Value::Number(index as f64),
                        value.clone(),
                        if local {
                            context["cwd"].clone()
                        } else {
                            Value::Null
                        },
                    ]))
                    .as_bytes(),
                );
                let manifest = this.0.directory.join(format!("{source_key}.json"));
                let queue = files::queue(&manifest);
                let keep = this.clone();
                let identity = identity.clone();
                let context = context.clone();
                let initial_published = published.clone();
                let (materialized, learned) = queue.run_async(async move {
                    let this = keep;
                    attachments::ensure(this.0.directory.clone()).await?;
                    let retained = attachments::read_optional(manifest.clone()).await?.map(|v| checked("chatAttachmentOpaqueSummarySchema", &v)).transpose()?;
                    let prior = retained.as_ref().map(|v| content::open(this.0.keys.as_ref(), v)).transpose()?;
                    if retained.as_ref().is_some_and(|v| v["chatId"] != this.0.binding["chatId"] || v["status"] != "ready" || prior.as_ref().unwrap()["kind"] != kind) { bail!("Retained native media belongs to another source."); }
                    let mut bytes = None;
                    if let Some(prior) = &prior {
                        let file = this.0.files.resolve(text(&this.0.binding["chatId"])?,text(&prior["id"])?,text(&prior["fileName"])?)?;
                        match media::read(&file).await { Ok(stored) => if prior["sha256"] == hash(&stored).as_str() { bytes = Some(stored); }, Err(e) if attachments::not_found(&e) => (), Err(e) => return Err(e) }
                    }
                    let mut filename = prior.as_ref().map(|v| v["fileName"].clone());
                    let mut mime = prior.as_ref().map(|v| v["mimeType"].clone());
                    if bytes.is_none() {
                        if local {
                            let Some(path) = value["path"].as_js_string().filter(|v| !v.is_empty()) else { bail!("Native local media has no source path."); };
                            let path = paths::native(path);
                            let cwd = paths::native(text(&context["cwd"])?);
                            if !paths::absolute(&path) && !paths::absolute(&cwd) { bail!("Relative native media requires its original working directory."); }
                            let source_path = paths::resolve(&cantrip_config::resolve(&cwd, &path))?;
                            bytes = Some(media::read(&source_path).await?);
                            filename.get_or_insert_with(|| s(paths::text(std::path::Path::new(source_path.file_name().unwrap_or_default()))));
                            mime.get_or_insert_with(|| s(media::mime(&source_path)));
                        } else {
                            let Some(url) = value["url"].as_js_string() else { bail!("Native inline media has no data URL."); };
                            let (decoded, decoded_mime) = media::inline(url, kind)?;
                            bytes = Some(decoded);
                            let mime = mime.get_or_insert_with(|| s(decoded_mime));
                            filename.get_or_insert_with(|| s(format!("native-{kind}-{}.{}",index + 1,media::extension(mime.as_str().unwrap_or("")))));
                        }
                    }
                    let bytes = bytes.unwrap();
                    if prior.as_ref().is_some_and(|v| v["sizeBytes"].as_u64() != Some(bytes.len() as u64) || v["sha256"] != hash(&bytes).as_str()) { bail!("The original native media bytes are unavailable; its source file changed."); }
                    let input = || Input { identity: identity.clone(), part_index: index as f64, file_name: text(filename.as_ref().unwrap()).unwrap().clone(), mime_type: text(mime.as_ref().unwrap()).unwrap().clone(), kind: kind.into(), bytes: cantrip_crypto::Zeroizing::new(bytes.to_vec()), published_attachment: None };
                    let mut materialized = this.0.store.materialize(input()).await?;
                    if retained.as_ref().is_some_and(|v| v["id"] != materialized.attachment["id"]) { bail!("Retained native media identity changed."); }
                    let mut learned = initial_published;
                    if learned.is_some() || this.0.published.is_some() {
                        if learned.is_none() { learned = Some(this.0.published.as_ref().unwrap()(identity.clone()).await?); }
                        if let Some(descriptor) = array(learned.as_ref().unwrap())?.iter().find(|v| v["id"] == materialized.attachment["id"]) {
                            let mut input = input(); input.published_attachment = Some(descriptor.clone());
                            materialized = this.0.store.materialize(input).await?;
                        }
                    }
                    if retained.is_none() { attachments::write(manifest.clone(),materialized.attachment.clone()).await?; }
                    let committed = checked("chatAttachmentOpaqueSummarySchema", &attachments::read_required(manifest).await?)?;
                    if committed["id"] != materialized.attachment["id"] || committed["chatId"] != this.0.binding["chatId"] { bail!("Concurrent native media import retained different source bytes."); }
                    Ok((materialized,learned))
                }).await?;
                published = learned;
                input_parts[index.to_string().as_str()] = materialized.content;
                result.push(materialized.attachment);
            }
            Ok(Materialization {
                input_parts: Some(input_parts),
                attachments: Value::Array(result),
            })
        })
    }
}
