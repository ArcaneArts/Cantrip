use super::mutations::Mutation;
use super::*;

pub(super) struct Ledger {
    pub records: Vec<Value>,
    pub receipts: Vec<Value>,
    pub mutations: Vec<Mutation>,
    pub legacy_count: usize,
    pub legacy_digest: Value,
    pub identities: HashSet<JsString>,
    pub superseded: HashMap<JsString, Value>,
}
fn sequences(names: &[String], kind: &str) -> Result<Vec<u64>> {
    let suffix = format!(".{kind}.json");
    let mut sequences = Vec::new();
    for name in names.iter().filter(|n| n.ends_with(&suffix)) {
        if name.len() != 16 + suffix.len() || !name.as_bytes()[..16].iter().all(u8::is_ascii_digit)
        {
            bail!("Native history journal has an invalid record filename.");
        }
        let sequence = name[..16].parse::<u64>()?;
        checked("nativeHistoryOutboxSequenceSchema", &json!(sequence))?;
        sequences.push(sequence);
    }
    sequences.sort_unstable();
    Ok(sequences)
}
impl Outbox {
    pub(super) fn read_ledger(&self) -> Result<Ledger> {
        let files = names(self.directory())?;
        let mut records: Vec<Value> = Vec::new();
        let baseline_tail = self
            .0
            .baseline
            .last()
            .map(|v| v["receipt"]["digest"].clone())
            .unwrap_or(Value::Null);
        for next in sequences(&files, "batch")? {
            let record = checked(
                "nativeHistoryOutboxRecordSchema",
                &files::read_json(&self.directory().join(filename(next, "batch")))?,
            )?;
            let previous = records
                .last()
                .map(|r| r["digest"].clone())
                .unwrap_or_else(|| baseline_tail.clone());
            if next != self.0.baseline.len() as u64 + records.len() as u64 + 1
                || sequence(&record) != next
                || record["streamId"] != *self.stream_id()
                || record["digest"] != hash(&unsigned(&record))
                || record["previousDigest"] != previous
            {
                bail!("Native history journal has a missing or conflicting batch.");
            }
            records.push(record);
        }
        let mut identities = self
            .0
            .baseline
            .iter()
            .map(|v| identifier(&v["receipt"]))
            .chain(records.iter().map(identifier))
            .collect::<HashSet<_>>();
        if identities.len() != self.0.baseline.len() + records.len() {
            bail!("Native history journal repeats a record identity.");
        }
        let legacy_count = records.len();
        let legacy_digest = records
            .last()
            .map(|r| r["digest"].clone())
            .unwrap_or_else(|| baseline_tail.clone());
        let mutations = self.read_mutations(legacy_count, &legacy_digest)?;
        let mut superseded = HashMap::new();
        let validate = |record: &Value,
                        next: u64,
                        previous: &Value,
                        identities: &mut HashSet<JsString>|
         -> Result<()> {
            if record["streamId"] != *self.stream_id()
                || sequence(record) != next
                || record["previousDigest"] != *previous
                || record["digest"] != hash(&unsigned(record))
                || identities.contains(&identifier(record))
            {
                bail!(
                    "Native history mutation repeats an identity or conflicts with the active batch chain."
                );
            }
            identities.insert(identifier(record));
            Ok(())
        };
        for mutation in &mutations {
            let payload = &mutation.payload;
            if payload["kind"] == "append" {
                let record = &payload["record"];
                let previous = records
                    .last()
                    .map(|r| r["digest"].clone())
                    .unwrap_or_else(|| baseline_tail.clone());
                validate(
                    record,
                    self.0.baseline.len() as u64 + records.len() as u64 + 1,
                    &previous,
                    &mut identities,
                )?;
                records.push(record.clone());
                continue;
            }
            let offset =
                (sequence(&payload["rejection"]) as usize).checked_sub(self.0.baseline.len() + 1);
            let original = offset.and_then(|i| records.get(i));
            let replacement = payload["records"].as_array().unwrap();
            let Some(original) =
                original.filter(|_| replacement.len() == records.len() - offset.unwrap())
            else {
                bail!("Native history replacement does not cover its original pending tail.");
            };
            self.verify_rejection(&payload["rejection"], original)?;
            let mut previous = original["previousDigest"].clone();
            let next = sequence(original);
            let offset = offset.unwrap();
            for (index, record) in replacement.iter().enumerate() {
                validate(record, next + index as u64, &previous, &mut identities)?;
                let replaced = &records[offset + index];
                if index > 0 && *self.open_body(record)? != *self.open_body(replaced)? {
                    bail!("Native history replacement changed a dependent pending batch.");
                }
                superseded.insert(
                    identifier(replaced),
                    object([
                        ("record", record.clone()),
                        ("rejection", payload["rejection"].clone()),
                    ]),
                );
                previous = record["digest"].clone();
            }
            records.splice(offset..offset + replacement.len(), replacement.clone());
        }
        let mut receipts = Vec::new();
        for next in sequences(&files, "ack")? {
            let receipt = checked(
                "nativeHistoryCommitReceiptSchema",
                &files::read_json(&self.directory().join(filename(next, "ack")))?,
            )?;
            if next != self.0.baseline.len() as u64 + receipts.len() as u64 + 1
                || sequence(&receipt) != next
            {
                bail!("Native history journal has a missing acknowledgment.");
            }
            self.correlate(
                &receipt,
                (next as usize)
                    .checked_sub(self.0.baseline.len() + 1)
                    .and_then(|i| records.get(i)),
            )?;
            receipts.push(receipt);
        }
        Ok(Ledger {
            records,
            receipts,
            mutations,
            legacy_count,
            legacy_digest,
            identities,
            superseded,
        })
    }
}
