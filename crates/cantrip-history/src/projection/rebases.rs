use super::*;

fn rebase_name(stage: u64, attempt: u64) -> String {
    format!("{stage:016}.{attempt:016}.rebase.json")
}
impl Projection {
    fn rebase_active(&self) -> Result<()> {
        self.check()?;
        self.check_identity("Native history encryption identity changed during rebase.")
    }
    fn rebase_context(&self, stage: &Value, header: &Value) -> Value {
        let mut context = self.context(stage);
        context["sequence"] = header["sequence"].clone();
        context["recordId"] = header["recordId"].clone();
        context["previousDigest"] = json!(hash(&json!([
            stage["digest"].clone(),
            header["previousDigest"].clone()
        ])));
        context
    }
    pub(super) async fn read_rebases(&self, stage: &Value) -> Result<Vec<Rebase>> {
        self.rebase_active()?;
        let prefix = format!("{:016}.", sequence(stage));
        let mut files = names(self.0.directory.clone())
            .await?
            .into_iter()
            .filter(|n| n.starts_with(&prefix) && n.ends_with(".rebase.json"))
            .collect::<Vec<_>>();
        files.sort_by_cached_key(|s| s.encode_utf16().collect::<Vec<_>>());
        let mut result: Vec<Rebase> = Vec::new();
        for file in files {
            self.rebase_active()?;
            let header = read(
                "nativeHistoryProjectionRebaseHeaderSchema",
                self.directory().join(&file),
            )
            .await?;
            if file != rebase_name(sequence(stage), result.len() as u64 + 1)
                || sequence(&header) != result.len() as u64 + 1
                || header["stageDigest"] != stage["digest"]
                || header["previousDigest"]
                    != result
                        .last()
                        .map(|v| v.header["digest"].clone())
                        .unwrap_or(Value::Null)
                || header["digest"] != hash(&unsigned(&header))
            {
                bail!("Native history projection rebase chain is missing or conflicting.");
            }
            let context = self.rebase_context(stage, &header);
            let envelope = header["envelope"].clone();
            let service = self.0.options.service.clone();
            let payload = blocking(move || {
                let body = content::open(
                    service.as_ref(),
                    &context,
                    &envelope,
                    Field::ProjectionRebase,
                )?;
                checked("nativeHistoryProjectionRebasePayloadSchema", &parse(&body)?)
            })
            .await?;
            result.push(Rebase { header, payload });
        }
        self.rebase_active()?;
        Ok(result)
    }
    async fn append_rebase(&self, stage: &Value, previous: &[Rebase], raw: &Value) -> Result<()> {
        self.rebase_active()?;
        let payload = checked("nativeHistoryProjectionRebasePayloadSchema", raw)?;
        let header = json!({"version":1,"sequence":previous.len()+1,"recordId":Uuid::new_v4().to_string(),"previousDigest":previous.last().map(|v|v.header["digest"].clone()).unwrap_or(Value::Null),"stageDigest":stage["digest"]});
        let context = self.rebase_context(stage, &header);
        let service = self.0.options.service.clone();
        let saved = blocking(move || {
            let mut saved = header;
            saved["envelope"] = content::protect(
                service.as_ref(),
                &context,
                &payload.stringify().into(),
                Field::ProjectionRebase,
            )?;
            saved["digest"] = json!(hash(&saved));
            checked("nativeHistoryProjectionRebaseHeaderSchema", &saved)
        })
        .await?;
        self.rebase_active()?;
        if !write(
            self.directory()
                .join(rebase_name(sequence(stage), sequence(&saved))),
            saved.stringify(),
        )
        .await?
        {
            bail!("Native history projection rebased concurrently; recover its saved plan.");
        }
        Ok(())
    }
    pub(super) async fn resume_rebase(&self, pending: &Pending) -> Result<()> {
        let Some(plan) = pending.rebases.last() else {
            return Ok(());
        };
        let first = &pending.payload["batches"].as_array().unwrap()[0];
        let body: JsString = first["batch"].stringify().into();
        let id = first["recordId"].as_js_string().unwrap();
        if !self
            .0
            .options
            .outbox
            .committed_receipt(id, Some(&body))
            .await?
            .is_null()
        {
            return Ok(());
        }
        self.0
            .options
            .outbox
            .replace_rejected(&plan.payload["rejection"], id, &body)
            .await?;
        Ok(())
    }
    pub(super) async fn stage_rebase(
        &self,
        pending: &Pending,
        rejection: &Value,
        receipts: Vec<Value>,
    ) -> Result<()> {
        let batches = pending.payload["batches"].as_array().unwrap();
        if batches
            .get(receipts.len())
            .is_none_or(|v| v["recordId"] != rejection["recordId"])
        {
            bail!("Native history rejection belongs to another pending stage batch.");
        }
        let from = sequence(&pending.payload["from"]);
        let through = sequence(&pending.payload["through"]);
        let records = self.0.options.source.read(from, through - from).await?;
        if records.len() as u64 != through - from
            || records
                .last()
                .is_none_or(|r| r["recordId"] != pending.payload["through"]["recordId"])
        {
            bail!("Native history rebase could not recover its complete original source page.");
        }
        self.check()?;
        let result = (self
            .0
            .options
            .rebase
            .as_ref()
            .expect("rebase selected by drain"))(
            records, pending.payload["state"].clone()
        )
        .await?;
        self.check()?;
        let replacement = Self::payload(
            &pending.payload["from"],
            &pending.payload["through"],
            result,
        )?;
        self.append_rebase(
            &pending.stage,
            &pending.rebases,
            &object([
                ("rejection", rejection.clone()),
                ("acceptedReceipts", Value::Array(receipts)),
                ("replacement", replacement),
            ]),
        )
        .await
    }
}
