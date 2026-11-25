mod history;
mod memory;
mod peers;
mod work;
pub(crate) use peers::peer_target;

use super::{Repository, catalog::compatible_scratch_worker, roots};
use crate::{
    database::Executor,
    wire::{Value, value::json},
};
use anyhow::{Context, Result, ensure};

#[derive(Debug)]
pub enum RosterError {
    NoWorker,
    Duplicate,
    NotFound,
    Conflict,
}
impl std::fmt::Display for RosterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NoWorker => "Council requires an enrolled worker with scratch support.",
            Self::Duplicate => "This Council agent already exists.",
            Self::NotFound => "Council agent not found.",
            Self::Conflict => "The Council agent changed. Reload it and try again.",
        })
    }
}
impl std::error::Error for RosterError {}

async fn roster(executor: Executor<'_, '_>, owner: &str, id: Option<&str>) -> Result<Vec<Value>> {
    executor
        .query(
            "SELECT jsonb_build_object(
                 'id', a.chat_id, 'workerId', c.active_worker_id, 'titleProtection', c.protected_label,
                 'protectedRole', a.protected_role, 'primary', a.is_primary, 'revision', a.revision,
                 'scratchStatus', r.status
             )::text
             FROM council_agents a
             JOIN chats c ON c.id=a.chat_id AND c.owner_id=a.owner_id AND c.context_kind='council'
             JOIN standalone_chat_roots r ON r.id=c.active_scratch_root_id
             WHERE a.owner_id=$1 AND ($2::text IS NULL OR a.chat_id=$2)
             ORDER BY c.position,c.id",
            &[&owner, &id],
        )
        .await?
        .iter()
        .map(super::catalog::raw)
        .collect()
}

impl Repository {
    pub async fn council_agents(&self, owner: &str) -> Result<Vec<Value>> {
        roster(Executor::Database(&self.database), owner, None).await
    }

    pub async fn council_conversation(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let rows = self
            .database
            .query(
                "SELECT to_jsonb(c)::text, recovery.state::text
                 FROM chats c LEFT JOIN LATERAL (
                   SELECT CASE WHEN r.phase='cancelled' THEN NULL ELSE jsonb_build_object(
                       'phase',r.phase,
                       'from',CASE WHEN source_route.id<>target_route.id AND source_provider.id=target_provider.id
                           AND source_account.id IS NOT DISTINCT FROM target_account.id THEN source_provider.name || ' (' || source_route.model_name || ')'
                           ELSE COALESCE(source_provider.name,'Previous provider') END,
                       'to',CASE WHEN source_route.id<>target_route.id AND source_provider.id=target_provider.id
                           AND source_account.id IS NOT DISTINCT FROM target_account.id THEN target_provider.name || ' (' || target_route.model_name || ')'
                           ELSE target_provider.name END,
                       'fromAccount',CASE WHEN source_account.id IS NOT NULL THEN
                         jsonb_build_object('id',source_account.id,'protectedLabel',source_account.protected_label) END,
                       'toAccount',CASE WHEN target_account.id IS NOT NULL THEN
                         jsonb_build_object('id',target_account.id,'protectedLabel',target_account.protected_label) END
                   ) END AS state
                   FROM (
                     SELECT source_operation_id,phase,target_model_route_id,target_provider_account_id,updated_at
                     FROM council_provider_recoveries WHERE chat_id=c.id
                     UNION ALL
                     SELECT source_operation_id,CASE phase WHEN 'completed' THEN 'continued'
                       WHEN 'cancelled' THEN 'cancelled' ELSE 'switching' END,
                       target_model_route_id,target_provider_account_id,updated_at
                     FROM council_live_provider_switches
                     WHERE chat_id=c.id AND phase NOT IN ('observed','continued') AND pause_control_id IS NOT NULL
                   ) r
                   JOIN native_commands source ON source.operation_id=r.source_operation_id AND source.owner_id=$2
                   LEFT JOIN model_routes source_route ON source_route.id=source.identity->>'modelRouteId'
                   LEFT JOIN model_providers source_provider ON source_provider.id=source_route.provider_id AND source_provider.owner_id=$2
                   LEFT JOIN model_provider_accounts source_account ON source_account.id=source.identity->>'providerAccountId'
                       AND source_account.provider_id=source_provider.id
                   LEFT JOIN model_routes target_route ON target_route.id=r.target_model_route_id
                   LEFT JOIN model_providers target_provider ON target_provider.id=target_route.provider_id AND target_provider.owner_id=$2
                   LEFT JOIN model_provider_accounts target_account ON target_account.id=r.target_provider_account_id
                       AND target_account.provider_id=target_provider.id
                   ORDER BY r.updated_at DESC LIMIT 1
                 ) recovery ON true
                 WHERE c.id=$1 AND c.owner_id=$2 AND c.context_kind='council' AND c.archived_at IS NULL LIMIT 1",
                &[&chat, &owner],
            )
            .await?;
        rows.first()
            .map(|row| {
                let mut chat = super::summary::wire_summary(&super::catalog::raw(row)?)?;
                chat["providerRecovery"] = row
                    .get::<Option<&str>>(1)?
                    .map(serde_json::from_str)
                    .transpose()?
                    .unwrap_or(Value::Null);
                Ok(chat)
            })
            .transpose()
    }

