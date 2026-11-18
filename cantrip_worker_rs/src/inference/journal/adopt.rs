use super::*;
#[derive(Clone)]
pub struct AdoptOptions {
    pub retained_order: Option<f64>,
    pub task_input_not_dispatched: HashSet<JsString>,
    pub goal_input_not_dispatched: HashSet<JsString>,
    pub task_goal_cycle_not_dispatched: HashSet<JsString>,
    /// The canonical operation owner's cancellation check, never a UI waiter.
    pub assert_current: Arc<dyn Fn() -> Result<()> + Send + Sync>,
}
impl Default for AdoptOptions {
    fn default() -> Self {
        Self {
            retained_order: None,
            task_input_not_dispatched: HashSet::new(),
            goal_input_not_dispatched: HashSet::new(),
            task_goal_cycle_not_dispatched: HashSet::new(),
            assert_current: Arc::new(|| Ok(())),
        }
    }
}
impl AdoptOptions {
    fn reference(&self, record: &Value) -> Value {
        let mut value = reference(record);
        for (key, set) in [
            ("taskInputNotDispatched", &self.task_input_not_dispatched),
            ("goalInputNotDispatched", &self.goal_input_not_dispatched),
            (
                "taskGoalCycleNotDispatched",
                &self.task_goal_cycle_not_dispatched,
            ),
        ] {
            if record["key"]
                .as_js_string()
                .is_some_and(|id| set.contains(id))
            {
                value[key] = json!(true);
            }
        }
        value
    }
}
impl Journal {
    pub fn adopt(
        &self,
        key: String,
        identity: Value,
        previous: Vec<Value>,
        options: AdoptOptions,
    ) -> Work<Value> {
        let completion = self.track();
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let _completion = completion;
            let identity = checked("workerInferenceJournalIdentitySchema", Some(&identity))?;
            let mut ordered = previous.clone();
            ordered.sort_by(|a, b| {
                (b["identity"]["providerId"] == identity["providerId"])
                    .cmp(&(a["identity"]["providerId"] == identity["providerId"]))
                    .then_with(|| {
                        a["order"]
                            .as_f64()
                            .unwrap()
                            .total_cmp(&b["order"].as_f64().unwrap())
                    })
            });
            let base=json!({"action":"adopt","key":key,"identity":identity,"previous":Vec::<Value>::new()}).stringify().len();
            let mut chunks = Vec::new();
            let mut chunk = Vec::new();
            let mut bytes = base;
            for item in ordered {
                let size = options.reference(&item).stringify().len();
                if !chunk.is_empty() && bytes + size + 1 > 60_000 {
                    chunks.push(std::mem::take(&mut chunk));
                    bytes = base;
                }
                bytes += size + usize::from(!chunk.is_empty());
                chunk.push(item);
            }
            if !chunk.is_empty() {
                chunks.push(chunk);
            }
            let mut orders = previous
                .iter()
                .filter(|v| v["identity"]["providerId"] == identity["providerId"])
                .map(|v| v["order"].as_f64().unwrap())
                .collect::<Vec<_>>();
            if let Some(order) = options.retained_order {
                orders.push(order);
            }
            let expected = orders.into_iter().reduce(|a, b| {
                if a.is_nan() || b.is_nan() {
                    f64::NAN
                } else {
                    a.min(b)
                }
            });
            let mut result = None;
            for chunk in chunks {
                (options.assert_current)()?;
                let references = chunk
                    .iter()
                    .map(|record| options.reference(record))
                    .collect::<Vec<_>>();
                let record=this.write(json!({"action":"adopt","key":key,"identity":identity,"previous":references})).await?;
                if record["state"] != "waiting"
                    || coercion::truthy(record.get("everGranted"))
                    || expected.is_some_and(|order| record["order"].as_f64() != Some(order))
                {
                    bail!("Inference recovery did not retain the expected queue order.");
                }
                let replaced = chunk.iter().map(|item| &item["key"]).collect::<Vec<_>>();
                this.0
                    .recovered
                    .lock()
                    .unwrap()
                    .retain(|item| !replaced.contains(&&item["key"]));
                result = Some(record);
            }
            result.ok_or_else(|| anyhow!("Inference recovery requires a source record."))
        })
    }
}
