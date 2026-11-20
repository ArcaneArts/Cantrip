use super::Process;
use crate::{computer_use::HostError, metadata::Signal};
use anyhow::{Result, ensure};
use cantrip_wire::{Value, value::json};
use std::future::Future;

const MAX_HOST_CALLS: u64 = 16_384;
const MAX_RESULT: usize = 32 * 1024;

impl Process {
    pub(crate) async fn javascript<F: Future<Output = Result<Value, HostError>>>(
        &mut self,
        operation: Value,
        signal: &Signal,
        mut host: impl FnMut(Value, Signal) -> F,
    ) -> Result<Value> {
        let request = self.begin(operation).await?;
        let mut calls = 0;
        let mut action = None;
        loop {
            // Keep reading while the worker owns an action. A helper can report
            // failure or exit while authorization or native work is still pending.
            let (frame, size) = {
                let next = Self::read_message(&mut self.output, &mut self.event_sequence, false);
                tokio::pin!(next);
                if let Some(action) = action.take() {
                    signal.check()?;
                    tokio::select! {
                        biased;
                        received = &mut next => {
                            let (frame, size) = received?;
                            ensure!(
                                frame["message"]["kind"] == "response"
                                    && frame["message"]["result"]["status"] == "error",
                                "The evaluator advanced before the pending host action settled."
                            );
                            (frame, size)
                        }
                        result = async { host(action, signal.clone()).await } => {
                            signal.check()?;
                            let result = match result {
                                Ok(data) => json!({"status":"ok","data":data}),
                                Err(error) => error.outcome(),
                            };
                            let message = json!({
                                "kind":"hostResult","evaluationRequestId":request,
                                "callId":calls,"result":result
                            });
                            Self::write(&mut self.input, message).await?;
                            next.await?
                        }
                    }
                } else {
                    next.await?
                }
            };
            let message = &frame["message"];
            if message["kind"] == "hostCall" {
                calls += 1;
                ensure!(
                    message.as_object().is_some_and(|fields| fields.len() == 4)
                        && message["evaluationRequestId"].as_u64() == Some(request)
                        && message["callId"].as_u64() == Some(calls)
                        && calls <= MAX_HOST_CALLS
                        && message["action"]["operation"].is_string(),
                    "Invalid computer-use host call correlation."
                );
                action = Some(message["action"].clone());
                continue;
            }
            let (data, _) =
                Self::read_result(&mut self.output, message, size, request, false).await?;
            ensure!(
                data.as_object().is_some_and(|fields| fields.len() == 1)
                    && data.get("value").is_some()
                    && data.stringify().len() <= MAX_RESULT,
                "Invalid computer-use evaluation result."
            );
            return Ok(data["value"].clone());
        }
    }
}
