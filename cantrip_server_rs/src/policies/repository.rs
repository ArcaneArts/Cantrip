use super::{assets, query_error, request::validate};
use crate::{
    auth::{iso, now},
    database::{Database, Row, Transaction},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

const POLICY: &str = "id,key_blind_index,protected_summary,protected_body,enabled,mandatory,audience,position,template_key,row_version,created_at,updated_at";

#[derive(Debug)]
pub struct PolicyConflict {
    pub message: String,
    pub code: &'static str,
}
impl std::fmt::Display for PolicyConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for PolicyConflict {}
#[derive(Debug)]
pub struct PolicyScopeNotFound(pub String);
impl std::fmt::Display for PolicyScopeNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PolicyScopeNotFound {}
fn conflict(message: impl Into<String>, code: &'static str) -> anyhow::Error {
    PolicyConflict {
        message: message.into(),
        code,
    }
    .into()
}
fn scope_error(message: impl Into<String>) -> anyhow::Error {
    PolicyScopeNotFound(message.into()).into()
}
fn unique(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error
            .downcast_ref::<tokio_postgres::Error>()
            .and_then(|error| error.as_db_error())
            .is_some_and(|error| error.code().code() == "23505")
            || {
                let message = error.to_string().to_lowercase();
                message.contains("duplicate key") || message.contains("unique constraint")
            }
    })
}
fn text<'a>(input: &'a Value, name: &str) -> Result<&'a str> {
    input[name].as_str().context("validated policy text")
}
fn integer(input: &Value, name: &str) -> Result<i64> {
    input[name].as_i64().context("validated policy integer")
}
fn ids(input: &crate::wire::Value) -> Result<Vec<crate::wire::JsString>> {
    input["policyIds"]
        .as_array()
        .context("validated policy IDs")?
        .iter()
        .map(|id| Ok(id.as_js_string().context("validated policy ID")?.clone()))
        .collect()
}
fn summary(row: &Row, workspaces: i64, projects: i64, detail: bool) -> Result<Value> {
    let mut value = json!({
        "id":row.get::<String>(0)?,
        "content":{"keyBlindIndex":row.get::<String>(1)?,"protectedSummary":row.get::<Value>(2)?},
        "enabled":row.get::<bool>(4)?,"mandatory":row.get::<bool>(5)?,"audience":row.get::<String>(6)?,
        "position":row.get::<i32>(7)?,"templateKey":row.get::<Option<String>>(8)?,"rowVersion":row.get::<i32>(9)?,
        "workspaceAssignmentCount":workspaces,"projectAssignmentCount":projects,
        "createdAt":iso(row.get::<DateTime<Utc>>(10)?),"updatedAt":iso(row.get::<DateTime<Utc>>(11)?)
    });
    if detail {
        value["content"]["protectedBody"] = row.get(3)?;
    }
    Ok(value)
}
fn output(schema: &str, value: Value) -> Result<Value> {
    let parsed = crate::wire::parse(schema, Some(&crate::wire::Value::from_serialize(&value)))
        .map_err(|_| anyhow::anyhow!("Stored policy record violates its protocol contract."))?;
    Ok(serde_json::from_str(&parsed.stringify())?)
}
async fn insert(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    position: i64,
    at: DateTime<Utc>,
) -> Result<Row> {
    let content = &input["content"];
    let (sql, params) = query_error::insert(owner, input, position, at);
    let rows = query_error::context(tx.query(&format!("INSERT INTO policies(id,owner_id,key_blind_index,protected_summary,protected_body,enabled,mandatory,audience,position,template_key,row_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text::integer,$10,1,$11,$11) RETURNING {POLICY}"),
        &[&text(input,"id")?, &owner, &text(content,"keyBlindIndex")?, &content["protectedSummary"], &content["protectedBody"], &input["enabled"].as_bool().context("policy enabled")?, &input["mandatory"].as_bool().context("policy mandatory")?, &text(input,"audience")?, &position.to_string(), &input["templateKey"].as_str(), &at]).await,&sql,&params)?;
    rows.into_iter().next().context("Policy was not created.")
}
async fn increment(tx: &Transaction<'_>, owner: &str) -> Result<i32> {
    let at = now();
    let (sql, params) = query_error::increment(owner, at);
    query_error::context(tx.query("UPDATE policy_owner_states SET collection_version=collection_version+1,updated_at=$2 WHERE owner_id=$1 RETURNING collection_version", &[&owner,&at]).await,&sql,&params)?.first()
        .ok_or_else(|| scope_error("Policy owner not found."))?.get(0)
}
async fn claim(tx: &Transaction<'_>, owner: &str, version: i64) -> Result<i32> {
    // Let PostgreSQL execute overflow and constraint handling; no inferred gate.
    // Numeric literals use validated i64 values only. PostgreSQL parses them as
    // int4 before filtering rows, as Node's typed parameter binding does.
    let at = now();
    let (sql, params) = query_error::claim(owner, version, at);
    query_error::context(tx.query(&format!("UPDATE policy_owner_states SET collection_version='{}'::integer,updated_at=$2 WHERE owner_id=$1 AND collection_version='{version}'::integer RETURNING collection_version",version+1), &[&owner,&at]).await,&sql,&params)?.first()
        .ok_or_else(|| conflict("The policy collection changed in another session.", "collection-changed"))?.get(0)
}
fn scope_tables(workspace: bool) -> (&'static str, &'static str, &'static str) {
    if workspace {
        (
            "project_workspaces",
            "workspace_policy_assignments",
            "workspace_id",
        )
    } else {
        ("projects", "project_policy_assignments", "project_id")
    }
}

