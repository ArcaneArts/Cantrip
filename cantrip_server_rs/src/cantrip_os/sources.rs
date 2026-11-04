use super::{Repository, checked, decode, summary, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Repository {
    pub async fn create_binding(&self, owner: &str, project: &str, input: &Value) -> Result<Value> {
        if input["mode"] == "linux-worktree" {
            return self.create_worktree(owner, project, input).await;
        }
        let (owner, project, input) = (owner.to_owned(), project.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let target=decode(tx.query("SELECT jsonb_build_object('workspace',to_jsonb(w),'instance',to_jsonb(i),'git',p.git_capability)::text FROM cantrip_os_workspaces w JOIN cantrip_os_instances i ON i.id=w.instance_id JOIN projects p ON p.id=$3 AND p.owner_id=i.owner_id JOIN workers a ON a.id=i.worker_id AND a.owner_id=$1 AND a.unlinked_at IS NULL WHERE w.id=$2 AND i.owner_id=$1 FOR UPDATE OF w,i,p", &[&owner,&text(&input,"workspaceId")?,&project]).await?)?;
            let target=target.first().context("Project and OS workspace must share an owner.")?;
            let instance=&target["instance"];let workspace=&target["workspace"];
            let worker=text(instance,"worker_id")?;
            let binding=uuid();let generation=uuid();
            let (source,worktree,guest,linked)=if input["mode"]=="linked" {
                ensure!(instance["transport"]["kind"]=="docker","Linked checkouts require Docker on the owning worker.");
                let rows=decode(tx.query("SELECT jsonb_build_object('source',to_jsonb(s),'worktree',to_jsonb(t))::text FROM project_worktrees t JOIN project_sources s ON s.id=t.project_source_id AND s.removed_at IS NULL JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE t.id=$2 AND s.project_id=$3 AND t.worker_id=$4 AND t.lifecycle_state='ready' FOR UPDATE OF t,s", &[&owner,&text(&input,"worktreeId")?,&project,&worker]).await?)?;
                let row=rows.first().context("Linked worktree not found in this project.")?;
                (row["source"]["id"].clone(),row["worktree"]["id"].clone(),format!("/workspace/{binding}"),row["worktree"]["absolute_path"].clone())
            } else {
                ensure!((input["sourceKind"]=="git")==target["git"].as_bool().unwrap_or(false),"Linux source kind must preserve the project Git capability.");
                let source=uuid();let worktree=uuid();
                let guest=format!("{}/checkouts/{source}",text(workspace,"home_guest_path")?);
                let values=Json(json!({"source":source,"worktree":worktree,"project":project,"worker":worker,"workspace":workspace["id"],"kind":input["sourceKind"],"guest":guest}));
                tx.query("INSERT INTO project_source_identities(id,project_id,worker_id,location_kind) VALUES($1::jsonb->>'source',$1::jsonb->>'project',$1::jsonb->>'worker','cantrip-os')", &[&values]).await?;
                tx.query("INSERT INTO cantrip_os_project_sources(id,workspace_id,source_kind,guest_path,ownership_kind) VALUES($1::jsonb->>'source',$1::jsonb->>'workspace',$1::jsonb->>'kind',$1::jsonb->>'guest','cantrip')", &[&values]).await?;
                tx.query("INSERT INTO project_worktrees(id,project_source_id,worker_id,location_kind,guest_path,display_path,root_kind,name,is_primary,is_default,origin,lifecycle_state) VALUES($1::jsonb->>'worktree',$1::jsonb->>'source',$1::jsonb->>'worker','cantrip-os',$1::jsonb->>'guest',$1::jsonb->>'source',CASE WHEN $1::jsonb->>'kind'='git' THEN 'git-worktree' ELSE 'folder-root' END,'Primary',true,true,'cantrip','creating')", &[&values]).await?;
                (json!(source),json!(worktree),guest,Value::Null)
            };
            let values=Json(json!({"id":binding,"owner":owner,"project":project,"worker":worker,"source":source,"worktree":worktree,"workspace":workspace["id"],"mode":input["mode"],"linked":linked,"guest":guest,"generation":generation,"overlays":input.get("dependencyOverlays").cloned().unwrap_or_else(||json!([]))}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_source_bindings(id,owner_id,project_id,worker_id,project_source_id,worktree_id,workspace_id,mode,linked_worker_path,guest_path,binding_generation,state,dependency_overlays) VALUES($1::jsonb->>'id',$1::jsonb->>'owner',$1::jsonb->>'project',$1::jsonb->>'worker',$1::jsonb->>'source',$1::jsonb->>'worktree',$1::jsonb->>'workspace',$1::jsonb->>'mode',$1::jsonb->>'linked',$1::jsonb->>'guest',$1::jsonb->>'generation','provisioning',$1::jsonb->'overlays') RETURNING to_jsonb(cantrip_os_source_bindings)::text", &[&values]).await?)?;
            summary(&rows[0],"binding",Some(text(instance,"id")?))
        })).await
    }

    pub async fn admission(&self, owner: &str, project: &str, id: &str) -> Result<Option<Value>> {
        self.context(owner, project, id).await?;
        Ok(self.rows("SELECT to_jsonb(a)::text FROM cantrip_os_provision_admissions a WHERE binding_id=$1", &[&id]).await?.into_iter().next())
    }

    pub async fn admit(&self, owner: &str, scope: &Value, input: &Value) -> Result<(Value, bool)> {
        checked("cantripOsSourceDispatchScopeSchema", scope.clone())?;
        let (owner, scope, input) = (owner.to_owned(), scope.clone(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let rows=decode(tx.query("SELECT jsonb_build_object('binding',to_jsonb(b),'instance',to_jsonb(i))::text FROM cantrip_os_source_bindings b JOIN cantrip_os_workspaces w ON w.id=b.workspace_id JOIN cantrip_os_instances i ON i.id=w.instance_id WHERE b.id=$1 AND b.owner_id=$2 AND b.retired_at IS NULL FOR UPDATE OF b,i", &[&text(&scope,"bindingId")?,&owner]).await?)?;
            let current=rows.first().context("Source binding not found.")?;
            ensure!(current["binding"]["binding_generation"]==input["bindingGeneration"] && scope["bindingGeneration"]==input["bindingGeneration"],"Source binding changed before provisioning admission.");
            let existing=decode(tx.query("SELECT to_jsonb(a)::text FROM cantrip_os_provision_admissions a WHERE binding_id=$1", &[&text(&scope,"bindingId")?]).await?)?;
            if let Some(old)=existing.first() {
                ensure!(old["operation_id"]==input["operationId"] && old["protected_request"]==input["protectedRequest"],"This binding already has a provisioning admission; inspect its existing operation.");
                return Ok((old.clone(),false));
            }
            ensure!(current["instance"]["status"]=="connected" && current["instance"]["attachment_generation"]==scope["attachmentGeneration"] && current["instance"]["runtime_generation"]==scope["runtimeGeneration"] && current["binding"]["worker_id"]==scope["workerId"] && scope["ownerId"]==owner,"OS placement changed before provisioning admission.");
            let values=Json(json!({"operation":input["operationId"],"binding":scope["bindingId"],"scope":scope,"request":input["protectedRequest"]}));
            let rows=decode(tx.query("INSERT INTO cantrip_os_provision_admissions(operation_id,binding_id,scope,protected_request) VALUES($1::jsonb->>'operation',$1::jsonb->>'binding',$1::jsonb->'scope',$1::jsonb->'request') RETURNING to_jsonb(cantrip_os_provision_admissions)::text", &[&values]).await?)?;
            Ok((rows[0].clone(),true))
        })).await
    }

    pub async fn outcome(
        &self,
        owner: &str,
        scope: &Value,
        state: &str,
        error: Option<&str>,
        receipt: Option<&Value>,
    ) -> Result<Value> {
        let (owner, scope, state, error, receipt) = (
            owner.to_owned(),
            scope.clone(),
            state.to_owned(),
            error.map(str::to_owned),
            receipt.cloned(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let rows=decode(tx.query("SELECT jsonb_build_object('binding',to_jsonb(b),'instance',to_jsonb(i),'workspace',to_jsonb(w))::text FROM cantrip_os_source_bindings b JOIN cantrip_os_workspaces w ON w.id=b.workspace_id JOIN cantrip_os_instances i ON i.id=w.instance_id WHERE b.id=$1 AND b.owner_id=$2 AND b.retired_at IS NULL FOR UPDATE OF b,i,w", &[&text(&scope,"bindingId")?,&owner]).await?)?;
            let current=rows.first().context("Source binding not found.")?;
            let b=&current["binding"];let i=&current["instance"];let w=&current["workspace"];
            ensure!(b["binding_generation"]==scope["bindingGeneration"] && i["attachment_generation"]==scope["attachmentGeneration"] && i["runtime_generation"]==scope["runtimeGeneration"],"OS placement changed before provisioning outcome arrived.");
            if let Some(r)=&receipt {
                checked("cantripOsSourceReceiptSchema",r.clone())?;
                ensure!(r["bindingId"]==b["id"] && r["workspaceId"]==w["id"] && r["runtimeGeneration"]==i["runtime_generation"] && r["guestPath"]==b["guest_path"] && r["mode"]==b["mode"] && r["uid"]==w["uid"] && r["homeGuestPath"]==w["home_guest_path"] && r["guestWorkspaceId"]==w["guest_workspace_id"] && r["dependencyOverlays"]==b["dependency_overlays"],"Source observation does not match the admitted placement.");
            }
            let values=Json(json!({"id":b["id"],"state":state,"error":error,"attachment":if state=="ready" {scope["attachmentGeneration"].clone()}else{Value::Null},"runtime":if state=="ready" {scope["runtimeGeneration"].clone()}else{Value::Null}}));
            let rows=decode(tx.query("UPDATE cantrip_os_source_bindings SET state=$1::jsonb->>'state',last_error=left($1::jsonb->>'error',4000),provisioned_attachment_generation=$1::jsonb->>'attachment',provisioned_runtime_generation=$1::jsonb->>'runtime',updated_at=now() WHERE id=$1::jsonb->>'id' RETURNING to_jsonb(cantrip_os_source_bindings)::text", &[&values]).await?)?;
            if state=="ready" && b["mode"]=="linux-owned" {
                let r=receipt.context("Ready Linux source requires an observation.")?;
                let sources=decode(tx.query("SELECT to_jsonb(s)::text FROM cantrip_os_project_sources s WHERE id=$1 AND removed_at IS NULL FOR UPDATE", &[&text(b,"project_source_id")?]).await?)?;
                let source=sources.first().context("Linux source was removed before its observation arrived.")?;
                ensure!((source["repository_fingerprint"].is_null() || source["repository_fingerprint"]==r["repositoryFingerprint"]) && (source["source_kind"]!="git" || (r["repositoryFingerprint"].is_string() && r["head"].is_string() && r["gitCommonGuestPath"].is_string())),"Linux Git observation belongs to a different common directory or is incomplete.");
                let r=Json(r);
                tx.query("UPDATE cantrip_os_project_sources SET repository_fingerprint=$2::jsonb->>'repositoryFingerprint',updated_at=now() WHERE id=$1", &[&text(b,"project_source_id")?,&r]).await?;
                tx.query("UPDATE project_worktrees SET lifecycle_state='ready',head=$2::jsonb->>'head',branch=$2::jsonb->>'branch',detached=($2::jsonb->>'detached')::boolean,updated_at=now() WHERE id=$1", &[&text(b,"worktree_id")?,&r]).await?;
            }
            summary(&rows[0],"binding",Some(text(i,"id")?))
        })).await
    }
}
