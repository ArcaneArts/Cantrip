//! Synthetic keys and owned files; invokes actual native stores/adapters.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use cantrip_history::projection::Work;
use cantrip_worker::{
    attachments::{self, content::Keys as AttachmentKeys},
    history::{
        adapters,
        input_materializer::{Materializer, Published},
        projector::Adapters,
        turn_context::{self, Index, Source},
    },
};
impl AttachmentKeys for Keys {
    fn attachment_identity(&self) -> Result<(JsString, JsString)> {
        self.identity()
    }
    fn attachment_material(&self) -> Result<Material> {
        let mut material = self.material(None)?;
        if let Some(byte) = self.0.lock().unwrap()["attachmentKeyByte"].as_u64() {
            material.key = Zeroizing::new(vec![byte as u8; 32]);
        }
        Ok(material)
    }
}
#[derive(Default)]
pub struct Engine {
    files: HashMap<String, attachments::Store>,
    indices: HashMap<String, Index>,
    sources: HashMap<String, Arc<Scripted>>,
}
struct Scripted {
    config: Arc<Mutex<Value>>,
    trace: Arc<Mutex<Vec<Value>>>,
}
impl Source for Scripted {
    fn scope(&self) -> Value {
        self.config.lock().unwrap()["scope"].clone()
    }
    fn head(&self) -> Work<Value> {
        self.trace.lock().unwrap().push(json!(["head"]));
        let mut config = self.config.lock().unwrap();
        let value = if let Value::Object(fields) = &mut *config {
            fields.shift_remove("headOnce")
        } else {
            None
        };
        let records = config["records"].as_array().cloned().unwrap_or_default();
        let value = value.unwrap_or_else(|| json!({"sequence":records.len(),"recordId":records.last().map_or(Value::Null, |v| v["recordId"].clone())}));
        Box::pin(async { Ok(value) })
    }
    fn read(&self, after: u64, limit: u64) -> Work<Vec<Value>> {
        self.trace
            .lock()
            .unwrap()
            .push(json!([json!("read"), json!(after), json!(limit)]));
        let mut config = self.config.lock().unwrap();
        let records = config["records"].as_array().cloned().unwrap_or_default();
        let error = if let Value::Object(fields) = &mut *config {
            fields.shift_remove("readErrorOnce")
        } else {
            None
        };
        if let Some(append) = config.get("appendDuringRead").cloned() {
            if let Value::Object(fields) = &mut *config {
                fields.shift_remove("appendDuringRead");
            }
            let mut all = records.clone();
            all.push(append);
            config["records"] = Value::Array(all);
        }
        let missing = config["missing"] == true;
        Box::pin(async move {
            if let Some(error) = error {
                bail!("{}", error.as_str().unwrap());
            }
            Ok(if missing {
                Vec::new()
            } else {
                records
                    .into_iter()
                    .skip(after as usize)
                    .take(limit as usize)
                    .collect()
            })
        })
    }
}
fn string(input: &Value, key: &str) -> Result<JsString> {
    input[key]
        .as_js_string()
        .cloned()
        .ok_or_else(|| anyhow!("fixture missing {key}"))
}
fn binary(input: &Value) -> Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(
        STANDARD.decode(input["bytes"].as_str().unwrap_or(""))?,
    ))
}
fn input(raw: &Value) -> Result<cantrip_worker::history::attachments::Input> {
    Ok(cantrip_worker::history::attachments::Input {
        identity: raw["identity"].clone(),
        part_index: raw["partIndex"].as_f64().unwrap_or(f64::NAN),
        file_name: string(raw, "fileName")?,
        mime_type: string(raw, "mimeType")?,
        kind: string(raw, "kind")?,
        bytes: binary(raw)?,
        published_attachment: raw.get("publishedAttachment").cloned(),
    })
}
impl Engine {
    pub async fn run(
        &mut self,
        keys: Arc<Keys>,
        journals: &HashMap<String, Journal>,
        request: &Value,
    ) -> Result<Value> {
        let op = request["op"].as_str().unwrap();
        let handle = request["handle"].as_str().unwrap_or("a").to_owned();
        match op {
            "adapters.filename" => {
                return Ok(Value::String(attachments::paths::safe_filename(&string(
                    request, "value",
                )?)));
            }
            "adapters.context.resolve" => {
                return turn_context::resolve(request["contexts"].as_array().unwrap());
            }
            "adapters.index.open" => {
                let source = Arc::new(Scripted {
                    config: Arc::new(Mutex::new(request["config"].clone())),
                    trace: Arc::new(Mutex::new(Vec::new())),
                });
                self.indices
                    .insert(handle.clone(), Index::new(source.clone(), None));
                self.sources.insert(handle, source);
                return Ok(Value::Null);
            }
            "adapters.index.configure" => {
                let mut config = self.sources[&handle].config.lock().unwrap();
                for (key, value) in request["config"].as_object().unwrap() {
                    if let Value::Object(fields) = &mut *config {
                        fields.insert(key.clone(), value.clone());
                    }
                }
                return Ok(Value::Null);
            }
            "adapters.index.refresh" => {
                self.indices[&handle].refresh().await?;
                return Ok(Value::Array(
                    self.sources[&handle].trace.lock().unwrap().clone(),
                ));
            }
            "adapters.index.read" => {
                return Ok(Value::Array(self.indices[&handle].read(&request["turn"])?));
            }
            "adapters.index.child" => {
                return self.indices[&handle].child_metadata(&request["parent"]);
            }
            _ => (),
        }
        let data = request["dataDirectory"]
            .as_str()
            .unwrap_or("/fixture-unused")
            .to_owned();
        if request["reopen"] == true {
            self.files.remove(&data);
        }
        let files = self
            .files
            .entry(data.clone())
            .or_insert(attachments::Store::new(std::path::Path::new(&data), None)?)
            .clone();
        if let Some(op) = op.strip_prefix("adapters.file.") {
            let chat = string(request, "chatId")?;
            let id = string(request, "attachmentId")?;
            return match op {
                "resolve" => Ok(json!(cantrip_worker::filesystem::paths::text(
                    &files.resolve(&chat, &id, &string(request, "fileName")?)?
                ))),
                "begin" => {
                    files
                        .begin(
                            chat,
                            id,
                            string(request, "fileName")?,
                            request["sizeBytes"].as_f64().unwrap_or(f64::NAN),
                            string(request, "operationId")?,
                            request["sha256"].as_str().unwrap().to_owned(),
                        )
                        .await?;
                    Ok(Value::Null)
                }
                "append" => {
                    files
                        .append(
                            chat,
                            id,
                            request["chunkIndex"].as_f64().unwrap_or(f64::NAN),
                            binary(request)?,
                            string(request, "operationId")?,
                            request["eof"] == true,
                        )
                        .await?;
                    Ok(Value::Null)
                }
                "complete" => {
                    files
                        .complete(chat, id, string(request, "operationId")?)
                        .await
                }
                "abort" => Ok(json!(
                    files
                        .abort(chat, id, string(request, "operationId")?)
                        .await?
                )),
                "remove" => {
                    files.remove(chat, id).await?;
                    Ok(Value::Null)
                }
                "read" => {
                    let read = files
                        .read(
                            chat,
                            id,
                            string(request, "fileName")?,
                            request["offset"].as_f64().unwrap_or(f64::NAN),
                            request["limit"].as_f64().unwrap_or(f64::NAN),
                        )
                        .await?;
                    Ok(
                        json!({"bytes":STANDARD.encode(&read.bytes),"sizeBytes":read.size_bytes,"eof":read.eof}),
                    )
                }
                _ => bail!("Unknown file operation"),
            };
        }
        if op == "adapters.open" {
            return attachments::content::open(keys.as_ref(), &request["attachment"]);
        }
        let directory = PathBuf::from(request["directory"].as_str().unwrap_or(&data));
        let binding = request["binding"].clone();
        if op == "adapters.verified" {
            let source = journals
                .get(request["source"].as_str().unwrap_or("a"))
                .ok_or_else(|| anyhow!("fixture source missing"))?
                .clone();
            let child_scope = request.get("childScope").cloned().map(|v| {
                Arc::new(move |_, _| -> Work<Value> {
                    let v = v.clone();
                    Box::pin(async { Ok(v) })
                }) as adapters::PairCallback
            });
            let adapter = adapters::Verified::new(adapters::Options {
                directory,
                binding,
                source,
                keys,
                files,
                signal: None,
                child_scope,
                child_association: None,
                published_attachments: None,
            })?;
            adapter.prepare().await?;
            let context = adapter
                .context(request["item"].clone(), request["turn"].clone())
                .await?;
            let association = adapter
                .associate(request["draft"].clone(), request["turn"].clone())
                .await?;
            return Ok(json!({"context":context,"association":association}));
        }
        let store = cantrip_worker::history::attachments::Store::new(
            directory.clone(),
            binding.clone(),
            keys.clone(),
            files.clone(),
        )?;
        if op == "adapters.attachment" || op == "adapters.concurrent" {
            let pending: Vec<_> = (0..if op == "adapters.concurrent" { 2 } else { 1 })
                .map(|_| Ok(store.materialize(input(&request["input"])?)))
                .collect::<Result<_>>()?;
            let mut values = Vec::new();
            for pending in pending {
                let v = pending.await?;
                values.push(json!({"attachment":v.attachment,"content":v.content}));
            }
            return Ok(if op == "adapters.concurrent" {
                Value::Array(values)
            } else {
                values.remove(0)
            });
        }
        if op == "adapters.media" {
            let calls = Arc::new(Mutex::new(0));
            let observed = calls.clone();
            let callback = request.get("callbackAttachments").cloned().map(|v| {
                Arc::new(move |_| -> Work<Value> {
                    *observed.lock().unwrap() += 1;
                    let v = v.clone();
                    Box::pin(async { Ok(v) })
                }) as Published
            });
            let materializer = Materializer::new(
                directory.join("parts"),
                binding,
                keys,
                files,
                store,
                callback,
            )?;
            let value = materializer
                .materialize(
                    request["item"].clone(),
                    request["turn"].clone(),
                    request["context"].clone(),
                    request.get("publishedAttachments").cloned(),
                )
                .await?;
            return Ok(
                json!({"inputParts":value.input_parts,"attachments":value.attachments,"publishedCalls":*calls.lock().unwrap()}),
            );
        }
        bail!("Unknown verified adapter fixture operation")
    }
}
