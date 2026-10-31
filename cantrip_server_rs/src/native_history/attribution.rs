use super::*;
use crate::wire::value::json;
pub(super) async fn persist(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    turns: &[Value],
) -> Result<()> {
    let id = text(&binding["id"])?;
    let chat = text(&binding["chatId"])?;
    let thread = text(&binding["threadId"])?;
    let mut visited = Vec::new();
    for turn in turns {
        if visited.contains(turn) {
            continue;
        }
        visited.push(turn.clone());
        let turn_id = text(turn)?;
        let row=one(tx,"SELECT to_jsonb(t)::text FROM native_history_turns t WHERE binding_id=$1 AND turn_id=$2",&[&id,&turn_id]).await?;
        let capture = row.as_ref().and_then(|r| {
            crate::wire::parse(
                "nativeTurnModelAttributionSchema",
                r.get("captured_model_attribution"),
            )
            .ok()
        });
        let Some(capture) =
            capture.filter(|c| c["threadId"] == binding["threadId"] && c["turnId"] == *turn)
        else {
            continue;
        };
        let selected = &capture["selection"];
        let mut labels = Value::Null;
        if selected["status"] == "resolved"
            && selected["workerId"] == binding["workerId"]
            && selected["providerAccountId"] == binding["providerAccountId"]
        {
            let ids = vec![
                text(&selected["routeId"])?,
                optional(&binding["modelRouteId"])?.unwrap_or_default(),
            ];
            let routes=all(tx,"SELECT jsonb_build_object('modelId',r.model_id,'modelRouteId',r.id,'providerId',p.id,'providerName',p.name,'providerModelName',r.model_name)::text FROM model_routes r INNER JOIN model_providers p ON p.id=r.provider_id INNER JOIN model_profiles m ON m.id=r.model_id WHERE p.owner_id=$1 AND m.owner_id=$1 AND r.id=ANY($2::text[])",&[&owner,&ids]).await?;
            if let Some(route) = routes.iter().find(|r| {
                r["modelRouteId"] == selected["routeId"]
                    && r["modelId"] == selected["modelId"]
                    && r["providerId"] == selected["providerId"]
            }) && routes.iter().any(|r| {
                r["modelRouteId"] == binding["modelRouteId"]
                    && r["providerId"] == selected["providerId"]
            }) {
                labels = route.clone();
            }
        }
        let mut data = json!({"native_model_attribution":capture,"applied_reasoning_effort":capture["reasoningEffort"]});
        for (field, key) in [
            ("model_id", "modelId"),
            ("model_route_id", "modelRouteId"),
            ("provider_id", "providerId"),
            ("provider_name", "providerName"),
            ("provider_model_name", "providerModelName"),
        ] {
            data[field] = labels[key].clone();
        }
        tx.query("UPDATE chat_messages m SET model_id=incoming.model_id,model_route_id=incoming.model_route_id,provider_id=incoming.provider_id,provider_name=incoming.provider_name,provider_model_name=incoming.provider_model_name,native_model_attribution=incoming.native_model_attribution,applied_reasoning_effort=incoming.applied_reasoning_effort,reasoning_adjusted=(m.reasoning_effort IS NOT NULL AND m.reasoning_effort IS DISTINCT FROM incoming.applied_reasoning_effort) FROM jsonb_populate_record(NULL::chat_messages,$1::jsonb) incoming WHERE m.chat_id=$2 AND m.native_model_attribution IS NULL AND m.id IN(SELECT message_id FROM native_history_items WHERE chat_id=$2 AND thread_id=$3 AND turn_id=$4 AND revision>0)",&[&postgres_types::Json(data),&chat,&thread,&turn_id]).await?;
    }
    Ok(())
}
