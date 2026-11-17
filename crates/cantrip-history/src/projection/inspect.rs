use super::*;
use std::collections::HashSet;

fn sequences(files: &[String], kind: &str) -> Result<Vec<u64>> {
    let suffix = format!(".{kind}.json");
    let mut result = Vec::new();
    for name in files.iter().filter(|n| n.ends_with(&suffix)) {
        if name.len() != 16 + suffix.len() || !name.as_bytes()[..16].iter().all(u8::is_ascii_digit)
        {
            bail!("Invalid projection record filename.");
        }
        let next = name[..16].parse::<u64>()?;
        cantrip_protocol::parse_property(
            "nativeHistoryProjectionStageSchema",
            "sequence",
            &json!(next),
        )
        .map_err(cantrip_protocol::response::response_error)?;
        result.push(next);
    }
    result.sort_unstable();
    Ok(result)
}
impl Projection {
    pub(super) async fn inspect(&self) -> Result<Current> {
        self.check_identity("Native history projection encryption identity changed.")?;
        let files = names(self.0.directory.clone()).await?;
        let stages = sequences(&files, "stage")?;
        let commits = sequences(&files, "commit")?;
        if stages.iter().enumerate().any(|(i, n)| *n != i as u64 + 1)
            || commits.iter().enumerate().any(|(i, n)| *n != i as u64 + 1)
            || commits.len() > stages.len()
            || stages.len() > commits.len() + 1
        {
            bail!("Native history projection has missing or unordered transactions.");
        }
        for file in files.iter().filter(|n| n.ends_with(".rebase.json")) {
            if file.len() != 45
                || file.as_bytes()[16] != b'.'
                || !file.as_bytes()[..16].iter().all(u8::is_ascii_digit)
                || !file.as_bytes()[17..33].iter().all(u8::is_ascii_digit)
                || !stages.contains(&file[..16].parse::<u64>()?)
            {
                bail!("Native history projection has an orphaned rebase plan.");
            }
        }
        let mut current = Current {
            cursor: empty_cursor(),
            state: Value::Null,
            previous: None,
            pending: None,
        };
        for next in stages {
            let stage = read(
                "nativeHistoryProjectionStageSchema",
                self.directory().join(filename(next, "stage")),
            )
            .await?;
            if sequence(&stage) != next
                || stage["previousDigest"]
                    != current
                        .previous
                        .as_ref()
                        .map(|v| v["digest"].clone())
                        .unwrap_or(Value::Null)
            {
                bail!("Native history projection stage chain conflicts.");
            }
            let mut payload = self.open_stage(&stage).await?;
            if hash(&payload["from"]) != hash(&current.cursor)
                || sequence(&payload["through"]) <= sequence(&current.cursor)
            {
                bail!("Native history projection skipped or regressed its source cursor.");
            }
            let rebases = self.read_rebases(&stage).await?;
            let mut identities = payload["batches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b["recordId"].as_js_string().unwrap().clone())
                .collect::<HashSet<_>>();
            for (index, plan) in rebases.iter().enumerate() {
                let proof = &plan.payload["rejection"];
                let accepted = plan.payload["acceptedReceipts"].as_array().unwrap();
                let batches = payload["batches"].as_array().unwrap();
                let failed = batches.get(accepted.len());
                if failed.is_none_or(|b| {
                    proof["recordId"] != b["recordId"]
                        || ["workerId", "chatId", "bindingId", "streamId"]
                            .iter()
                            .any(|k| proof[k] != self.0.manifest[k])
                        || proof["payloadDigest"]
                            != baseline::payload_digest(&b["batch"], &proof["previousDigest"])
                }) {
                    bail!("Native history rebase rejection does not match its pending stage.");
                }
                for (offset, receipt) in accepted.iter().enumerate() {
                    let batch = &batches[offset];
                    let body: JsString = batch["batch"].stringify().into();
                    let actual = self
                        .0
                        .options
                        .outbox
                        .committed_receipt(batch["recordId"].as_js_string().unwrap(), Some(&body))
                        .await?;
                    if actual.is_null() || hash(&actual) != hash(receipt) {
                        bail!("Native history rebase lacks its accepted prefix acknowledgment.");
                    }
                }
                let replacement = checked(
                    "nativeHistoryProjectionPayloadSchema",
                    &plan.payload["replacement"],
                )?;
                if hash(&replacement["from"]) != hash(&payload["from"])
                    || hash(&replacement["through"]) != hash(&payload["through"])
                {
                    bail!("Native history rebase changed its original source range.");
                }
                for batch in replacement["batches"].as_array().unwrap() {
                    if !identities.insert(batch["recordId"].as_js_string().unwrap().clone()) {
                        bail!("Native history rebase reused a stage batch identity.");
                    }
                }
                let successor = self
                    .0
                    .options
                    .outbox
                    .replacement(proof["recordId"].as_js_string().unwrap())
                    .await?;
                let first = &replacement["batches"].as_array().unwrap()[0];
                let body: JsString = first["batch"].stringify().into();
                if !successor.is_null()
                    && (hash(&successor["rejection"]) != hash(proof)
                        || successor["record"]["recordId"] != first["recordId"]
                        || JsString::from(
                            self.0
                                .options
                                .outbox
                                .open_body(&successor["record"])?
                                .as_str(),
                        ) != body)
                {
                    bail!("Native history rebase does not match its durable outbox replacement.");
                }
                if successor.is_null()
                    && index < rebases.len() - 1
                    && self
                        .0
                        .options
                        .outbox
                        .committed_receipt(first["recordId"].as_js_string().unwrap(), Some(&body))
                        .await?
                        .is_null()
                {
                    bail!("Native history rebase chain lost its previous outbox replacement.");
                }
                payload = replacement;
            }
            if next <= commits.len() as u64 {
                let commit = read(
                    "nativeHistoryProjectionCommitSchema",
                    self.directory().join(filename(next, "commit")),
                )
                .await?;
                let batches = payload["batches"].as_array().unwrap();
                let receipts = commit["receipts"].as_array().unwrap();
                if sequence(&commit) != next
                    || commit["digest"] != stage["digest"]
                    || commit.get("rebaseDigest") != rebases.last().map(|r| &r.header["digest"])
                    || receipts.len() != batches.len()
                {
                    bail!("Native history projection commit does not match its stage.");
                }
                for (index, batch) in batches.iter().enumerate() {
                    let body: JsString = batch["batch"].stringify().into();
                    let actual = self
                        .0
                        .options
                        .outbox
                        .committed_receipt(batch["recordId"].as_js_string().unwrap(), Some(&body))
                        .await?;
                    if actual.is_null() || hash(&actual) != hash(&receipts[index]) {
                        bail!("Native history projection lacks its canonical acknowledgment.");
                    }
                }
                current.cursor = payload["through"].clone();
                current.state = payload["state"].clone();
            } else {
                current.pending = Some(Pending {
                    stage: stage.clone(),
                    payload,
                    rebases,
                });
            }
            current.previous = Some(stage);
        }
        self.assert_cursor(&current.cursor).await?;
        if let Some(pending) = &current.pending {
            self.assert_cursor(&pending.payload["through"]).await?;
        }
        Ok(current)
    }
}
