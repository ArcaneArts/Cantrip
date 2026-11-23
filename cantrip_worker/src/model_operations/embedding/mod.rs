mod request;
mod vectors;

use super::{
    MAX_BYTES, MAX_SAFE_COUNT, Operation, Request, count, either, error, http, merged_options,
    object, usage,
};
use crate::metadata::Signal;
use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use request::{Adapter, Payload};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

const MAX_VECTOR_BYTES: usize = MAX_BYTES - 32_768;
const RESULT_LIMIT: &str = "The embedding result exceeds 4 MiB. Submit smaller jobs.";

struct BatchRequest {
    http: reqwest::Client,
    payload: Payload,
    options: Value,
    count: usize,
    api_key: Option<JsString>,
    usage: Arc<Mutex<usage::Usage>>,
}

#[derive(Clone)]
struct Batch {
    vectors: Vec<Value>,
    dimensions: Option<usize>,
    input_format: Option<&'static str>,
    configuration: Value,
    actual_model: Value,
    input_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

impl BatchRequest {
    async fn send(self, signal: Signal) -> Result<Batch> {
        let body = self.payload.body.stringify();
        if body.len() > MAX_BYTES {
            return Err(error(
                "invalid-request",
                "The embedding batch exceeds the 4 MiB request limit.",
            ));
        }
        let timeout = http::timeout(&self.options)?;
        let start = self.usage.lock().unwrap().begin();
        let mut counts = [None; 6];
        let request = async {
            let raw = http::post(
                &self.http,
                self.payload.url.clone(),
                &body,
                self.api_key.as_ref(),
                Operation::Embedding,
                false,
            )
            .await?;
            let root = vectors::root(&raw, self.payload.adapter);
            let reported = usage::reported(root, Operation::Embedding);
            counts = usage::observed(reported);
            let vectors = vectors::parse(&raw, self.payload.adapter, &self.options, self.count)?;
            let valid_usage = |value: &Value| {
                if value.is_null() {
                    Ok(None)
                } else {
                    count(value)
                        .map(Some)
                        .context("Invalid embedding token count")
                        .map_err(|_| invalid_response())
                }
            };
            let configuration = configuration(&self.payload);
            Ok(Batch {
                dimensions: vectors::dimensions(&vectors[0]),
                vectors,
                input_format: input_format(&self.payload),
                configuration,
                actual_model: root["model"]
                    .as_js_string()
                    .filter(|name| !name.is_empty())
                    .map_or(Value::Null, |name| json!(name)),
                input_tokens: valid_usage(reported[0])?,
                total_tokens: valid_usage(reported[2])?,
            })
        };
        let (result, status) = tokio::select! {
            biased;
            _ = signal.cancelled() => (
                Err(error("cancelled", "The embedding operation was cancelled.")), "cancelled"
            ),
            result = tokio::time::timeout(timeout, request) => match result {
                Ok(result) => {
                    let status = if result.is_ok() { "succeeded" } else { "failed" };
                    (result, status)
                }
                Err(_) => (
                    Err(error("provider-error", "The embedding provider request timed out.")), "failed"
                ),
            }
        };
        self.usage.lock().unwrap().end(start, status, counts);
        result
    }
}

fn invalid_response() -> anyhow::Error {
    error(
        "invalid-response",
        "The provider returned malformed embedding data.",
    )
}

fn input_format(payload: &Payload) -> Option<&'static str> {
    payload
        .adapter
        .vllm_chat()
        .then_some(if payload.body["messages"].is_array() {
            "chat"
        } else {
            "text"
        })
}

fn configuration(payload: &Payload) -> Value {
    let mut config = object(&payload.body);
    for key in ["input", "inputs", "messages", "images", "texts"] {
        config.shift_remove(key);
    }
    if let Some(data) = config.get_mut("data")
        && let Value::Object(params) = data
    {
        params.shift_remove("input");
    }
    let mut config = Value::Object(config);
    config["endpoint"] = json!(payload.url.as_str());
    config["adapter"] = json!(payload.adapter.name());
    if let Some(format) = input_format(payload) {
        config["inputFormat"] = json!(format);
        config["messageRole"] = payload.body["messages"]
            .as_array()
            .map_or(Value::Null, |messages| messages[0]["role"].clone());
    }
    config
}

fn options(route: &Value, request: &Value, adapter: Adapter, items: &[Value]) -> Value {
    let mut options = merged_options(route, request);
    if options["mediaFormat"].is_null()
        && ((adapter.vllm_chat() && request["expectedSpace"]["inputFormat"] == "chat")
            || adapter.uses_chat(&options, items))
    {
        options["mediaFormat"] = json!("content-parts");
    }
    options
}