    pub async fn create_council_agent(
        &self,
        owner: &str,
        input: Value,
        is_connected: impl Fn(&str) -> bool + Send + Sync,
    ) -> Result<Value> {
        let preferences = self
            .database
            .query(
                "SELECT s.default_worker_id, p.worker_id FROM user_settings s
             LEFT JOIN council_placements p ON p.owner_id=s.user_id WHERE s.user_id=$1",
                &[&owner],
            )
            .await?;
        let preference = preferences.first().context("Council account settings")?;
        let bound: Option<&str> = preference.get(1)?;
        let candidate = if bound.is_none() {
            compatible_scratch_worker(
                self.database.clone(),
                owner,
                preference.get(0)?,
                is_connected,
            )
            .await?
        } else {
            None
        };
        let owner = owner.to_owned();
        let id = input["id"].as_str().context("Council agent ID")?.to_owned();
        let label = input["titleProtection"].stringify();
        let role = input["protectedRole"].stringify();
        let root = uuid::Uuid::new_v4().to_string();
        self.database.transaction(move |tx| Box::pin(async move {
            // Lock the account's settings row to serialize initial placement,
            // first-primary designation, and Council roster positions.
            let settings = tx.query("SELECT user_id FROM user_settings WHERE user_id=$1 FOR UPDATE", &[&owner]).await?;
            ensure!(!settings.is_empty(), "Council account settings");
            let existing = tx.query("SELECT worker_id FROM council_placements WHERE owner_id=$1", &[&owner]).await?;
            let primary = existing.is_empty();
            let worker = if let Some(row) = existing.first() {
                row.get::<String>(0)?
            } else {
                let worker = candidate.ok_or(RosterError::NoWorker)?;
                let placement = tx.query(
                    "INSERT INTO council_placements(owner_id,worker_id)
                     SELECT owner_id,id FROM workers WHERE owner_id=$1 AND id=$2 AND unlinked_at IS NULL
                     RETURNING worker_id",
                    &[&owner,&worker],
                ).await?;
                ensure!(!placement.is_empty(), RosterError::NoWorker);
                worker
            };
            let chat = tx.query(
                "INSERT INTO chats(
                     id,owner_id,context_kind,protected_label,experience,position,active_worker_id,
                     active_scratch_root_id,worktree_mode,model_id,reasoning_effort,permission_profile_id
                 ) SELECT $1,s.user_id,'council',$2::text::jsonb,'agent',
                     (SELECT coalesce(max(position)+1,0) FROM chats WHERE owner_id=s.user_id AND context_kind='council'),
                     $3,$4,NULL,coalesce(s.default_council_model_id,s.default_model_id),
                     CASE WHEN s.default_council_model_id IS NULL THEN s.default_reasoning_effort END,
                     s.default_council_permission_profile_id
                 FROM user_settings s WHERE s.user_id=$5
                 ON CONFLICT(id) DO NOTHING RETURNING id",
                &[&id,&label,&worker,&root,&owner],
            ).await?;
            ensure!(!chat.is_empty(), RosterError::Duplicate);
            tx.query(
                "INSERT INTO council_agents(chat_id,owner_id,protected_role,is_primary) VALUES($1,$2,$3::text::jsonb,$4)",
                &[&id,&owner,&role,&primary],
            ).await?;
            roots::provision_new_chat(tx,&owner,&id,&worker,&root,"Initial Council agent scratch root").await?;
            roster(Executor::Transaction(tx),&owner,Some(&id)).await?.pop().context("Created Council agent")
        })).await
    }

    pub async fn update_council_agent(&self, owner: &str, id: &str, input: Value) -> Result<Value> {
        let owner = owner.to_owned();
        let id = id.to_owned();
        self.database.transaction(move |tx| Box::pin(async move {
            let revision = input["expectedRevision"].stringify();
            let role = input.get("protectedRole").map(Value::stringify);
            let primary = input.get("primary").and_then(Value::as_bool);
            let label = input.get("titleProtection").map(Value::stringify);
            let changed = tx.query(
                "UPDATE council_agents SET revision=revision+1,
                     protected_role=coalesce($4::text::jsonb,protected_role),is_primary=coalesce($5,is_primary)
                 WHERE owner_id=$1 AND chat_id=$2 AND revision=$3::text::integer RETURNING chat_id",
                &[&owner,&id,&revision,&role,&primary],
            ).await?;
            if changed.is_empty() {
                let existing = tx.query("SELECT chat_id FROM council_agents WHERE owner_id=$1 AND chat_id=$2", &[&owner,&id]).await?;
                return Err(if existing.is_empty() { RosterError::NotFound } else { RosterError::Conflict }.into());
            }
            if let Some(label) = label {
                tx.query(
                    "UPDATE chats SET protected_label=$3::text::jsonb,updated_at=now() WHERE id=$1 AND owner_id=$2 AND context_kind='council'",
                    &[&id,&owner,&label],
                ).await?;
            }
            roster(Executor::Transaction(tx),&owner,Some(&id)).await?.pop().context("Updated Council agent")
        })).await
    }
}

