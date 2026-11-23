use super::*;
use futures::future::BoxFuture;
use indexmap::{IndexMap, IndexSet};

pub type ProtectMessages =
    Arc<dyn Fn(Vec<Value>, Vec<Value>) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
impl Repository {
    pub async fn complete_canonical(
        &self,
        id: &str,
        command: &str,
        attempt: f64,
        transcript: &Value,
        attachments: &[Value],
        protect: ProtectMessages,
    ) -> Result<Value> {
        let (id, command, transcript, attachments) = (
            id.to_owned(),
            command.to_owned(),
            transcript.clone(),
            attachments.to_vec(),
        );
        let batch = self.insert_batch_size;
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let job=first(&tx.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?)?;
            if job["command_id"]!=command.as_str() || job["attempt"]!=Value::Number(attempt) || job["state"]!="importing" {return Err(Error::Stale.into());}
            if transcript["sourceId"]!=job["source_id"] || transcript["sourceThreadId"]!=job["source_thread_id"] || transcript["sync"]["threadId"]!=job["source_thread_id"] {
                return Err(conflict("The source chat identity changed while it was being imported."));
            }
            let descriptors=transcript["attachments"].as_array().context("Import attachment descriptors")?;
            let ids=descriptors.iter().map(|d|text(&d["id"])).collect::<Result<IndexSet<_>>>()?;
            let mut invalid=ids.len()!=descriptors.len() || attachments.len()!=descriptors.len();
            for imported in &attachments {
                let descriptor=&imported["descriptor"];let external=text(&descriptor["id"])?;
                invalid|=!ids.contains(&external) || imported["id"]!=descriptor["id"] || imported["id"]!=attachment_id(&id,&text(&descriptor["sourceAttachmentId"])?).as_str();
            }
            if invalid {return Err(conflict("The imported attachment set changed before canonical storage."));}
            let project=text(&job["project_id"])?;let source=text(&job["source_worker_id"])?;let replica=text(&transcript["metadata"]["match"]["projectReplicaId"])?;
            let worker=text(&job["target_placement"]["workerId"])?;let tree=optional(&job["target_placement"]["worktreeId"])?;
            let sources=tx.query("SELECT id FROM project_sources WHERE id=$1 AND project_id=$2 AND worker_id=$3 AND removed_at IS NULL LIMIT 1",&[&replica,&project,&source]).await?;
            let targets=if crate::wire::coercion::truthy(job["target_placement"].get("worktreeId")) {
                tx.query("SELECT to_jsonb(w)::text FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$1 AND s.worker_id=$2 AND s.removed_at IS NULL WHERE w.id=$3 AND w.lifecycle_state='ready' LIMIT 1",&[&project,&worker,&tree]).await?
            } else {vec![]};
            let worktree=targets.first().map(raw).transpose()?;
            let Some(worktree)=worktree.filter(|_|!sources.is_empty()) else {
                return Err(conflict("The source project match or destination worktree is no longer valid."));
            };
            let position=tx.query("SELECT position FROM chats WHERE project_id=$1 ORDER BY position DESC LIMIT 1",&[&project]).await?.first().map(|r|r.get::<i32>(0)).transpose()?.unwrap_or(-1)+1;
            let owner=text(&job["owner_id"])?;let label=transcript["titleProtection"].stringify();
            let model=optional(&job["requested_model_id"])?;let permission=optional(&job["requested_permission_profile_id"])?;let plan=text(&job["requested_plan_mode"])?;
            let primary=worktree["is_primary"].as_bool().context("Import primary worktree")?;let mode=if primary {"agent-managed"} else {"pinned"};
            let chats=tx.query("INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,position,status,active_worker_id,active_worktree_id,worktree_mode,model_id,permission_profile_id,plan_mode,created_at,updated_at) VALUES($1,$2,'project',$3,$4::text::jsonb,$5,'idle',$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id",&[&id,&owner,&project,&label,&position,&worker,&tree,&mode,&model,&permission,&plan,&at]).await?;
            let session=uuid::Uuid::new_v4().to_string();
            tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,status) VALUES($1,$2,$3,$4,'detached')",&[&session,&id,&worker,&tree]).await?;
            let lane=uuid::Uuid::new_v4().to_string();let exclusive=!primary;let head=optional(&worktree["head"])?;
            tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,starting_head,runtime_session_id) VALUES($1,$2,$3,$4,'import',$5,'Imported Codex chat','suspended',$6,$7)",&[&lane,&id,&tree,&worker,&exclusive,&head,&session]).await?;
            crate::project_layout::attach_resource(tx,&project,&id,"chat",&Value::object([] as [(&str,Value);0])).await?;
            for chunk in attachments.chunks(batch) {
                let payload=Value::Array(chunk.to_vec()).stringify();
                tx.query("INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,status,created_at,updated_at) SELECT e->>'id',$2,$3,e->'descriptor'->'protectedMetadata',(e->'descriptor'->>'sizeBytes')::bigint,CASE WHEN e->'descriptor'->>'status'='available' THEN 'ready' ELSE 'failed' END,$4,$4 FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS items(e,n) ORDER BY n",&[&payload,&id,&worker,&at]).await?;
            }
            let available=attachments.iter().filter(|a|a["descriptor"]["status"]=="available").cloned().collect::<Vec<_>>();
            for chunk in available.chunks(batch) {
                let payload=Value::Array(chunk.to_vec()).stringify();
                tx.query("INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status,verified_at,created_at,updated_at) SELECT e->>'id',$2,'ready',$3,$3,$3 FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS items(e,n) ORDER BY n",&[&payload,&worker,&at]).await?;
            }
            let mut external=IndexMap::new();let mut opaque=Vec::new();
            for imported in &attachments {
                let d=&imported["descriptor"];let attachment=&imported["id"];let status=if d["status"]=="available" {"ready"} else {"failed"};
                external.insert(text(&d["id"])?,json!({"id":attachment,"chatId":id,"fileName":"Protected attachment","mimeType":"application/octet-stream","sizeBytes":d["sizeBytes"],"kind":"file","source":"file","status":status,"previewText":Value::Null,"createdAt":crate::auth::iso(at)}));
                opaque.push(crate::settings::parse_response("chatAttachmentOpaqueSummarySchema",Some(&json!({"id":attachment,"chatId":id,"sizeBytes":d["sizeBytes"],"status":status,"protectedMetadata":d["protectedMetadata"],"createdAt":crate::auth::iso(at)})))?);
            }
            let external=Value::Object(external.into_iter().map(|(k,v)|(k.into(),v)).collect());
            let options=json!({"idempotencyPrefix":"codex-import","interruptedMessage":"Turn interrupted in the imported Codex chat.","failedMessage":"The imported Codex turn failed."});
            let messages=crate::chats::thread_sync::canonical_messages(&transcript["sync"],&options,Some(&external))?;
            let mut prepared=Vec::new();
            for item in &messages {
                let mut message=item["message"].clone();message["id"]=json!(uuid::Uuid::new_v4().to_string());prepared.push(message);
            }
            let protected=protect(prepared,opaque).await?;
            let protected=crate::settings::parse_response("chatMessageOpaqueContentListSchema",Some(&protected))?;
            let protected=protected.as_array().context("Protected import messages")?;
            if protected.len()!=messages.len() || protected.iter().zip(&messages).any(|(p,m)|p["idempotencyKey"]!=m["message"]["idempotencyKey"]) {
                return Err(conflict("The destination worker returned an inconsistent encrypted transcript."));
            }
            for chunk in protected.chunks(batch) {
                let payload=Value::Array(chunk.to_vec()).stringify();
                tx.query("INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,mode,content,protected_content,attachment_ids,reasoning_effort,idempotency_key,created_at) SELECT e->>'id',$2,$3,$4,e->'classification'->>'role',e->'classification'->>'mode',NULL,e->'protectedContent',e->'classification'->'attachmentIds',e->>'reasoningEffort',e->>'idempotencyKey',$5 FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS items(e,n) ORDER BY n",&[&payload,&id,&tree,&lane,&at]).await?;
            }
            let count=attachments.len() as i32;let warnings=attachments.iter().filter(|a|a["descriptor"]["status"]!="available").count() as i32;let p=progress("awaiting-hydration",75,at).stringify();
            let rows=tx.query("UPDATE chat_import_jobs SET chat_id=$1,state='awaiting-hydration',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,source_metadata=NULL,attachment_count=$3,attachment_warning_count=$4,progress=$5::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$6 WHERE id=$1 AND command_id=$2 AND state='importing' RETURNING to_jsonb(chat_import_jobs)::text",&[&id,&command,&count,&warnings,&p,&at]).await?;
            if chats.is_empty() {return Err(Error::Stale.into());}
            first(&rows)
        })).await?;
        mapping::job(&row)
    }
}
