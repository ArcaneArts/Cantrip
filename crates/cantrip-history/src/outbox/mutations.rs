use super::*;

pub(super) struct Mutation {
    pub header: Value,
    pub payload: Value,
}
impl Outbox {
    fn mutation_context(&self, header: &Value) -> Value {
        let mut context = self.scope();
        context["streamId"] = self.stream_id().clone();
        context["sequence"] = header["sequence"].clone();
        context["recordId"] = header["recordId"].clone();
        context["previousDigest"] = json!(hash(&json!([
            header["previousDigest"].clone(),
            header["legacyCount"].clone(),
            header["legacyDigest"].clone()
        ])));
        context
    }
    pub(super) fn read_mutations(&self, count: usize, digest: &Value) -> Result<Vec<Mutation>> {
        check_identity(
            self.0.service.as_ref(),
            &self.0.manifest["scope"],
            "Native history encryption identity changed during mutation.",
        )?;
        let mut names = names(self.directory())?
            .into_iter()
            .filter(|n| n.ends_with(".mutation.json"))
            .collect::<Vec<_>>();
        names.sort_by_cached_key(|n| n.encode_utf16().collect::<Vec<_>>());
        let mut mutations: Vec<Mutation> = Vec::new();
        for name in names {
            let header = checked(
                "nativeHistoryOutboxMutationHeaderSchema",
                &files::read_json(&self.directory().join(&name))?,
            )?;
            let previous = mutations
                .last()
                .map(|m| m.header["digest"].clone())
                .unwrap_or(Value::Null);
            if name != filename(mutations.len() as u64 + 1, "mutation")
                || sequence(&header) != mutations.len() as u64 + 1
                || header["previousDigest"] != previous
                || header["legacyCount"].as_u64() != Some(count as u64)
                || header["legacyDigest"] != *digest
                || header["digest"] != hash(&unsigned(&header))
            {
                bail!("Native history mutation log has a missing or conflicting record.");
            }
            let body = content::open(
                self.0.service.as_ref(),
                &self.mutation_context(&header),
                &header["envelope"],
                Field::OutboxMutation,
            )?;
            let payload = checked("nativeHistoryOutboxMutationPayloadSchema", &parse(&body)?)?;
            mutations.push(Mutation { header, payload });
        }
        check_identity(
            self.0.service.as_ref(),
            &self.0.manifest["scope"],
            "Native history encryption identity changed during mutation.",
        )?;
        Ok(mutations)
    }
    pub(super) fn append_mutation(&self, ledger: &ledger::Ledger, raw: &Value) -> Result<()> {
        check_identity(
            self.0.service.as_ref(),
            &self.0.manifest["scope"],
            "Native history encryption identity changed during mutation.",
        )?;
        let payload = checked("nativeHistoryOutboxMutationPayloadSchema", raw)?;
        let next = ledger.mutations.len() as u64 + 1;
        checked("nativeHistoryOutboxSequenceSchema", &json!(next))?;
        let mut header = json!({"version":1,"sequence":next,"recordId":Uuid::new_v4().to_string(),"previousDigest":ledger.mutations.last().map(|m|m.header["digest"].clone()).unwrap_or(Value::Null),"legacyCount":ledger.legacy_count,"legacyDigest":ledger.legacy_digest});
        header["envelope"] = content::protect(
            self.0.service.as_ref(),
            &self.mutation_context(&header),
            &payload.stringify().into(),
            Field::OutboxMutation,
        )?;
        header["digest"] = json!(hash(&header));
        let header = checked("nativeHistoryOutboxMutationHeaderSchema", &header)?;
        check_identity(
            self.0.service.as_ref(),
            &self.0.manifest["scope"],
            "Native history encryption identity changed during mutation.",
        )?;
        if !files::write_immutable(
            &self.directory().join(filename(next, "mutation")),
            &header.stringify(),
        )? {
            bail!("Native history journal advanced concurrently; retry the same record.");
        }
        Ok(())
    }
}
