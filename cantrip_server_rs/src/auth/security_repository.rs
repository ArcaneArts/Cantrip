use super::{iso, now, repository::AuthRepository};
use crate::database::Row;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

fn whitelist_entry(row: &Row, registered: bool) -> Result<Value> {
    Ok(
        json!({"id":row.get::<String>(0)?,"email":row.get::<String>(1)?,"registered":registered,"createdAt":iso(row.get::<DateTime<Utc>>(2)?)}),
    )
}

impl AuthRepository {
    pub async fn list_whitelist(&self) -> Result<Vec<Value>> {
        self.database.query("SELECT w.id,w.email,w.created_at,u.id FROM account_license_whitelist w LEFT JOIN users u ON u.kind='account' AND u.normalized_email=w.normalized_email ORDER BY w.created_at,w.email",&[]).await?.iter().map(|row|whitelist_entry(row,row.get::<Option<String>>(3)?.is_some())).collect()
    }
    pub async fn create_whitelist(
        &self,
        owner: &str,
        email: &str,
        normalized: &str,
    ) -> Result<Option<Value>> {
        let rows=self.database.query("INSERT INTO account_license_whitelist(id,email,normalized_email,added_by_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(normalized_email) DO NOTHING RETURNING id,email,created_at",&[&Uuid::new_v4().to_string(),&email,&normalized,&owner]).await?;
        rows.first()
            .map(|row| whitelist_entry(row, false))
            .transpose()
    }
    pub async fn delete_whitelist(&self, id: &str) -> Result<bool> {
        Ok(!self
            .database
            .query(
                "DELETE FROM account_license_whitelist WHERE id=$1 RETURNING id",
                &[&id],
            )
            .await?
            .is_empty())
    }
    pub async fn list_sessions(&self, owner: &str, current: Option<&str>) -> Result<Vec<Value>> {
        self.database.query("SELECT id,auth_method,label,created_at,last_seen_at,expires_at FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY last_seen_at DESC LIMIT 1000",&[&owner,&now()]).await?.iter().map(|row|{
            let id=row.get::<String>(0)?;
            Ok(json!({"id":id,"authMethod":row.get::<String>(1)?,"label":row.get::<Option<String>>(2)?,"current":Some(id.as_str())==current,"connected":Some(id.as_str())==current,"createdAt":iso(row.get::<DateTime<Utc>>(3)?),"lastSeenAt":iso(row.get::<DateTime<Utc>>(4)?),"expiresAt":iso(row.get::<DateTime<Utc>>(5)?)}))
        }).collect()
    }
    pub async fn list_audit(
        &self,
        owner: Option<&str>,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Value> {
        let rows=self.database.query("SELECT id,owner_id,actor_user_id,actor_session_id,action,result,resource_type,resource_id,request_id,occurred_at FROM audit_events WHERE ($1::text IS NULL OR owner_id=$1) AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3",&[&owner,&before,&(limit+1)]).await?;
        let items=rows.iter().take(limit as usize).map(|row|Ok(json!({"id":row.get::<i64>(0)?,"ownerId":row.get::<Option<String>>(1)?,"actor":{"userId":row.get::<Option<String>>(2)?,"sessionId":row.get::<Option<String>>(3)?},"action":row.get::<String>(4)?,"result":row.get::<String>(5)?,"resource":{"type":row.get::<String>(6)?,"id":row.get::<Option<String>>(7)?},"requestId":row.get::<Option<String>>(8)?,"occurredAt":iso(row.get::<DateTime<Utc>>(9)?)}))).collect::<Result<Vec<_>>>()?;
        let cursor = if rows.len() > limit as usize {
            items
                .last()
                .map(|item| item["id"].clone())
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        Ok(json!({"items":items,"nextCursor":cursor}))
    }
}
