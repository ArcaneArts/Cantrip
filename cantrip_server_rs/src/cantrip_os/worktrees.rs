use super::{Repository, decode, summary, text, uuid};
use anyhow::{Context, Result, ensure};
use postgres_types::Json;
use serde_json::{Value, json};

impl Repository {
    /// One client operation UUID identifies one metadata admission. Guest Git
    /// runs later through the existing protected, durable provisioning path.
    pub(super) async fn create_worktree(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
    ) -> Result<Value> {
        let (owner, project, input) = (owner.to_owned(), project.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let rows=decode(tx.query("SELECT jsonb_build_object('binding',to_jsonb(b),'source',to_jsonb(s),'workspace',to_jsonb(w),'instance',to_jsonb(i))::text FROM cantrip_os_source_bindings b JOIN cantrip_os_project_sources s ON s.id=b.project_source_id AND s.workspace_id=b.workspace_id AND s.source_kind='git' AND s.removed_at IS NULL JOIN project_source_identities x ON x.id=s.id AND x.project_id=$2 AND x.worker_id=b.worker_id AND x.location_kind='cantrip-os' JOIN projects p ON p.id=$2 AND p.owner_id=$1 AND p.git_capability=true JOIN cantrip_os_workspaces w ON w.id=b.workspace_id JOIN cantrip_os_instances i ON i.id=w.instance_id AND i.owner_id=$1 AND i.worker_id=b.worker_id JOIN workers a ON a.id=i.worker_id AND a.owner_id=$1 AND a.unlinked_at IS NULL WHERE b.id=$3 AND b.owner_id=$1 AND b.project_id=$2 AND b.mode='linux-owned' AND b.retired_at IS NULL FOR UPDATE", &[&owner,&project,&text(&input,"sourceBindingId")?]).await?)?;
            let parent=rows.first().context("The selected Linux-owned Git source is unavailable.")?;
            let (b,s,w,i)=(&parent["binding"],&parent["source"],&parent["workspace"],&parent["instance"]);
            let admission=text(&input,"operationId")?;
            let existing=decode(tx.query("SELECT to_jsonb(b)::text FROM cantrip_os_source_bindings b WHERE id=$1", &[&admission]).await?)?;
            if let Some(old)=existing.first() {
                let expected=format!("{}/worktrees/{}",text(w,"home_guest_path")?,text(old,"worktree_id")?);
                ensure!(old["owner_id"]==owner && old["project_id"]==project && old["project_source_id"]==s["id"] && old["workspace_id"]==w["id"] && old["worker_id"]==i["worker_id"] && old["mode"]=="linux-owned" && old["retired_at"].is_null() && old["guest_path"]==expected,"This worktree admission belongs to a different source or workspace.");
                return summary(old,"binding",Some(text(i,"id")?));
            }
            ensure!(i["status"]=="connected" && i["runtime_generation"]==input["expectedRuntimeGeneration"] && b["state"]=="ready" && b["provisioned_runtime_generation"]==input["expectedRuntimeGeneration"] && b["provisioned_attachment_generation"]==i["attachment_generation"],"Verify this Linux source in its current runtime before creating a worktree.");
            let tree=uuid();
            let guest=format!("{}/worktrees/{tree}",text(w,"home_guest_path")?);
            let values=Json(json!({"id":admission,"tree":tree,"source":s["id"],"workspace":w["id"],"owner":owner,"project":project,"worker":i["worker_id"],"guest":guest,"generation":uuid(),"name":format!("Linux worktree {}",&tree[..8])}));
            tx.query("INSERT INTO project_worktrees(id,project_source_id,worker_id,location_kind,guest_path,display_path,root_kind,name,is_primary,is_default,origin,lifecycle_state) VALUES($1::jsonb->>'tree',$1::jsonb->>'source',$1::jsonb->>'worker','cantrip-os',$1::jsonb->>'guest',$1::jsonb->>'tree','git-worktree',$1::jsonb->>'name',false,false,'cantrip','creating')", &[&values]).await?;
            let rows=decode(tx.query("INSERT INTO cantrip_os_source_bindings(id,owner_id,project_id,worker_id,project_source_id,worktree_id,workspace_id,mode,guest_path,binding_generation,state) VALUES($1::jsonb->>'id',$1::jsonb->>'owner',$1::jsonb->>'project',$1::jsonb->>'worker',$1::jsonb->>'source',$1::jsonb->>'tree',$1::jsonb->>'workspace','linux-owned',$1::jsonb->>'guest',$1::jsonb->>'generation','provisioning') RETURNING to_jsonb(cantrip_os_source_bindings)::text", &[&values]).await?)?;
            summary(&rows[0],"binding",Some(text(i,"id")?))
        })).await
    }
}
