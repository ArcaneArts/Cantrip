use super::*;
type PageContract = (
    &'static str,
    &'static str,
    &'static str,
    fn(&Value, &Value) -> bool,
);
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().unwrap()
}
fn string(value: &Value) -> &JsString {
    value.as_js_string().unwrap()
}
fn binding_matches(page: &Value, request: &Value, length: usize) -> bool {
    page["binding"]["id"] == request["bindingId"]
        && ["chatId", "workerId"]
            .iter()
            .all(|key| page["binding"][key] == request[key])
        && length as u64 <= request["limit"].as_u64().unwrap()
        && request
            .get("snapshotId")
            .is_none_or(|id| page["snapshotId"] == *id)
        && (request["cursor"].is_null() || page["snapshotId"] == request["cursor"]["snapshotId"])
}
fn validate_items(page: &Value, request: &Value) -> bool {
    let items = array(page, "items");
    binding_matches(page, request, items.len())
        && items.iter().enumerate().all(|(index, item)| {
            let previous = index
                .checked_sub(1)
                .map(|n| &items[n]["key"])
                .or_else(|| request["cursor"].get("key"));
            item["identity"]["threadId"] == page["binding"]["threadId"]
                && array(item, "attachments")
                    .iter()
                    .all(|v| v["chatId"] == request["chatId"])
                && previous
                    .is_none_or(|previous| string(&item["key"]).units() > string(previous).units())
        })
        && (page["nextCursor"].is_null()
            || (page["nextCursor"]["snapshotId"] == page["snapshotId"]
                && items
                    .last()
                    .is_some_and(|last| page["nextCursor"]["key"] == last["key"])))
}
fn validate_turns(page: &Value, request: &Value) -> bool {
    let turns = array(page, "turns");
    binding_matches(page, request, turns.len())
        && turns.iter().enumerate().all(|(index, entry)| {
            let previous = index.checked_sub(1).map(|n| &turns[n]);
            let before = previous
                .map(|v| &v["bindingId"])
                .or_else(|| request["cursor"].get("bindingId"));
            let before_turn = previous
                .map(|v| &v["turn"]["turnId"])
                .or_else(|| request["cursor"].get("turnId"));
            let ordered = before.is_none_or(|before| {
                // PostgreSQL C collation uses UTF-8 bytes with replacement for
                // lone surrogates, rather than ECMAScript UTF-16 ordering.
                let order = string(&entry["bindingId"])
                    .lossy()
                    .as_bytes()
                    .cmp(string(before).lossy().as_bytes());
                order.is_gt()
                    || (order.is_eq()
                        && string(&entry["turn"]["turnId"]).lossy().as_bytes()
                            > string(before_turn.unwrap()).lossy().as_bytes())
            });
            entry["turn"]["threadId"] == page["binding"]["threadId"] && ordered
        })
        && (page["nextCursor"].is_null()
            || (page["nextCursor"]["snapshotId"] == page["snapshotId"]
                && turns.last().is_some_and(|last| {
                    page["nextCursor"]["bindingId"] == last["bindingId"]
                        && page["nextCursor"]["turnId"] == last["turn"]["turnId"]
                })))
}
fn validate_batches(page: &Value, request: &Value) -> bool {
    let batches = array(page, "batches");
    binding_matches(page, request, batches.len())
        && batches.iter().enumerate().all(|(index, entry)| {
            let previous = index
                .checked_sub(1)
                .map(|n| &batches[n]["receipt"])
                .or_else(|| {
                    if request["cursor"].is_null() {
                        None
                    } else {
                        Some(&request["cursor"])
                    }
                });
            let receipt = &entry["receipt"];
            let expected = previous
                .filter(|v| v["streamId"] == receipt["streamId"])
                .map_or(1, |v| v["sequence"].as_u64().unwrap() + 1);
            previous.is_none_or(|v| {
                string(&receipt["streamId"]).units() >= string(&v["streamId"]).units()
            }) && receipt["sequence"].as_u64() == Some(expected)
        })
        && (page["nextCursor"].is_null()
            || (page["nextCursor"]["snapshotId"] == page["snapshotId"]
                && batches.last().is_some_and(|last| {
                    page["nextCursor"]["streamId"] == last["receipt"]["streamId"]
                        && page["nextCursor"]["sequence"] == last["receipt"]["sequence"]
                })))
}
impl Client {
    fn page(
        &self,
        action: &'static str,
        input: &Value,
        signal: Option<Signal>,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, input) = (self.clone(), input.clone());
        owned(async move {
            let (input_schema, output_schema, error, validate): PageContract = match action {
                "archive" => (
                    "nativeHistoryArchiveReadSchema",
                    "nativeHistoryArchivePageSchema",
                    "Native history returned an unrelated or inconsistent archive page.",
                    validate_items,
                ),
                "archive-turns" => (
                    "nativeHistoryTurnArchiveReadSchema",
                    "nativeHistoryTurnArchivePageSchema",
                    "Native history returned an unrelated or inconsistent turn archive page.",
                    validate_turns,
                ),
                "archive-batches" => (
                    "nativeHistoryBatchArchiveReadSchema",
                    "nativeHistoryBatchArchivePageSchema",
                    "Native history returned an unrelated or inconsistent batch archive page.",
                    validate_batches,
                ),
                _ => unreachable!(),
            };
            let request = request(input_schema, &input, &this.options.worker_id)?;
            let page = this
                .post(action, &request, output_schema, &Guard::request(signal))
                .await?;
            let page = if action == "archive-batches" {
                cantrip_history::archive::validate_batches(&page)?
            } else {
                page
            };
            if !validate(&page, &request) {
                bail!("{error}");
            }
            Ok(page)
        })
    }
    pub fn archive(
        &self,
        input: &Value,
        signal: Option<Signal>,
    ) -> BoxFuture<'static, Result<Value>> {
        self.page("archive", input, signal)
    }
    pub fn archive_turns(
        &self,
        input: &Value,
        signal: Option<Signal>,
    ) -> BoxFuture<'static, Result<Value>> {
        self.page("archive-turns", input, signal)
    }
    pub fn archive_batches(
        &self,
        input: &Value,
        signal: Option<Signal>,
    ) -> BoxFuture<'static, Result<Value>> {
        self.page("archive-batches", input, signal)
    }
}