pub(crate) fn empty_update(input: &Value) -> bool {
    ["primary", "protectedRole", "titleProtection"]
        .iter()
        .all(|key| input.get(key).is_none())
}

pub(crate) fn notification(owner: &str, agent: &Value) -> Value {
    json!({
        "ownerId": owner, "scope": json!({"kind":"current-user"}),
        "resource":"chat", "action":"invalidated", "entityId":agent["id"],
        "revision":Value::Null, "payload":Value::Null,
    })
}

pub(super) fn apply_execution_context(
    context: &mut Value,
    agent: &Value,
    settings: &Value,
) -> Result<()> {
    ensure!(
        agent["protected_role"].is_object(),
        "Council role is unavailable."
    );
    context["councilAgent"] = json!({
        "protectedRole": agent["protected_role"],
        "primary": agent["is_primary"],
    });
    if agent["native_history_epoch"].is_string() {
        context["councilAgent"]["historyEpoch"] = agent["native_history_epoch"].clone();
    }
    if agent["protected_memory"].is_object() {
        context["councilAgent"]["protectedMemory"] = agent["protected_memory"].clone();
    }
    context["defaultPermissionProfileId"] =
        settings["default_council_permission_profile_id"].clone();
    context["permissionProfileId"] = Value::Null;
    // Council always uses its account setting. A retained thread permission
    // snapshot is not an agent-specific override.
    context["nativePermissionPolicy"] = Value::Null;
    context["nativePermissionPolicyConfirmed"] = Value::Bool(false);
    Ok(())
}
