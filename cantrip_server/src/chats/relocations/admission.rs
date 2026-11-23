use super::*;
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub(super) struct UnobservedSource(pub Value);

impl std::fmt::Display for UnobservedSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The source worktree revision has not been observed yet.")
    }
}

impl std::error::Error for UnobservedSource {}

pub(super) struct ObservedSource {
    pub binding: Value,
    pub head: String,
}

fn source_binding(chat: &Value, worktree: &Value, source: &Value) -> Result<Value> {
    if source["project_id"] != chat["project_id"]
        || source["worker_id"] != worktree["worker_id"]
        || !source["removed_at"].is_null()
        || worktree["lifecycle_state"] != "ready"
    {
        return Err(conflict("The source worktree is no longer available."));
    }
    Ok(json!({
        "projectSourceId": source["id"],
        "placementRevision": chat["placement_revision"],
        "workerId": worktree["worker_id"],
        "sourcePath": source["absolute_path"],
        "worktree": json!({"id": worktree["id"], "path": worktree["absolute_path"]}),
    }))
}

impl Repository {
    pub async fn create(
        &self,
        owner: &str,
        chat: &str,
        target: &Value,
        key: &str,
    ) -> Result<Value> {
        self.create_with_observation(owner, chat, target, key, None)
            .await
            .map_err(|error| {
                if error.is::<UnobservedSource>() {
                    conflict(&error.to_string())
                } else {
                    error
                }
            })
    }