fn space(route: &Value, options: &Value, batch: &Batch) -> Value {
    let revision = either(&options["modelRevision"], &route["observedRevision"]);
    let revision_source = if !options["modelRevision"].is_null() {
        "configured"
    } else if route["observedRevision"]
        .as_js_string()
        .is_some_and(|value| !value.is_empty())
    {
        "provider-catalog"
    } else {
        "unknown"
    };
    let mut identity = json!({
        "version":1,"modelId":route["modelId"],"routeId":route["routeId"],"providerId":route["provider"]["id"],
        "requestedModel":route["modelName"],"actualModel":batch.actual_model,
        "modelRevision":revision,"revisionVerified":false,"revisionSource":revision_source,
        "dimensions":batch.dimensions,"normalization":either(&options["normalization"], &json!("provider-default")),
        "inputType":options["inputType"],"configuredSpace":options["embeddingSpace"],
    });
    if let Some(format) = batch.input_format {
        identity["inputFormat"] = json!(format);
    }
    if batch.vectors[0]["representation"] != "dense" {
        identity["representation"] = batch.vectors[0]["representation"].clone();
    }
    let mut fingerprint = json!({
        "identity":identity,"configuration":batch.configuration,
        "mediaFormat":either(&options["mediaFormat"], &json!("content-parts")),
    });
    for key in ["vectorRepresentation", "messageRole"] {
        if let Some(value) = options.get(key) {
            fingerprint[key] = value.clone();
        }
    }
    identity["fingerprint"] = json!(payload_digest(&fingerprint));
    identity
}

fn add_usage(previous: Option<u64>, next: Option<u64>) -> Result<Option<u64>> {
    previous
        .zip(next)
        .map(|(previous, next)| {
            let count = previous + next;
            if count > MAX_SAFE_COUNT {
                Err(invalid_response())
            } else {
                Ok(count)
            }
        })
        .transpose()
}

