mod answers;
mod media;
mod request;

use super::{MAX_BYTES, Operation, Request, count, either, error, http, merged_options, usage};
use crate::{http::checked, metadata::Signal};
use anyhow::Result;
use cantrip_wire::{Value, value::json};
use request::Adapter;
use std::sync::{Arc, Mutex};

const OPERATION: Operation = Operation::Decision;
const CANCELLED: &str = "The decision operation was cancelled.";

pub(super) async fn run(job: Request<'_>) -> Result<Value> {
    job.configure()?;
    let call = Call {
        route: job.route.clone(),
        provider: job.provider.clone(),
        input: job.input.clone(),
        options: merged_options(job.route, job.input),
        http: job.http.clone(),
        usage: job.usage.clone(),
    };
    let result = job
        .run_direct(1, false, move |signal| Box::pin(call.send(signal)))
        .await;
    if result.is_err() && job.signal.check().is_err() {
        return Err(error("cancelled", CANCELLED));
    }
    result
}

struct Call {
    route: Value,
    provider: Value,
    input: Value,
    options: Value,
    http: reqwest::Client,
    usage: Arc<Mutex<usage::Usage>>,
}

impl Call {
    async fn send(self, signal: Signal) -> Result<Value> {
        let timeout = http::timeout(&self.options)?;
        let payload = request::payload(&self.route, &self.provider, &self.input, &self.options)?;
        let body = payload.body.stringify();
        if body.len() > MAX_BYTES {
            return Err(error(
                "invalid-request",
                "The native decision request exceeds 4 MiB.",
            ));
        }
        let start = self.usage.lock().unwrap().begin();
        let mut counts = [None; 6];
        let attempt = async {
            let raw = http::post(
                &self.http,
                payload.url,
                &body,
                self.provider["apiKey"].as_js_string(),
                OPERATION,
                self.options["typesafeImages"] == true,
            )
            .await?;
            let reported = usage::reported(&raw, OPERATION);
            counts = usage::observed(reported);
            self.result(payload.adapter, &raw, reported)
        };
        let (result, status) = tokio::select! {
            biased;
            _ = signal.cancelled() => (Err(error("cancelled", CANCELLED)), "cancelled"),
            result = tokio::time::timeout(timeout, attempt) => match result {
                Ok(result) => {
                    let status = if result.is_ok() { "succeeded" } else { "failed" };
                    (result, status)
                }
                Err(_) => (
                    Err(error("provider-error", "The decision provider request timed out.")), "failed"
                ),
            }
        };
        self.usage.lock().unwrap().end(start, status, counts);
        result
    }

    fn result(&self, adapter: Adapter, raw: &Value, reported: [&Value; 6]) -> Result<Value> {
        let answers = answers::parse(&raw["answers"], &self.input["questions"], adapter)?;
        let cost = &raw["usage"]["cost"];
        if !cost.is_null()
            && !cost
                .as_f64()
                .is_some_and(|cost| cost.is_finite() && cost >= 0.0)
        {
            return Err(OPERATION.malformed());
        }
        let token_count = |value: &Value| {
            if value.is_null() {
                Ok(None)
            } else {
                count(value).map(Some).ok_or_else(|| OPERATION.malformed())
            }
        };
        let actual = |key: &str| {
            raw[key]
                .as_js_string()
                .filter(|value| !value.is_empty())
                .map_or(Value::Null, |value| json!(value))
        };
        let status = if answers.iter().any(|answer| answer["type"] == "error") {
            "partial"
        } else {
            "complete"
        };
        let result = checked(
            "decisionResultSchema",
            &json!({
                "modelId":self.route["modelId"],"routeId":self.route["routeId"],
                "providerId":self.provider["id"],"requestedModel":self.route["modelName"],
                "actualModel":actual("model"),"actualProvider":actual("provider"),
                "adapter":adapter.name(),"status":status,"answers":answers,
                "usage":json!({
                    "inputTokens":token_count(reported[0])?,
                    "outputTokens":token_count(reported[1])?,
                    "totalTokens":token_count(reported[2])?,
                    "cost":cost,
                }),
            }),
        )
        .map_err(|_| OPERATION.malformed())?;
        if json!({"status":"succeeded","value":result})
            .stringify()
            .len()
            > MAX_BYTES
        {
            return Err(error(
                "invalid-response",
                "The normalized decision response exceeds 4 MiB.",
            ));
        }
        Ok(result)
    }
}

fn invalid(message: &str) -> anyhow::Error {
    error("invalid-request", message)
}

fn unsupported(message: impl Into<String>) -> anyhow::Error {
    error("unsupported-input", message)
}