    pub(super) async fn create_with_observation(
        &self,
        owner: &str,
        chat: &str,
        target: &Value,
        key: &str,
        observed: Option<ObservedSource>,
    ) -> Result<Value> {
        let mut target = target.clone();
        target["surface"] = json!({"kind":"chat","id":chat});
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                json!({"chatId":chat,"targetPlacement":target})
                    .stringify()
                    .as_bytes()
            )
        );
        let existing=self.database.query("SELECT to_jsonb(j)::text FROM chat_relocation_jobs j WHERE owner_id=$1 AND idempotency_key=$2 LIMIT 1",&[&owner,&key]).await?.first().map(raw).transpose()?;
        if let Some(existing) = existing {
            if existing["payload_fingerprint"] != fingerprint.as_str() {
                return Err(conflict(
                    "This idempotency key is already attached to a different relocation request.",
                ));
            }
            return mapping::job(&existing);
        }
        let at = crate::auth::now();
        let owner = owner.to_owned();
        let chat = chat.to_owned();
        let key = key.to_owned();
        let saved_owner = owner.clone();
        let saved_key = key.clone();
        let saved_fingerprint = fingerprint.clone();
        let result=self.database.transaction(move|tx|Box::pin(async move{
            tx.query("SELECT c.id FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 FOR UPDATE",&[&owner,&chat]).await?;
            // Bind the worker's out-of-transaction read to the same placement
            // while committing the observation and the relocation together.
            let lock = if observed.is_some() { " FOR UPDATE OF w, s" } else { "" };
            let row=tx.query(&format!("SELECT jsonb_build_object('chat',to_jsonb(c),'source',to_jsonb(s),'worktree',to_jsonb(w),'runtime',to_jsonb(r))::text FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 INNER JOIN project_worktrees w ON w.id=c.active_worktree_id INNER JOIN project_sources s ON s.id=w.project_source_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=w.worker_id AND r.worktree_id=w.id WHERE c.id=$2 LIMIT 1{lock}"),&[&owner,&chat]).await?.first().map(raw).transpose()?.ok_or_else(||Error::NotFound("Chat not found.".into()))?;
            let c=&row["chat"];let w=&row["worktree"];let source=&row["source"];
            if !c["active_worker_id"].is_null() && c["active_worker_id"]!=w["worker_id"] {return Err(conflict("The chat source worker and active worktree do not match."))}
            if target["projectId"]!=c["project_id"] || !crate::wire::coercion::truthy(target.get("projectReplicaId")) || !crate::wire::coercion::truthy(target.get("worktreeId")) {return Err(conflict("The relocation target is not a complete placement for this chat."))}
            let project=text(&c["project_id"])?;let target_tree=text(&target["worktreeId"])?;let target_worker=text(&target["workerId"])?;let target_source=text(&target["projectReplicaId"])?;
            if tx.query("SELECT w.id FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id WHERE w.id=$1 AND w.worker_id=$2 AND s.id=$3 AND s.project_id=$4 AND s.removed_at IS NULL AND w.lifecycle_state='ready' LIMIT 1",&[&target_tree,&target_worker,&target_source,&project]).await?.is_empty(){return Err(conflict("The relocation target is not a ready project worktree."))}
            let placement=json!({"projectId":project,"workerId":w["worker_id"],"projectReplicaId":row["source"]["id"],"worktreeId":w["id"],"surface":json!({"kind":"chat","id":chat})});
            if placement["workerId"]==target["workerId"] && placement["worktreeId"]==target["worktreeId"] {return Err(conflict("The chat already uses the selected placement."))}
            if !tx.query(&format!("SELECT id FROM chat_relocation_jobs WHERE chat_id=$1 AND state IN {ACTIVE} LIMIT 1"),&[&chat]).await?.is_empty(){return Err(conflict("This chat already has an active relocation."))}
            if let Some(observed) = &observed
                && source_binding(c, w, source)? != observed.binding
            {
                return Err(conflict("The source placement changed before relocation was admitted."));
            }
            let head = if let Some(head) = w["head"].as_str().filter(|head| !head.is_empty()) {
                head.to_owned()
            } else {
                let Some(observed) = observed else {
                    return Err(UnobservedSource(source_binding(c, w, source)?).into());
                };
                let worktree_id = text(&w["id"])?;
                tx.query(
                    "UPDATE project_worktrees SET head=$2, updated_at=$3 WHERE id=$1",
                    &[&worktree_id, &observed.head, &at],
                ).await?;
                observed.head
            };
            let snapshot=snapshots::capture(Executor::Transaction(tx),c).await?;
            let id=uuid::Uuid::new_v4().to_string();let state=if c["status"]=="running" || c["status"]=="waiting-for-approval" {"waiting-for-idle"}else{"queued"};
            let source_json=placement.stringify();let target_json=target.stringify();let revision=c["placement_revision"].stringify();let p=progress(state,json!(0),at).stringify();
            let rows=tx.query("INSERT INTO chat_relocation_jobs(id,owner_id,project_id,chat_id,state,idempotency_key,payload_fingerprint,source_placement,source_placement_revision,target_placement,progress,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9::text::integer,$10::text::jsonb,$11::text::jsonb,$12,$12,$12) RETURNING to_jsonb(chat_relocation_jobs)::text",&[&id,&owner,&project,&chat,&state,&key,&fingerprint,&source_json,&revision,&target_json,&p,&at]).await?;
            let sequence=snapshot["throughSequence"].stringify();let digest=text(&snapshot["transcriptSha256"])?;let payload=snapshot["payload"].stringify();let count=snapshot["messageCount"].stringify();let attachment_count=snapshot["attachmentCount"].stringify();let model=optional(&c["model_id"])?;let route=optional(&row["runtime"]["model_route_id"])?;let permission=optional(&c["permission_profile_id"])?;
            tx.query("INSERT INTO chat_relocation_snapshots(id,job_id,chat_id,source_placement,through_sequence,transcript_sha256,payload,message_count,attachment_count,model_id,model_route_id,permission_profile_id,required_revision,created_at) VALUES($1,$1,$2,$3::text::jsonb,$4::text::integer,$5,$6::text::jsonb,$7::text::integer,$8::text::integer,$9,$10,$11,$12,$13)",&[&id,&chat,&source_json,&sequence,&digest,&payload,&count,&attachment_count,&model,&route,&permission,&head,&at]).await?;
            mapping::job(&first(&rows)?)
        })).await;
        match result {
            Err(error) if unique(&error) => {
                let replay=self.database.query("SELECT to_jsonb(j)::text FROM chat_relocation_jobs j WHERE owner_id=$1 AND idempotency_key=$2 LIMIT 1",&[&saved_owner,&saved_key]).await?.first().map(raw).transpose()?;
                if let Some(replay) =
                    replay.filter(|r| r["payload_fingerprint"] == saved_fingerprint.as_str())
                {
                    return mapping::job(&replay);
                }
                Err(conflict("This chat already has an active relocation."))
            }
            other => other,
        }
    }
}
