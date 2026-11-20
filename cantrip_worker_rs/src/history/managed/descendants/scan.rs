use super::*;
use anyhow::bail;
pub(super) fn children(frame: &Value) -> Vec<JsString> {
    let items = if frame["kind"] == "snapshot" {
        frame["snapshot"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap().iter())
            .collect::<Vec<_>>()
    } else {
        vec![&frame["params"]["item"]]
    };
    let mut children = Vec::new();
    for child in items
        .into_iter()
        .flat_map(crate::history::lineage::item_children)
    {
        if !children.contains(child) {
            children.push(child.clone());
        }
    }
    children
}
impl Descendants {
    pub(super) async fn scan(&self, job: &Job) -> Result<()> {
        self.0.signal.check()?;
        let head = job.source.head().await?["sequence"].as_u64().unwrap();
        loop {
            let sequence = job.state.lock().unwrap().sequence;
            if sequence >= head {
                return Ok(());
            }
            self.0.signal.check()?;
            let records = job.source.read(sequence, 512.min(head - sequence)).await?;
            if records.is_empty() {
                bail!("Native child discovery source has a gap.");
            }
            for record in records {
                self.0.signal.check()?;
                let sequence = record["sequence"].as_u64().unwrap();
                if sequence != job.state.lock().unwrap().sequence + 1 {
                    bail!("Native child discovery source is out of order.");
                }
                for child in children(&record["frame"]) {
                    if child == job.scope.thread_id {
                        continue;
                    }
                    if let Err(error) = self
                        .resolve(
                            Input {
                                chat_id: job.scope.chat_id.clone(),
                                thread_id: job.scope.thread_id.clone(),
                                runtime: job.runtime.clone(),
                                provenance: Some(obj([
                                    ("kind", s("binding")),
                                    ("bindingId", s(job.scope.binding_id.clone())),
                                ])),
                            },
                            child,
                        )
                        .await
                    {
                        if !error
                            .chain()
                            .any(|cause| cause.is::<super::resolve::Unrelated>())
                        {
                            return Err(error);
                        }
                        self.report(error, &job.scope);
                    }
                }
                job.state.lock().unwrap().sequence = sequence;
            }
        }
    }
}