pub(super) async fn run(job: Request<'_>) -> Result<Value> {
    let items = job.input["items"]
        .as_array()
        .context("Validated embedding items")?;
    let adapter = Adapter::select(job.route, job.provider)?;
    let options = options(job.route, job.input, adapter, items);
    if !options["normalization"].is_null()
        && !matches!(options["normalization"].as_str(), Some("none" | "l2"))
    {
        return Err(error(
            "invalid-request",
            "Normalization must be none or l2, or left at the provider default.",
        ));
    }
    job.configure()?;
    let cap = &job.route["capabilities"]["embedding"];
    let max_dimension = either(&options["dimensions"], &cap["dimensions"])
        .as_u64()
        .unwrap_or(4_096);
    let chat_batch = if adapter.uses_chat(&options, items) {
        1
    } else {
        32
    };
    let limit = chat_batch
        .min(options["maxBatchSize"].as_u64().unwrap_or(32))
        .min(cap["maxBatchSize"].as_u64().unwrap_or(32))
        .min(((MAX_VECTOR_BYTES as u64) / max_dimension.saturating_mul(24)).max(1))
        as usize;
    let mut result = Vec::with_capacity(items.len());
    let mut input_tokens = Some(0);
    let mut total_tokens = Some(0);
    let mut result_bytes = 0;
    let mut identity = Value::Null;
    let mut batches = 0;
    let mut offset = 0;
    while offset < items.len() {
        job.signal.check()?;
        let mut size = limit.min(items.len() - offset);
        let (payload, batch) = loop {
            let batch = &items[offset..offset + size];
            let payload = request::payload(adapter, job.route, job.provider, &options, batch)?;
            if size == 1 || payload.body.stringify().len() <= MAX_BYTES {
                break (payload, batch);
            }
            size = size.div_ceil(2);
        };
        batches += 1;
        let request = BatchRequest {
            http: job.http.clone(),
            payload,
            options: options.clone(),
            count: size,
            api_key: job.provider["apiKey"].as_js_string().cloned(),
            usage: job.usage.clone(),
        };
        let output = job
            .run_direct(batches, true, move |signal| Box::pin(request.send(signal)))
            .await?;
        let current = space(job.route, &options, &output);
        let fingerprint = &current["fingerprint"];
        if (!identity.is_null() && &identity["fingerprint"] != fingerprint)
            || (!job.input["expectedSpace"].is_null()
                && &job.input["expectedSpace"]["fingerprint"] != fingerprint)
        {
            return Err(error(
                "embedding-space-mismatch",
                "The endpoint returned a different embedding space. Vectors were not combined or returned.",
            ));
        }
        identity = current;
        let additions = output
            .vectors
            .into_iter()
            .zip(batch)
            .enumerate()
            .map(|(index, (mut vector, input))| {
                vector["id"] = input["id"].clone();
                vector["index"] = json!(offset + index);
                vector
            })
            .collect::<Vec<_>>();
        result_bytes += additions
            .iter()
            .map(|value| value.stringify().len() + 1)
            .sum::<usize>()
            + 1;
        if result_bytes > MAX_VECTOR_BYTES {
            return Err(error("invalid-request", RESULT_LIMIT));
        }
        result.extend(additions);
        input_tokens = add_usage(input_tokens, output.input_tokens)?;
        total_tokens = add_usage(total_tokens, output.total_tokens)?;
        offset += size;
    }
    let value = json!({
        "space":identity,"items":result,"usage":json!({"inputTokens":input_tokens,"totalTokens":total_tokens}),"batches":batches,
    });
    if json!({"status":"succeeded","value":value})
        .stringify()
        .len()
        > MAX_BYTES
    {
        return Err(error("invalid-request", RESULT_LIMIT));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_adapters_keep_native_paths_payloads_and_vector_shapes() -> Result<()> {
        let route = json!({"modelName":"fixture"});
        let provider = json!({"kind":"openai-compatible","baseUrl":"http://127.0.0.1:8/prefix/v1"});
        let items = [json!({"id":"first","content":vec![json!({"type":"text","text":"private"})]})];
        let index = |field: &str, value: Value| {
            let mut row = json!({"index":0});
            row[field] = value;
            row
        };
        let rows = |field, value| vec![index(field, value)];
        let cases = [
            (
                Adapter::OpenAi,
                "/prefix/v1/embeddings",
                "input",
                json!({"data":rows("embedding", json!("AACAPw=="))}),
                "dense",
                Some(1),
            ),
            (
                Adapter::Ollama,
                "/prefix/api/embed",
                "input",
                json!({"embeddings":[[1.0,2.0]]}),
                "dense",
                Some(2),
            ),
            (
                Adapter::Llama,
                "/prefix/embeddings",
                "input",
                json!(rows("embedding", json!([[1.0, 2.0], [3.0, 4.0]]))),
                "multi-vector",
                Some(2),
            ),
            (
                Adapter::Vllm,
                "/prefix/v1/embeddings",
                "input",
                json!({"data":rows("embedding", json!([1.0,2.0]))}),
                "dense",
                Some(2),
            ),
            (
                Adapter::Pooling,
                "/prefix/pooling",
                "task",
                json!({"data":rows("data", json!([[1.0,2.0],[3.0,4.0]]))}),
                "multi-vector",
                Some(2),
            ),
            (
                Adapter::Bge,
                "/prefix/pooling",
                "data",
                json!({"data":json!({"data":vec![json!({
                    "index":0,"dense_embedding":[1.0,2.0],
                    "sparse_embedding":vec![json!({"token_id":3,"weight":0.5})],
                })]})}),
                "hybrid",
                Some(2),
            ),
            (
                Adapter::Cohere,
                "/prefix/v2/embed",
                "texts",
                json!({"embeddings":json!({"float":[[1.0,2.0]]})}),
                "dense",
                Some(2),
            ),
        ];
        for (adapter, path, field, response, representation, dimensions) in cases {
            let options = json!({});
            let request = request::payload(adapter, &route, &provider, &options, &items)?;
            assert_eq!(request.url.path(), path);
            assert!(request.body.get(field).is_some());
            let result = vectors::parse(&response, adapter, &options, 1)?;
            assert_eq!(result[0]["representation"], representation);
            assert_eq!(vectors::dimensions(&result[0]), dimensions);
        }
        Ok(())
    }

    #[test]
    fn indexed_results_reject_duplicates_and_vllm_uses_one_media_conversation() -> Result<()> {
        let duplicate = json!({"data":vec![
            json!({"index":0,"embedding":[1.0]}),
            json!({"index":0,"embedding":[2.0]}),
        ]});
        assert!(vectors::parse(&duplicate, Adapter::OpenAi, &json!({}), 2).is_err());
        let items = [
            json!({"id":"one","content":vec![json!({"type":"audio","url":"https://example.invalid/a"})]}),
        ];
        let provider = json!({"kind":"vllm","baseUrl":"http://127.0.0.1:8/v1"});
        let route = json!({"modelName":"fixture"});
        let options = json!({"mediaFormat":"content-parts","messageRole":"assistant"});
        let request = request::payload(Adapter::Vllm, &route, &provider, &options, &items)?;
        let message = &request.body["messages"].as_array().unwrap()[0];
        assert_eq!(message["role"], "assistant");
        let audio = &message["content"].as_array().unwrap()[0];
        assert_eq!(audio["type"], "audio_url");
        assert_eq!(audio["audio_url"]["url"], "https://example.invalid/a");
        Ok(())
    }
}
