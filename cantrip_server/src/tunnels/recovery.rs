use super::attachments::StopFence;
use super::*;
impl Repository {
    pub async fn reset_transient(&self) -> Result<()> {
        let now = self.now();
        let candidates=self.database.query("SELECT id FROM tunnels WHERE status IN ('starting','active','degraded','stopping') OR (origin IN ('code','project-share') AND management='managed-ephemeral')",&[]).await?;
        for candidate in candidates {
            let id = candidate.get::<String>(0)?;
            self.database.transaction(move |tx|Box::pin(async move {
                let rows=tx.query("SELECT to_jsonb(t)::text FROM tunnels t WHERE id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?;let Some(row)=rows.first()else{return Ok(())};let t=raw(row,0)?;
                let live=tx.query("SELECT l.attachment_id FROM tunnel_attachment_direct_leases l INNER JOIN tunnel_attachments a ON a.id=l.attachment_id WHERE a.tunnel_id=$1 AND a.status NOT IN ('stopped','failed') AND l.status='active' AND l.lease_expires_at>$2",&[&id,&now]).await?;
                tx.query("UPDATE tunnel_attachments SET active_connection_count=0,error_code='server-restarted',last_seen_at=NULL,secret_expires_at=NULL,secret_hash=NULL,status='offline',updated_at=$2 WHERE tunnel_id=$1 AND status IN ('starting','active','degraded','stopping')",&[&id,&now]).await?;
                if !live.is_empty(){recompute(tx,&id,now).await?;return Ok(())}
                if t["management"]=="managed-ephemeral" && t["origin"]=="project-share" {tx.query("DELETE FROM tunnels WHERE id=$1",&[&id]).await?;return Ok(())}
                if ["starting","active","degraded","stopping"].iter().any(|v|t["status"]==*v) {tx.query("UPDATE tunnels SET active_connection_count=0,error_code='server-restarted',status='offline',updated_at=$2 WHERE id=$1",&[&id,&now]).await?;}
                Ok(())
            })).await?;
        }
        Ok(())
    }
    pub async fn expire_attachments(&self, now: Time) -> Result<Vec<Value>> {
        let rows=self.database.query("SELECT to_jsonb(a)::text,to_jsonb(t)::text FROM tunnel_attachments a INNER JOIN tunnels t ON t.id=a.tunnel_id WHERE a.expires_at<=$1 AND a.status NOT IN ('stopped','failed')",&[&now]).await?;
        let mut stopped = Vec::new();
        for row in rows {
            let a = raw(&row, 0)?;
            let t = raw(&row, 1)?;
            let id = text(&a, "id")?;
            if self
                .stop_attachment(
                    &text(&t, "owner_id")?,
                    &id,
                    Some("attachment-expired"),
                    false,
                    Some(StopFence {
                        activated: time(&a, "last_seen_at")?,
                        expires: time(&a, "expires_at")?,
                        secret_expires: time(&a, "secret_expires_at")?,
                    }),
                )
                .await?
                .is_some()
            {
                stopped.push(change(&t, &id));
            }
        }
        Ok(stopped)
    }
}
