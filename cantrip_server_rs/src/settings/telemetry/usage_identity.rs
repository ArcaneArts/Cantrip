//! Exact native-turn identity shared with live/recovery source aliases. Locks
//! cover only the database transition, never inference or worker requests.
use super::{token_usage, write_support::*};
use crate::{
    database::Transaction,
    settings::repository::SettingsRepository,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result, ensure};

fn validate_identity(input: &Value) -> Result<Option<Value>> {
    let capture = input
        .get("nativeModelAttribution")
        .map(|v| crate::settings::parse_response("nativeTurnModelAttributionSchema", Some(v)))
        .transpose()?;
    let identity = capture
        .as_ref()
        .or_else(|| input.get("nativeTurn").filter(|v| !v.is_null()));
    if let Some(identity) = identity.filter(|v| truthy(Some(v))) {
        ensure!(
            identity.get("turnId") == input.get("turnId"),
            "Native usage identity belongs to another turn."
        );
    }
    if let Some((capture, native)) = capture
        .as_ref()
        .zip(input.get("nativeTurn").filter(|v| truthy(Some(v))))
    {
        ensure!(
            native["threadId"] == capture["threadId"] && native["turnId"] == capture["turnId"],
            "Native usage identity conflicts with its model capture."
        );
    }
    if let Some(capture) = &capture {
        ensure!(
            capture.get("turnId") == input.get("turnId"),
            "Native usage attribution belongs to another turn."
        );
    }
    Ok(identity.cloned())
}
impl SettingsRepository {
    pub async fn record_token_usage(&self, owner: &str, input: &Value) -> Result<()> {
        let identity = validate_identity(input)?;
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move { record(tx, &owner, &input, identity.as_ref()).await })
            })
            .await
    }
}
pub(crate) async fn record_in_transaction(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
) -> Result<()> {
    let identity = validate_identity(input)?;
    let (owner, input) = (owner.to_owned(), input.clone());
    crate::chats::execution_lanes::savepoint(tx, |tx| {
        Box::pin(async move { record(tx, &owner, &input, identity.as_ref()).await })
    })
    .await
}
async fn record(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    identity: Option<&Value>,
) -> Result<()> {
    let source = text(&input["sourceKey"])?;
    let chat = input
        .get("chatId")
        .filter(|v| !v.is_null())
        .map(text)
        .transpose()?;
    if truthy(input.get("chatId")) {
        let chat = chat.as_deref().unwrap();
        tx.query("WITH locked_project AS MATERIALIZED (SELECT projects.id FROM projects INNER JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM locked_project INNER JOIN chats ON chats.project_id=locked_project.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
        ensure!(
            !tx.query(
                "SELECT id FROM chats WHERE id=$1 AND owner_id=$2 FOR UPDATE",
                &[&chat, &owner]
            )
            .await?
            .is_empty(),
            "Token usage chat is not owned by this account."
        );
    }
    let aliases = Value::Array(vec![input["sourceKey"].clone()]).stringify();
    let source_rows = rows(tx,"SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND chat_id IS NOT DISTINCT FROM $2::text AND (source_key=$3 OR source_aliases @> $4::text::jsonb)",&[&owner,&chat,&source,&aliases]).await?;
    if !truthy(identity) || !truthy(input.get("chatId")) {
        let matching = source_rows
            .iter()
            .filter(|row| {
                !truthy(input.get("turnId"))
                    || row.get("turn_id") == input.get("turnId")
                    || (row["turn_id"].is_null() && row["native_model_attribution"].is_null())
            })
            .collect::<Vec<_>>();
        ensure!(
            matching.len() <= 1,
            "Usage source alias identifies multiple native turns; specify the exact turn."
        );
        ensure!(
            !matching.is_empty() || source_rows.is_empty(),
            "Usage source alias belongs to another retained turn."
        );
        if matching.is_empty() {
            let elsewhere = one(tx,"SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND source_key=$2",&[&owner,&source]).await?;
            ensure!(
                elsewhere
                    .as_ref()
                    .is_none_or(|v| v.get("chat_id") == input.get("chatId")),
                "Usage source key belongs to another chat."
            );
        }
        let mut resolved = input.clone();
        if let Some(row) = matching.first() {
            resolved["sourceKey"] = row["source_key"].clone();
        }
        return token_usage::persist(tx, owner, &resolved).await;
    }
    let identity = identity.unwrap();
    let canonical = format!(
        "native-turn:{}",
        Value::Array(vec![
            input["chatId"].clone(),
            identity["threadId"].clone(),
            identity["turnId"].clone()
        ])
        .stringify()
    );
    ensure!(
        !source.starts_with("native-turn:") || input["sourceKey"] == json!(canonical),
        "Native usage source key belongs to another turn."
    );
    let existing = one(
        tx,
        "SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND source_key=$2",
        &[&owner, &canonical],
    )
    .await?;
    let same = rows(tx,"SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND chat_id=$2 AND turn_id=$3 AND native_model_attribution->>'threadId'=$4",&[&owner,&chat,&text(&identity["turnId"])?,&text(&identity["threadId"])?]).await?;
    ensure!(
        same.len() <= 1
            && !same
                .iter()
                .any(|r| existing.as_ref().is_some_and(|e| e["id"] != r["id"])),
        "Multiple retained usage records claim the same native turn."
    );
    let bootstrap = source_rows.iter().find(|r| {
        r["native_model_attribution"].is_null()
            && (r["turn_id"].is_null() || r["turn_id"] == identity["turnId"])
    });
    let adopted = existing.as_ref().or(same.first()).or(bootstrap);
    if let Some((existing, bootstrap)) = existing
        .as_ref()
        .zip(bootstrap)
        .filter(|(a, b)| a["id"] != b["id"])
    {
        let _ = existing;
        ensure!(
            [
                "input_tokens",
                "output_tokens",
                "cached_input_tokens",
                "cache_write_input_tokens",
                "reasoning_output_tokens",
                "reported_total_tokens"
            ]
            .iter()
            .all(|key| bootstrap[*key] == json!(0)
                || (*key == "reported_total_tokens" && bootstrap[*key].is_null())),
            "Uncorrelated attempt usage cannot be merged into a native turn."
        );
        tx.query(
            "DELETE FROM token_usage_records WHERE id=$1",
            &[&text(&bootstrap["id"])?],
        )
        .await?;
    }
    let mut aliases: Vec<Value> = Vec::new();
    for row in adopted.into_iter().chain(bootstrap) {
        for value in row["source_aliases"]
            .as_array()
            .context("Token usage aliases")?
        {
            if !aliases.contains(value) {
                aliases.push(value.clone());
            }
        }
    }
    if let Some(row) = adopted
        && row["source_key"] != json!(canonical)
        && !aliases.contains(&row["source_key"])
    {
        aliases.push(row["source_key"].clone());
    }
    if !aliases.contains(&input["sourceKey"]) {
        aliases.push(input["sourceKey"].clone());
    }
    aliases.retain(|v| v != &json!(canonical));
    aliases.sort_by(|a, b| {
        a.as_js_string()
            .unwrap()
            .units()
            .cmp(b.as_js_string().unwrap().units())
    });
    let aliases = Value::Array(aliases).stringify();
    if let Some(adopted) = adopted {
        ensure!(
            adopted.get("chat_id") == input.get("chatId"),
            "Native usage key belongs to another chat."
        );
        tx.query("UPDATE token_usage_records SET source_key=$1,source_aliases=$2::text::jsonb WHERE id=$3",&[&canonical,&aliases,&text(&adopted["id"])?]).await?;
    }
    let mut resolved = input.clone();
    resolved["sourceKey"] = json!(canonical);
    token_usage::persist(tx, owner, &resolved).await?;
    if adopted.is_none() {
        tx.query("UPDATE token_usage_records SET source_aliases=$1::text::jsonb WHERE owner_id=$2 AND source_key=$3",&[&aliases,&owner,&canonical]).await?;
    }
    Ok(())
}
