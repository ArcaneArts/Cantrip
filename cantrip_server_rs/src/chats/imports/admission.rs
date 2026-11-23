use super::*;
use sha2::{Digest, Sha256};

fn fingerprint(project: &str, input: &Value) -> String {
    let mut value = json!({"projectId":project});
    for key in [
        "sourceKind",
        "sourceWorkerId",
        "sourceId",
        "sourceThreadId",
        "targetPlacement",
        "modelId",
        "modelRouteId",
        "providerAccountId",
        "permissionProfileId",
        "planMode",
    ] {
        if let Some(v) = input.get(key) {
            value[key] = v.clone();
        }
    }
    format!("{:x}", Sha256::digest(value.stringify().as_bytes()))
}
impl Repository {
    pub async fn create(&self, owner: &str, project: &str, input: &Value) -> Result<Value> {
        let key = text(&input["idempotencyKey"])?;
        let fingerprint = fingerprint(project, input);
        if let Some(existing)=self.database.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE owner_id=$1 AND idempotency_key=$2 LIMIT 1",&[&owner,&key]).await?.first().map(raw).transpose()? {
            if existing["payload_fingerprint"]!=fingerprint.as_str() {
                return Err(conflict("This idempotency key belongs to a different import request."));
            }
            return mapping::job(&existing);
        }
        let (owner, project, input) = (owner.to_owned(), project.to_owned(), input.clone());
        let (o, p, i, k, fp) = (
            owner.clone(),
            project.clone(),
            input.clone(),
            key.clone(),
            fingerprint.clone(),
        );
        let at = crate::auth::now();
        let result=self.database.transaction(|tx|Box::pin(async move {
            let source_worker=text(&i["sourceWorkerId"])?;
            let target=&i["targetPlacement"];
            let target_worker=text(&target["workerId"])?;
            let tree=optional(&target["worktreeId"])?;
            let model=optional(&i["modelId"])?;
            let route=optional(&i["modelRouteId"])?;
            let account=optional(&i["providerAccountId"])?;
            let projects=tx.query("SELECT id FROM projects WHERE owner_id=$1 AND id=$2 LIMIT 1",&[&o,&p]).await?;
            let sources=tx.query("SELECT s.id FROM project_sources s INNER JOIN workers w ON w.id=s.worker_id AND w.owner_id=$1 AND w.unlinked_at IS NULL WHERE s.project_id=$2 AND s.worker_id=$3 AND s.removed_at IS NULL LIMIT 1",&[&o,&p,&source_worker]).await?;
            let targets=if crate::wire::coercion::truthy(target.get("worktreeId")) {
                tx.query("SELECT w.id FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$1 AND s.worker_id=$2 AND s.removed_at IS NULL WHERE w.id=$3 AND w.lifecycle_state='ready' LIMIT 1",&[&p,&target_worker,&tree]).await?
            } else { vec![] };
            let model_found=if crate::wire::coercion::truthy(i.get("modelId")) {
                !tx.query("SELECT id FROM model_profiles WHERE owner_id=$1 AND id=$2 LIMIT 1",&[&o,&model]).await?.is_empty()
            } else {true};
            let routes=if crate::wire::coercion::truthy(i.get("modelRouteId")) {
                tx.query("SELECT to_jsonb(r)::text FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 WHERE r.id=$2 LIMIT 1",&[&o,&route]).await?
            } else {vec![]};
            let accounts=if crate::wire::coercion::truthy(i.get("providerAccountId")) {
                tx.query("SELECT to_jsonb(a)::text FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id AND p.owner_id=$1 WHERE a.id=$2 LIMIT 1",&[&o,&account]).await?
            } else {vec![]};
            let route_row=routes.first().map(raw).transpose()?;
            let account_row=accounts.first().map(raw).transpose()?;
            if projects.is_empty() {return Err(Error::NotFound("Project not found.".into()).into());}
            if sources.is_empty() {return Err(conflict("The source worker does not have a replica of this project."));}
            if target["projectId"]!=p.as_str() || target["projectReplicaId"].is_null() || target["worktreeId"].is_null() || !target["surface"].is_null() || targets.is_empty() {
                return Err(conflict("The selected destination is not a ready project worktree."));
            }
            if !model_found {return Err(conflict("The selected model profile was not found."));}
            if crate::wire::coercion::truthy(i.get("modelRouteId")) && (!crate::wire::coercion::truthy(i.get("modelId")) || route_row.as_ref().is_none_or(|r|r["model_id"]!=i["modelId"])) {
                return Err(conflict("The selected model route does not belong to the selected model profile."));
            }
            if crate::wire::coercion::truthy(i.get("providerAccountId")) && (route_row.is_none() || account_row.as_ref().is_none_or(|a|a["provider_id"]!=route_row.as_ref().unwrap()["provider_id"])) {
                return Err(conflict("The selected provider account does not belong to the selected model route."));
            }
            let id=uuid::Uuid::new_v4().to_string();
            let source_kind=text(&i["sourceKind"])?;let source_id=text(&i["sourceId"])?;let thread=text(&i["sourceThreadId"])?;
            let placement=target.stringify();let permission=optional(&i["permissionProfileId"])?;let plan=text(&i["planMode"])?;let progress=progress("queued",0,at).stringify();
            let rows=tx.query("INSERT INTO chat_import_jobs(id,owner_id,project_id,source_kind,source_worker_id,source_id,source_thread_id,target_placement,target_model_route_id,target_provider_account_id,requested_model_id,requested_permission_profile_id,requested_plan_mode,state,idempotency_key,payload_fingerprint,progress,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9,$10,$11,$12,$13,'queued',$14,$15,$16::text::jsonb,$17,$17,$17) RETURNING to_jsonb(chat_import_jobs)::text",&[&id,&o,&p,&source_kind,&source_worker,&source_id,&thread,&placement,&route,&account,&model,&permission,&plan,&k,&fp,&progress,&at]).await?;
            first(&rows)
        })).await;
        match result {
            Ok(row) => mapping::job(&row),
            Err(error) if unique(&error) => {
                let source_kind = text(&input["sourceKind"])?;
                let worker = text(&input["sourceWorkerId"])?;
                let source = text(&input["sourceId"])?;
                let thread = text(&input["sourceThreadId"])?;
                let rows=self.database.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE owner_id=$1 AND (idempotency_key=$2 OR (source_kind=$3 AND source_worker_id=$4 AND source_id=$5 AND source_thread_id=$6)) LIMIT 1",&[&owner,&key,&source_kind,&worker,&source,&thread]).await?;
                if let Some(row) = rows
                    .first()
                    .map(raw)
                    .transpose()?
                    .filter(|row| row["payload_fingerprint"] == fingerprint.as_str())
                {
                    return mapping::job(&row);
                }
                Err(conflict(
                    "This Codex chat already has a different import request.",
                ))
            }
            Err(error) => Err(error),
        }
    }
}
