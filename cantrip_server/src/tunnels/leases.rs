use super::*;
impl Repository {
    pub async fn activate_direct(
        &self,
        owner: &str,
        id: &str,
        capability: &str,
        expires: Option<Time>,
        secret: Option<Time>,
    ) -> Result<Option<Value>> {
        let Some(expires) = expires.filter(|v| !capability.is_empty() && *v > self.now()) else {
            return Ok(None);
        };
        let Some(secret) = secret else {
            return Ok(None);
        };
        let repository = self.clone();
        let owner = owner.to_owned();
        let id = id.to_owned();
        let capability = capability.to_owned();
        self.database.transaction(move |tx|Box::pin(async move {
            let Some((_,t))=lock_attachment(tx,&id,Some(&owner),None).await?else{return Ok(None)};let now=repository.now();
            let rows=tx.query("SELECT expires_at FROM tunnel_attachments WHERE id=$1 AND secret_expires_at=$2 AND status NOT IN ('stopped','failed') AND expires_at>$3 LIMIT 1",&[&id,&secret,&now]).await?;
            let Some(row)=rows.first()else{return Ok(None)};let Some(hard)=row.get::<Option<Time>>(0)?else{return Ok(None)};let hard=Time::from_timestamp_millis(hard.timestamp_millis()).unwrap();let bounded=expires.min(hard);if bounded<=now{return Ok(None)}
            let rows=tx.query("INSERT INTO tunnel_attachment_direct_leases(attachment_id,capability_id,lease_expires_at,status,updated_at) VALUES($1,$2,$3,'active',$4) ON CONFLICT(capability_id) DO UPDATE SET lease_expires_at=LEAST(GREATEST(tunnel_attachment_direct_leases.lease_expires_at,$3),$5),updated_at=$4 WHERE tunnel_attachment_direct_leases.status='active' AND tunnel_attachment_direct_leases.attachment_id=$1 RETURNING capability_id",&[&id,&capability,&bounded,&now,&hard]).await?;
            if rows.is_empty(){return Ok(None)}recompute(tx,&text(&t,"id")?,now).await?;Ok(Some(change(&t,&id)))
        })).await
    }
    pub async fn renew_direct(
        &self,
        owner: &str,
        id: &str,
        capability: &str,
        expires: Option<Time>,
    ) -> Result<Option<Value>> {
        let Some(expires) = expires.filter(|v| !capability.is_empty() && *v > self.now()) else {
            return Ok(None);
        };
        let repository = self.clone();
        let owner = owner.to_owned();
        let id = id.to_owned();
        let capability = capability.to_owned();
        self.database.transaction(move |tx|Box::pin(async move {
            let Some((a,t))=lock_attachment(tx,&id,Some(&owner),None).await?else{return Ok(None)};
            let Some(hard)=time(&a,"expires_at")?else{return Ok(None)};if a["status"]=="stopped" || a["status"]=="failed"{return Ok(None)}
            let now=repository.now();let bounded=expires.min(hard);if bounded<=now{return Ok(None)}
            let rows=tx.query("UPDATE tunnel_attachment_direct_leases SET lease_expires_at=LEAST(GREATEST(lease_expires_at,$3),$4),updated_at=$5 WHERE capability_id=$1 AND attachment_id=$2 AND status='active' RETURNING capability_id",&[&capability,&id,&bounded,&hard,&now]).await?;
            Ok((!rows.is_empty()).then(||change(&t,&id)))
        })).await
    }
    pub async fn finalize_direct(
        &self,
        owner: &str,
        id: &str,
        capability: &str,
        expires: Option<Time>,
    ) -> Result<Option<Value>> {
        let Some(expires) = expires.filter(|_| !capability.is_empty()) else {
            return Ok(None);
        };
        let repository = self.clone();
        let owner = owner.to_owned();
        let id = id.to_owned();
        let capability = capability.to_owned();
        self.database.transaction(move |tx|Box::pin(async move {
            let Some((a,t))=lock_attachment(tx,&id,Some(&owner),None).await?else{return Ok(None)};
            if a["status"]=="stopped" || a["status"]=="failed"{tx.query("DELETE FROM tunnel_attachment_direct_leases WHERE capability_id=$1 AND attachment_id=$2",&[&capability,&id]).await?;return Ok(None)}
            let now=repository.now();let hard=time(&a,"expires_at")?.unwrap_or(expires);let bounded=expires.min(hard);
            let rows=tx.query("INSERT INTO tunnel_attachment_direct_leases(attachment_id,capability_id,finalized_at,lease_expires_at,status,updated_at) VALUES($1,$2,$3,$4,'finalized',$3) ON CONFLICT(capability_id) DO UPDATE SET finalized_at=$3,lease_expires_at=LEAST(GREATEST(tunnel_attachment_direct_leases.lease_expires_at,$4),$5),status='finalized',updated_at=$3 WHERE tunnel_attachment_direct_leases.attachment_id=$1 RETURNING capability_id",&[&id,&capability,&now,&bounded,&hard]).await?;
            if rows.is_empty(){return Ok(None)}recompute(tx,&text(&t,"id")?,now).await?;Ok(Some(change(&t,&id)))
        })).await
    }
    pub async fn expire_direct(&self, now: Time) -> Result<Vec<Value>> {
        let rows=self.database.query("SELECT to_jsonb(t)::text,a.id FROM tunnel_attachment_direct_leases l INNER JOIN tunnel_attachments a ON a.id=l.attachment_id INNER JOIN tunnels t ON t.id=a.tunnel_id WHERE l.lease_expires_at<=$1",&[&now]).await?;
        let mut processed = std::collections::HashSet::new();
        let mut changes = Vec::new();
        for row in rows {
            let t = raw(&row, 0)?;
            let id = row.get::<String>(1)?;
            if !processed.insert(id.clone()) {
                continue;
            }
            let tunnel = text(&t, "id")?;
            let event = change(&t, &id);
            let changed=self.database.transaction(move |tx|Box::pin(async move {
                if tx.query("SELECT id FROM tunnels WHERE id=$1 LIMIT 1 FOR UPDATE",&[&tunnel]).await?.is_empty(){return Ok(false)}
                let rows=tx.query("UPDATE tunnel_attachment_direct_leases SET finalized_at=$2,status='finalized',updated_at=$2 WHERE attachment_id=$1 AND status='active' AND lease_expires_at<=$2 RETURNING capability_id",&[&id,&now]).await?;
                tx.query("DELETE FROM tunnel_attachment_direct_leases WHERE attachment_id=$1 AND status='finalized' AND lease_expires_at<=$2",&[&id,&now]).await?;
                if rows.is_empty(){return Ok(false)}recompute(tx,&tunnel,now).await?;Ok(true)
            })).await?;
            if changed {
                changes.push(event);
            }
        }
        Ok(changes)
    }
}
