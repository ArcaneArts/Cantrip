use super::*;
/// This consumer always supplies an exact native turn and its canonical source.
/// Preserve legacy captured rows and aliases before the telemetry upsert.
pub(super) async fn adopt(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    turn: &Value,
    source: &str,
) -> Result<()> {
    let chat = text(&binding["chatId"])?;
    let thread = text(&turn["threadId"])?;
    let turn_id = text(&turn["turnId"])?;
    let aliases = json!(vec![source]).stringify();
    let rows=all(tx,"SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND chat_id IS NOT DISTINCT FROM $2::text AND (source_key=$3 OR source_aliases @> $4::text::jsonb)",&[&owner,&chat,&source,&aliases]).await?;
    let existing = one(
        tx,
        "SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND source_key=$2",
        &[&owner, &source],
    )
    .await?;
    let same=all(tx,"SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND chat_id=$2 AND turn_id=$3 AND native_model_attribution->>'threadId'=$4",&[&owner,&chat,&turn_id,&thread]).await?;
    anyhow::ensure!(
        same.len() <= 1
            && !same
                .iter()
                .any(|r| existing.as_ref().is_some_and(|e| r["id"] != e["id"])),
        "Multiple retained usage records claim the same native turn."
    );
    let bootstrap = rows.iter().find(|r| {
        r["native_model_attribution"].is_null()
            && (r["turn_id"].is_null() || r["turn_id"] == turn["turnId"])
    });
    let adopted = existing.as_ref().or(same.first()).or(bootstrap);
    if let Some((existing, bootstrap)) = existing
        .as_ref()
        .zip(bootstrap)
        .filter(|(e, b)| e["id"] != b["id"])
    {
        let _ = existing;
        anyhow::ensure!(
            [
                "input_tokens",
                "output_tokens",
                "cached_input_tokens",
                "cache_write_input_tokens",
                "reasoning_output_tokens",
                "reported_total_tokens"
            ]
            .iter()
            .all(|key| bootstrap[*key].is_null() || bootstrap[*key].as_f64() == Some(0.0)),
            "Uncorrelated attempt usage cannot be merged into a native turn."
        );
        tx.query(
            "DELETE FROM token_usage_records WHERE id=$1",
            &[&text(&bootstrap["id"])?],
        )
        .await?;
    }
    let mut aliases = Vec::<Value>::new();
    for row in adopted.into_iter().chain(bootstrap) {
        for alias in row["source_aliases"]
            .as_array()
            .context("Native usage aliases")?
        {
            if !aliases.contains(alias) {
                aliases.push(alias.clone());
            }
        }
    }
    if let Some(row) = adopted
        && row["source_key"] != json!(source)
        && !aliases.contains(&row["source_key"])
    {
        aliases.push(row["source_key"].clone());
    }
    if !aliases.contains(&json!(source)) {
        aliases.push(json!(source));
    }
    aliases.retain(|v| v != &json!(source));
    aliases.sort_by(|a, b| {
        a.as_js_string()
            .unwrap()
            .units()
            .cmp(b.as_js_string().unwrap().units())
    });
    let aliases = json!(aliases).stringify();
    if let Some(row) = adopted {
        anyhow::ensure!(
            row["chat_id"] == binding["chatId"],
            "Native usage key belongs to another chat."
        );
        tx.query("UPDATE token_usage_records SET source_key=$1,source_aliases=$2::text::jsonb WHERE id=$3",&[&source,&aliases,&text(&row["id"])?]).await?;
    }
    // A new canonical row gets an empty alias list from its schema default.
    // With this exact consumer input there is no new noncanonical alias to add.
    Ok(())
}