#[derive(Clone)]
pub struct PolicyRepository {
    pub database: Arc<Database>,
}
impl PolicyRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn query(
        &self,
        sql: &str,
        params: crate::database::Parameters<'_>,
        reference: (String, Vec<Value>),
    ) -> Result<Vec<Row>> {
        query_error::context(
            self.database.query(sql, params).await,
            &reference.0,
            &reference.1,
        )
    }
    async fn ensure_owner(&self, owner: &str) -> Result<()> {
        self.query(
            "INSERT INTO policy_owner_states(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
            &[&owner],
            query_error::ensure(owner),
        )
        .await?;
        Ok(())
    }
    pub async fn list(&self, owner: &str) -> Result<Value> {
        self.ensure_owner(owner).await?;
        let sql = format!("SELECT {POLICY} FROM policies WHERE owner_id=$1 ORDER BY position,id");
        let params: crate::database::Parameters<'_> = &[&owner];
        let (state, rows, workspaces, projects) = tokio::try_join!(
            self.query("SELECT bootstrap_version,collection_version FROM policy_owner_states WHERE owner_id=$1 LIMIT 1", params,query_error::select("policy_owner_states","\"bootstrap_version\", \"collection_version\"",&[("owner_id",json!(owner))],"",true)),
            self.query(&sql, params,query_error::select("policies",query_error::COLUMNS,&[("owner_id",json!(owner))]," order by \"policies\".\"position\" ASC, \"policies\".\"id\" ASC",false)),
            self.query("SELECT a.policy_id,count(*) FROM workspace_policy_assignments a INNER JOIN policies p ON p.id=a.policy_id AND p.owner_id=$1 GROUP BY a.policy_id", params,query_error::counts(true,owner)),
            self.query("SELECT a.policy_id,count(*) FROM project_policy_assignments a INNER JOIN policies p ON p.id=a.policy_id AND p.owner_id=$1 GROUP BY a.policy_id", params,query_error::counts(false,owner))
        )?;
        let counts = |rows: Vec<Row>| -> Result<HashMap<String, i64>> {
            rows.iter()
                .map(|row| Ok((row.get(0)?, row.get(1)?)))
                .collect()
        };
        let workspaces = counts(workspaces)?;
        let projects = counts(projects)?;
        let policies = rows
            .iter()
            .map(|row| {
                let id: String = row.get(0)?;
                summary(
                    row,
                    *workspaces.get(&id).unwrap_or(&0),
                    *projects.get(&id).unwrap_or(&0),
                    false,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        output(
            "policyWireListSchema",
            json!({"bootstrapVersion":state.first().map(|r|r.get::<i32>(0)).transpose()?.unwrap_or(0),"collectionVersion":state.first().map(|r|r.get::<i32>(1)).transpose()?.unwrap_or(1),"policies":policies}),
        )
    }
    async fn detail(&self, row: &Row) -> Result<Value> {
        let id: String = row.get(0)?;
        let params: crate::database::Parameters<'_> = &[&id];
        let (workspaces, projects) = tokio::try_join!(
            self.query(
                "SELECT count(*) FROM workspace_policy_assignments WHERE policy_id=$1",
                params,
                query_error::select(
                    "workspace_policy_assignments",
                    "count(*)",
                    &[("policy_id", json!(id))],
                    "",
                    false
                )
            ),
            self.query(
                "SELECT count(*) FROM project_policy_assignments WHERE policy_id=$1",
                params,
                query_error::select(
                    "project_policy_assignments",
                    "count(*)",
                    &[("policy_id", json!(id))],
                    "",
                    false
                )
            )
        )?;
        output(
            "policyWireDetailSchema",
            summary(row, workspaces[0].get(0)?, projects[0].get(0)?, true)?,
        )
    }
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.ensure_owner(owner).await?;
        let rows = self
            .query(
                &format!("SELECT {POLICY} FROM policies WHERE owner_id=$1 AND id=$2 LIMIT 1"),
                &[&owner, &id],
                query_error::select(
                    "policies",
                    query_error::COLUMNS,
                    &[("id", json!(id)), ("owner_id", json!(owner))],
                    "",
                    true,
                ),
            )
            .await?;
        match rows.first() {
            Some(row) => Ok(Some(self.detail(row).await?)),
            None => Ok(None),
        }
    }
    pub async fn bootstrap(&self, owner: &str, input: &Value) -> Result<Value> {
        let input = validate("encryptedPolicyBootstrapSchema", input)?;
        let policies = input["policies"].as_array().context("bootstrap policies")?;
        let mut keys: HashSet<_> = assets()["templates"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["suggestedDefault"] == true)
            .map(|t| t["templateKey"].as_str().unwrap())
            .collect();
        if policies.len() != keys.len()
            || !policies.iter().all(|p| {
                p["templateKey"]
                    .as_str()
                    .is_some_and(|key| keys.remove(key))
            })
            || !keys.is_empty()
        {
            return Err(conflict(
                "Policy bootstrap must contain each packaged default exactly once.",
                "invalid-order",
            ));
        }
        self.ensure_owner(owner).await?;
        let identity = owner.to_owned();
        self.database.transaction(move|tx| Box::pin(async move {
            let expected=integer(&input,"expectedBootstrapVersion")?;
            let version=assets()["bootstrapVersion"].as_i64().unwrap() as i32;
            let at=now(); let (sql,params)=query_error::bootstrap(&identity,expected,version,at);
            let rows=query_error::context(tx.query(&format!("UPDATE policy_owner_states SET bootstrap_version=$2,collection_version=collection_version+1,updated_at=$3 WHERE owner_id=$1 AND bootstrap_version='{expected}'::integer RETURNING owner_id"), &[&identity,&version,&at]).await,&sql,&params)?;
            if !rows.is_empty() {
                let at=now();
                for (position, policy) in input["policies"].as_array().unwrap().iter().enumerate() {
                    insert(tx,&identity,policy,position as i64,at).await?;
                }
            }
            Ok(())
        })).await?;
        self.list(owner).await
    }
    pub async fn create(&self, owner: &str, input: &Value) -> Result<Value> {
        let input = validate("encryptedPolicyCreateSchema", input)?;
        self.ensure_owner(owner).await?;
        let identity = owner.to_owned();
        let result=self.database.transaction(move|tx|Box::pin(async move {
            increment(tx,&identity).await?;
            let count: i64=query_error::transaction(tx,"SELECT count(*) FROM policies WHERE owner_id=$1", &[&identity],query_error::select("policies","count(*)",&[("owner_id",json!(identity))],"",false)).await?[0].get(0)?;
            let limit=assets()["policyLimit"].as_i64().unwrap();
            if count>=limit { return Err(conflict(format!("An owner cannot store more than {limit} policies."),"limit-exceeded")); }
            let rows=query_error::transaction(tx,"SELECT position FROM policies WHERE owner_id=$1 ORDER BY position DESC LIMIT 1", &[&identity],query_error::select("policies","\"position\"",&[("owner_id",json!(identity))]," order by \"policies\".\"position\" DESC",true)).await?;
            let position=rows.first().map(|r|r.get::<i32>(0)).transpose()?.unwrap_or(-1);
            insert(tx,&identity,&input,i64::from(position) + 1,now()).await
        })).await;
        match result {
            Ok(row) => output("policyWireDetailSchema", summary(&row, 0, 0, true)?),
            Err(error) if unique(&error) => Err(conflict(
                "That policy key is already in use.",
                "duplicate-key",
            )),
            Err(error) => Err(error),
        }
    }
    pub async fn update(&self, owner: &str, id: &str, input: &Value) -> Result<Option<Value>> {
        let input = validate("encryptedPolicyUpdateSchema", input)?;
        let version = integer(&input, "rowVersion")?;
        let at = now();
        let (sql, params) = query_error::update(owner, id, &input, version, at);
        let rows=query_error::context(self.database.query(&format!("UPDATE policies SET enabled=COALESCE($3,enabled),mandatory=COALESCE($4,mandatory),audience=COALESCE($5,audience),protected_summary=COALESCE($6,protected_summary),protected_body=COALESCE($7,protected_body),row_version='{}'::integer,updated_at=$8 WHERE owner_id=$1 AND id=$2 AND row_version='{version}'::integer RETURNING {POLICY}",version+1),
            &[&owner,&id,&input["enabled"].as_bool(),&input["mandatory"].as_bool(),&input["audience"].as_str(),&input.get("content").map(|v|v["protectedSummary"].clone()),&input.get("content").map(|v|v["protectedBody"].clone()),&at]).await,&sql,&params)?;
        if let Some(row) = rows.first() {
            return Ok(Some(self.detail(row).await?));
        }
        if self
            .query(
                "SELECT row_version FROM policies WHERE owner_id=$1 AND id=$2 LIMIT 1",
                &[&owner, &id],
                query_error::select(
                    "policies",
                    "\"row_version\"",
                    &[("id", json!(id)), ("owner_id", json!(owner))],
                    "",
                    true,
                ),
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        Err(conflict(
            "The policy changed in another session.",
            "stale-version",
        ))
    }
    pub async fn delete(&self, owner: &str, id: &str, version: i64) -> Result<bool> {
        let owner = owner.to_owned();
        let id = id.to_owned();
        self.database.transaction(move|tx|Box::pin(async move {
            let (sql,params)=query_error::delete(&owner,&id,version);
            let rows=query_error::context(tx.query(&format!("DELETE FROM policies WHERE owner_id=$1 AND id=$2 AND row_version='{version}'::integer RETURNING id"), &[&owner,&id]).await,&sql,&params)?;
            if !rows.is_empty() { increment(tx,&owner).await?; return Ok(true); }
            if query_error::transaction(tx,"SELECT id FROM policies WHERE owner_id=$1 AND id=$2 LIMIT 1", &[&owner,&id],query_error::select("policies","\"id\"",&[("id",json!(id)),("owner_id",json!(owner))],"",true)).await?.is_empty() { return Ok(false); }
            Err(conflict("The policy changed in another session.","stale-version"))
        })).await
    }
    pub async fn reorder(&self, owner: &str, input: &Value) -> Result<Value> {
        self.reorder_wire(owner, &crate::wire::Value::from_serialize(input))
            .await
    }
    pub async fn reorder_wire(&self, owner: &str, input: &crate::wire::Value) -> Result<Value> {
        let input = crate::wire::parse("policyOrderUpdateSchema", Some(input))
            .map_err(|_| anyhow::anyhow!("Invalid policy order."))?;
        let identity = owner.to_owned();
        self.database.transaction(move|tx|Box::pin(async move {
            claim(tx,&identity,input["collectionVersion"].as_i64().context("validated collection version")?).await?;
            let current=query_error::transaction(tx,"SELECT id FROM policies WHERE owner_id=$1", &[&identity],query_error::select("policies","\"id\"",&[("owner_id",json!(identity))],"",false)).await?.iter().map(|r|Ok(crate::wire::JsString::from(r.get::<String>(0)?))).collect::<Result<HashSet<_>>>()?;
            let ids=ids(&input)?;
            if current.len()!=ids.len() || !ids.iter().all(|id|current.contains(id)) {
                return Err(conflict("Policy order must contain every current policy exactly once.","invalid-order"));
            }
            for (position,id) in ids.iter().enumerate() {
                let at=now(); let id=id.lossy().into_owned();let position=position as i32;
                query_error::transaction(tx,"UPDATE policies SET position=$3,updated_at=$4 WHERE owner_id=$1 AND id=$2", &[&identity,&id,&position,&at],query_error::reorder(&identity,&id,position,at)).await?;
            }
            Ok(())
        })).await?;
        self.list(owner).await
    }
    pub async fn replace_assignments(
        &self,
        owner: &str,
        workspace: bool,
        scope_id: &str,
        input: &Value,
    ) -> Result<i32> {
        self.replace_assignments_wire(
            owner,
            workspace,
            scope_id,
            &crate::wire::Value::from_serialize(input),
        )
        .await
    }
    pub async fn replace_assignments_wire(
        &self,
        owner: &str,
        workspace: bool,
        scope_id: &str,
        input: &crate::wire::Value,
    ) -> Result<i32> {
        let input = crate::wire::parse("policyAssignmentUpdateSchema", Some(input))
            .map_err(|_| anyhow::anyhow!("Invalid policy assignments."))?;
        self.ensure_owner(owner).await?;
        let owner = owner.to_owned();
        let scope_id = scope_id.to_owned();
        self.database.transaction(move|tx|Box::pin(async move {
            let version=claim(tx,&owner,input["collectionVersion"].as_i64().context("validated collection version")?).await?;
            let (scopes,assignments,column)=scope_tables(workspace);
            if query_error::transaction(tx,&format!("SELECT id FROM {scopes} WHERE owner_id=$1 AND id=$2 LIMIT 1"), &[&owner,&scope_id],query_error::select(scopes,"\"id\"",&[("id",json!(scope_id)),("owner_id",json!(owner))],"",true)).await?.is_empty() {
                return Err(scope_error(format!("Policy {} not found.",if workspace {"workspace"} else {"project"})));
            }
            let original_ids=ids(&input)?;
            let ids=original_ids.iter().map(|id|id.lossy().into_owned()).collect::<Vec<_>>();
            if !ids.is_empty() && query_error::transaction_wire(tx,"SELECT id FROM policies WHERE owner_id=$1 AND id=ANY($2::text[])", &[&owner,&ids],query_error::owned_ids(&owner,&original_ids)).await?.len()!=ids.len() {
                return Err(scope_error("Policy assignments contained an unavailable policy."));
            }
            query_error::transaction(tx,&format!("DELETE FROM {assignments} WHERE {column}=$1"), &[&scope_id],query_error::delete_assignments(assignments,column,&scope_id)).await?;
            if !ids.is_empty() {
                let (sql,params)=query_error::assignments(workspace,&scope_id,&original_ids);
                query_error::context_wire(tx.query(&format!("INSERT INTO {assignments}(policy_id,{column}) SELECT id,$2 FROM unnest($1::text[]) AS id"), &[&ids,&scope_id]).await,&sql,&params)?;
            }
            Ok(version)
        })).await
    }
    pub async fn list_assignments(
        &self,
        owner: &str,
        workspace: bool,
        scope_id: &str,
    ) -> Result<Option<Value>> {
        self.ensure_owner(owner).await?;
        let (scopes, assignments, column) = scope_tables(workspace);
        if self
            .query(
                &format!("SELECT id FROM {scopes} WHERE owner_id=$1 AND id=$2 LIMIT 1"),
                &[&owner, &scope_id],
                query_error::select(
                    scopes,
                    "\"id\"",
                    &[("id", json!(scope_id)), ("owner_id", json!(owner))],
                    "",
                    true,
                ),
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let sql = format!(
            "SELECT a.policy_id FROM {assignments} a INNER JOIN policies p ON p.id=a.policy_id AND p.owner_id=$1 WHERE a.{column}=$2"
        );
        let params: crate::database::Parameters<'_> = &[&owner, &scope_id];
        let (list, rows) = tokio::try_join!(
            self.list(owner),
            self.query(
                &sql,
                params,
                query_error::assignment_ids(workspace, owner, scope_id)
            )
        )?;
        let assigned = rows
            .iter()
            .map(|r| r.get(0))
            .collect::<Result<HashSet<String>>>()?;
        let direct: Vec<_> = list["policies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| assigned.contains(p["id"].as_str().unwrap()))
            .map(|p| p["id"].clone())
            .collect();
        Ok(Some(output(
            "policyAssignmentWireListSchema",
            json!({"collectionVersion":list["collectionVersion"],"policies":list["policies"],"directPolicyIds":direct}),
        )?))
    }
    pub async fn resolve_effective(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        self.ensure_owner(owner).await?;
        if self
            .database
            .query(
                "SELECT id FROM projects WHERE owner_id=$1 AND id=$2 LIMIT 1",
                &[&owner, &project],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let sql = format!(
            "SELECT {POLICY} FROM policies WHERE owner_id=$1 AND enabled=true AND audience IN ('ide','both') ORDER BY position,id"
        );
        let owner_params: crate::database::Parameters<'_> = &[&owner];
        let project_params: crate::database::Parameters<'_> = &[&project];
        let both: crate::database::Parameters<'_> = &[&owner, &project];
        let (policies,direct,workspaces)=tokio::try_join!(
            self.database.query(&sql,owner_params),
            self.database.query("SELECT policy_id FROM project_policy_assignments WHERE project_id=$1", project_params),
            self.database.query("SELECT a.policy_id,w.id FROM workspace_policy_assignments a INNER JOIN project_workspaces w ON w.id=a.workspace_id AND w.owner_id=$1 INNER JOIN project_workspace_memberships m ON m.workspace_id=w.id AND m.project_id=$2 ORDER BY w.position,w.created_at", both)
        )?;
        let direct = direct
            .iter()
            .map(|r| r.get(0))
            .collect::<Result<HashSet<String>>>()?;
        let mut workspace_sources = HashMap::<String, Vec<String>>::new();
        for row in workspaces {
            workspace_sources
                .entry(row.get(0)?)
                .or_default()
                .push(row.get(1)?);
        }
        let mut effective = Vec::new();
        for row in policies {
            let id: String = row.get(0)?;
            let mandatory: bool = row.get(5)?;
            let mut sources = Vec::new();
            if mandatory {
                sources.push(json!({"type":"mandatory"}));
            }
            for workspace in workspace_sources.get(&id).into_iter().flatten() {
                sources.push(json!({"type":"workspace","workspaceId":workspace}));
            }
            if direct.contains(&id) {
                sources.push(json!({"type":"project","projectId":project}));
            }
            if !sources.is_empty() {
                effective.push(json!({"id":id,"protectedSummary":row.get::<Value>(2)?,"mandatory":mandatory,"sources":sources}));
            }
        }
        let limit = assets()["effectivePolicyLimit"].as_u64().unwrap() as usize;
        if effective.len() > limit {
            return Err(conflict(
                format!(
                    "Project {project} has more than {limit} effective policies. Reduce or consolidate its effective policies before starting another Agent turn."
                ),
                "limit-exceeded",
            ));
        }
        Ok(Some(output(
            "effectivePolicyWireListSchema",
            json!({"policies":effective}),
        )?))
    }
    pub async fn resolve_standalone(&self, owner: &str) -> Result<Value> {
        self.ensure_owner(owner).await?;
        let rows=self.database.query("SELECT id,protected_summary,protected_body FROM policies WHERE owner_id=$1 AND enabled=true AND audience IN ('chat','both') ORDER BY position,id", &[&owner]).await?;
        let limit = assets()["effectivePolicyLimit"].as_u64().unwrap() as usize;
        if rows.len() > limit {
            return Err(conflict(
                format!(
                    "Standalone Chat has more than {limit} effective policies. Reduce or consolidate Chat policies before starting another turn."
                ),
                "limit-exceeded",
            ));
        }
        let policies=rows.iter().map(|r|Ok(json!({"id":r.get::<String>(0)?,"protectedSummary":r.get::<Value>(1)?,"protectedBody":r.get::<Value>(2)?}))).collect::<Result<Vec<_>>>()?;
        output(
            "standalonePolicyWireListSchema",
            json!({"policies":policies}),
        )
    }
}
