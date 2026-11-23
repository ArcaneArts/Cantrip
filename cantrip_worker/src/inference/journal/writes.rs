use super::*;
impl Journal {
    pub(super) fn write(&self, command: Value) -> Work<Value> {
        let bytes = command.stringify().len();
        let (send, receive) = oneshot::channel();
        if bytes > 60_000 {
            let _ = send.send(Err(anyhow!(
                "Inference admission metadata exceeds its frame limit."
            )));
        } else {
            let start = {
                let mut queue = self.0.queue.lock().unwrap();
                queue.writes += 1;
                queue.items.push_back(Item {
                    command,
                    bytes,
                    send,
                });
                let start = !queue.scheduled;
                queue.scheduled = true;
                start
            };
            if start {
                let this = self.clone();
                tokio::spawn(async move {
                    tokio::task::yield_now().await;
                    this.send_writes();
                });
            }
        }
        cantrip_transport::lifecycle::owned(async move {
            receive
                .await
                .map_err(|_| anyhow!("Inference journal response was lost."))?
        })
    }
    fn send_writes(&self) {
        loop {
            let batches = {
                let mut queue = self.0.queue.lock().unwrap();
                if queue.items.is_empty() {
                    queue.scheduled = false;
                    return;
                }
                let mut batches = Vec::new();
                while !queue.items.is_empty() {
                    let mut bytes = 0;
                    let mut batch = Vec::new();
                    while let Some(next) = queue.items.front() {
                        if batch.len() >= 32 || !batch.is_empty() && bytes + next.bytes > 60_000 {
                            break;
                        }
                        let item = queue.items.pop_front().unwrap();
                        bytes += item.bytes + 1;
                        batch.push(item);
                    }
                    batches.push(batch);
                }
                batches
            };
            for batch in batches {
                let commands = batch.iter().map(|v| v.command.clone()).collect::<Vec<_>>();
                let pending = (self.0.request)(json!({"action":"batch","commands":commands}));
                let this = self.clone();
                tokio::spawn(async move {
                    match pending.await {
                        Ok(Some(result))
                            if result.as_array().is_some_and(|v| v.len() == batch.len()) =>
                        {
                            for (item, response) in
                                batch.into_iter().zip(result.as_array().unwrap())
                            {
                                let result = this.acknowledgement(&item.command, response);
                                let _ = item.send.send(result);
                                this.finished();
                            }
                        }
                        result => {
                            let message = result.err().map_or_else(
                                || {
                                    JsString::from(
                                        "Inference journal returned an uncorrelated batch.",
                                    )
                                },
                                |e| crate::error::message(&e),
                            );
                            for item in batch {
                                let _ = item
                                    .send
                                    .send(Err(crate::error::WireError(message.clone()).into()));
                                this.finished();
                            }
                        }
                    }
                });
            }
        }
    }
    fn acknowledgement(&self, command: &Value, response: &Value) -> Result<Value> {
        if response["ok"] != true {
            bail!("Inference journal operation failed.");
        }
        let record = checked("workerInferenceJournalRecordSchema", response.get("result"))?;
        if record["key"] != command["key"]
            || record["workerGeneration"] != Value::String(self.0.generation.clone())
        {
            bail!("Inference journal returned another operation's acknowledgement.");
        }
        let bad = match command["action"].as_str() {
            Some("sealUnstarted") => {
                record["state"] != "released"
                    || coercion::truthy(record.get("everGranted"))
                    || coercion::truthy(record.get("nativeExecution"))
                    || record["outcome"] != "never-started"
            }
            Some("grant") => {
                record["state"] != "granted" || !coercion::truthy(record.get("everGranted"))
            }
            Some("requeue") => record["state"] != "waiting",
            Some("bindNative") => {
                record["state"] != "granted"
                    || !coercion::truthy(record.get("everGranted"))
                    || record["nativeExecution"].stringify() != command["execution"].stringify()
            }
            Some("release") => record["state"] != "released",
            _ => false,
        };
        if bad {
            bail!("Inference journal did not acknowledge the requested transition.");
        }
        if matches!(
            command["action"].as_str(),
            Some("enqueue" | "adopt" | "sealUnstarted")
        ) {
            let (actual, expected) = (&record["identity"], &command["identity"]);
            if [
                "operationId",
                "providerId",
                "runtimeGeneration",
                "recoveryKey",
                "chatId",
                "projectId",
            ]
            .iter()
            .any(|field| actual[*field] != expected[*field])
                || identity::recovery(&actual["recovery"])
                    != identity::recovery(&expected["recovery"])
            {
                bail!("Inference journal changed the queued operation identity.");
            }
        }
        Ok(record)
    }
}
