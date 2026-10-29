use super::*;
pub struct CreateAttachment {
    pub client: String,
    pub expires: Time,
    pub secret_expires: Time,
    pub secret_hash: String,
}
#[derive(Clone)]
pub struct StopFence {
    pub activated: Option<Time>,
    pub expires: Option<Time>,
    pub secret_expires: Option<Time>,
}
impl Repository {
    pub async fn attachment(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.authorization(Some(owner), id, None).await
    }
    pub async fn authorize_attachment(&self, id: &str, secret_hash: &str) -> Result<Option<Value>> {
        self.authorization(None, id, Some(secret_hash)).await
    }
    async fn authorization(
        &self,
        owner: Option<&str>,
        id: &str,
        secret: Option<&str>,
    ) -> Result<Option<Value>> {
        let now = self.now();
        let rows=self.database.query("SELECT to_jsonb(a)::text,to_jsonb(t)::text FROM tunnel_attachments a INNER JOIN tunnels t ON t.id=a.tunnel_id WHERE a.id=$1 AND a.kind='desktop-loopback' AND a.expires_at>$2 AND a.status<>'stopped' AND ($3::text IS NULL OR t.owner_id=$3) AND ($4::text IS NULL OR (a.secret_hash=$4 AND a.secret_expires_at>$2)) LIMIT 1",&[&id,&now,&owner,&secret]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let a = raw(row, 0)?;
        let t = raw(row, 1)?;
        let record = protected(&t);
        let destination = destination(&t)?;
        if !coercion::truthy(a.get("client_id"))
            || a["expires_at"].is_null()
            || a["secret_expires_at"].is_null()
            || t["source_kind"] != "desktop-loopback"
            || (destination["kind"] != "worker-tcp"
                && !(destination["kind"] == "worker-adapter"
                    && destination["adapter"] == "project-share"))
            || record.is_none()
        {
            return Ok(None);
        }
        Ok(Some(
            json!({"attachmentId":id,"clientId":a["client_id"],"destination":destination,"expiresAt":iso(time(&a,"expires_at")?.unwrap()),"ownerId":t["owner_id"],"origin":t["origin"],"projectId":t["project_id"],"protectedRecord":record.unwrap(),"secretExpiresAt":iso(time(&a,"secret_expires_at")?.unwrap()),"tunnelId":t["id"]}),
        ))
    }
    pub async fn create_attachment(
        &self,
        owner: &str,
        tunnel: &str,
        input: CreateAttachment,
    ) -> Result<Option<Value>> {
        let repository = self.clone();
        let owner = owner.to_owned();
        let tunnel = tunnel.to_owned();
        self.database.transaction(move |tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(t)::text FROM tunnels t WHERE id=$1 AND owner_id=$2 LIMIT 1 FOR UPDATE",&[&tunnel,&owner]).await?;
            let Some(row)=rows.first()else{return Ok(None)};let t=raw(row,0)?;
            if t["source_kind"]!="desktop-loopback" || !(t["management"]=="user-managed" || (t["management"]=="managed-ephemeral" && ["browser","project-share"].iter().any(|v|t["origin"]==*v))){return Ok(None)}
            let rows=tx.query("SELECT id,secret_expires_at FROM tunnel_attachments WHERE tunnel_id=$1 AND client_id=$2 LIMIT 1",&[&tunnel,&input.client]).await?;
            let now=repository.now();let existing=rows.first();let id=existing.map(|r|r.get::<String>(0)).transpose()?.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
            let previous=existing.map(|r|r.get::<Option<Time>>(1)).transpose()?.flatten().map_or(0,|v|v.timestamp_millis());
            let secret=Time::from_timestamp_millis(input.secret_expires.timestamp_millis().max(previous+1)).context("Tunnel secret generation range")?;
            if existing.is_some(){
                tx.query("UPDATE tunnel_attachments SET active_connection_count=0,expires_at=$2,error_code=NULL,last_seen_at=NULL,secret_expires_at=$3,secret_hash=$4,status='starting',updated_at=$5 WHERE id=$1",&[&id,&input.expires,&secret,&input.secret_hash,&now]).await?;
                tx.query("UPDATE tunnel_attachment_direct_leases SET lease_expires_at=LEAST(lease_expires_at,$2),updated_at=$3 WHERE attachment_id=$1",&[&id,&input.expires,&now]).await?;
            }else{tx.query("INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,active_connection_count,expires_at,error_code,last_seen_at,secret_expires_at,secret_hash,status,updated_at) VALUES($1,$2,'desktop-loopback',$3,0,$4,NULL,NULL,$5,$6,'starting',$7)",&[&id,&tunnel,&input.client,&input.expires,&secret,&input.secret_hash,&now]).await?;}
            recompute(tx,&tunnel,now).await?;
            Ok(Some(json!({"attachmentId":id,"expiresAt":iso(input.expires),"projectId":t["project_id"],"secretExpiresAt":iso(secret)})))
        })).await
    }
    pub async fn activate_attachment(
        &self,
        id: &str,
        client: &str,
        secret_expires: Time,
    ) -> Result<Option<Time>> {
        let repository = self.clone();
        let id = id.to_owned();
        let client = client.to_owned();
        self.database.transaction(move |tx|Box::pin(async move {
            let Some((_,t))=lock_attachment(tx,&id,None,Some(&client)).await?else{return Ok(None)};
            let now=repository.now();let rows=tx.query("SELECT last_seen_at FROM tunnel_attachments WHERE id=$1 AND client_id=$2 AND secret_expires_at=$3 LIMIT 1",&[&id,&client,&secret_expires]).await?;
            let Some(row)=rows.first()else{return Ok(None)};let previous=row.get::<Option<Time>>(0)?.map_or(0,|v|v.timestamp_millis());
            let activated=Time::from_timestamp_millis(now.timestamp_millis().max(previous+1)).context("Tunnel activation generation range")?;
            let rows=tx.query("UPDATE tunnel_attachments SET error_code=NULL,last_seen_at=$4,status='active',updated_at=$5 WHERE id=$1 AND client_id=$2 AND secret_expires_at=$3 AND status<>'stopped' AND expires_at>$5 RETURNING tunnel_id",&[&id,&client,&secret_expires,&activated,&now]).await?;
            if rows.is_empty(){return Ok(None)}recompute(tx,&text(&t,"id")?,now).await?;Ok(Some(activated))
        })).await
    }
    pub async fn mark_offline(&self, id: &str, secret: Time, activated: Time) -> Result<bool> {
        let repository = self.clone();
        let id = id.to_owned();
        self.database.transaction(move |tx|Box::pin(async move {
            let Some((_,t))=lock_attachment(tx,&id,None,None).await?else{return Ok(false)};let now=repository.now();
            let rows=tx.query("UPDATE tunnel_attachments SET active_connection_count=0,error_code='attachment-disconnected',last_seen_at=NULL,status='offline',updated_at=$4 WHERE id=$1 AND secret_expires_at=$2 AND last_seen_at=$3 AND status<>'stopped' AND expires_at>$4 RETURNING id",&[&id,&secret,&activated,&now]).await?;
            if rows.is_empty(){return Ok(false)}recompute(tx,&text(&t,"id")?,now).await?;Ok(true)
        })).await
    }
    pub async fn stop_attachment(
        &self,
        owner: &str,
        id: &str,
        error: Option<&str>,
        preserve: bool,
        expected: Option<StopFence>,
    ) -> Result<Option<Value>> {
        let repository = self.clone();
        let owner = owner.to_owned();
        let id = id.to_owned();
        let error = error.map(str::to_owned);
        self.database.transaction(move |tx|Box::pin(async move {
            let Some((_,t))=lock_attachment(tx,&id,Some(&owner),None).await?else{return Ok(None)};let tunnel=text(&t,"id")?;let now=repository.now();
            let status=if error.as_deref().is_some_and(|s|!s.is_empty()){"failed"}else{"stopped"};
            let query="UPDATE tunnel_attachments SET active_connection_count=0,error_code=$2,secret_expires_at=NULL,secret_hash=NULL,status=$3,updated_at=$4 WHERE id=$1";
            let rows=if let Some(fence)=expected {
                tx.query(&format!("{query} AND last_seen_at IS NOT DISTINCT FROM $5 AND expires_at IS NOT DISTINCT FROM $6 AND secret_expires_at IS NOT DISTINCT FROM $7 RETURNING id"),&[&id,&error,&status,&now,&fence.activated,&fence.expires,&fence.secret_expires]).await?
            }else{tx.query(&format!("{query} RETURNING id"),&[&id,&error,&status,&now]).await?};
            if rows.is_empty(){return Ok(None)}
            tx.query("DELETE FROM tunnel_attachment_direct_leases WHERE attachment_id=$1",&[&id]).await?;
            let remaining=tx.query("SELECT id FROM tunnel_attachments WHERE tunnel_id=$1 AND id<>$2 AND status NOT IN ('stopped','failed') LIMIT 1",&[&tunnel,&id]).await?;
            if remaining.is_empty() && !preserve {tx.query("UPDATE tunnels SET active_connection_count=0,desired_state='stopped',error_code=$2,status=$3,updated_at=$4 WHERE id=$1",&[&tunnel,&error,&status,&now]).await?;}else if !remaining.is_empty(){recompute(tx,&tunnel,now).await?;}
            Ok(Some(json!({"projectId":t["project_id"],"tunnelId":t["id"]})))
        })).await
    }
}
