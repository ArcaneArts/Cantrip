//! Desktop creation retains the separate captured OS preparation and transaction.
use super::Repository;
use crate::{
    database::Executor,
    wire::{Value, coercion, value::json},
};
use anyhow::{Context, Result};
use postgres_types::Json;

impl Repository {
    pub async fn create_desktop(
        &self,
        owner: &str,
        project: &str,
        worker: &str,
        input: &Value,
        desktop_generation: Option<&Value>,
    ) -> Result<Option<Value>> {
        let mut configuration = json!({"kind":"desktop"});
        if coercion::truthy(input.get("cantripOsBindingId")) {
            let generation = desktop_generation
                .filter(|v| coercion::truthy(Some(v)))
                .context(crate::cantrip_os::PlacementError(
                    "A new Linux desktop view requires its observed desktop generation.",
                ))?;
            let binding = input["cantripOsBindingId"]
                .as_str()
                .context("OS desktop binding")?;
            let source = crate::cantrip_os::Repository {
                database: self.database.clone(),
            }
            .binding_context(owner, binding)
            .await?
            .filter(|source| {
                source["available"] == true
                    && source["binding"]["projectId"] == project
                    && source["instance"]["workerId"] == worker
            })
            .context(crate::cantrip_os::PlacementError(
                "The selected desktop source is unavailable.",
            ))?;
            let tree = source["binding"]["worktreeId"]
                .as_str()
                .context("OS desktop worktree")?;
            let captured = crate::cantrip_os::files::capture(
                Executor::Database(&self.database),
                owner,
                project,
                tree,
                binding,
                input["cantripOsRuntimeGeneration"]
                    .as_str()
                    .context("OS runtime generation")?,
            )
            .await?;
            let os_source = crate::settings::parse_response(
                "remoteDesktopOsSourceSchema",
                Some(
                    &json!({"bindingId":captured["binding_id"],"worktreeId":tree,"bindingGeneration":captured["binding_generation"],"attachmentGeneration":captured["attachment_generation"],"runtimeGeneration":captured["runtime_generation"],"desktopGeneration":generation}),
                ),
            )?;
            configuration["osSource"] = os_source;
        }
        if !self.creation_owned(owner, project, worker).await? {
            return Ok(None);
        };
        let position = crate::project_layout::next_position(&self.database, project).await?;
        let (owner, project, worker, input) = (
            owner.to_owned(),
            project.to_owned(),
            worker.to_owned(),
            input.clone(),
        );
        let id = input["id"].as_str().context("Desktop identity")?.to_owned();
        let (lookup_owner, lookup_id) = (owner.clone(), id.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let title=Json(&input["titleProtection"]);let state=Json(&input["stateProtection"]);let configuration=Json(&configuration);
            tx.query("INSERT INTO project_views(id,project_id,protected_label,kind,worktree_id,position) VALUES($1,$2,$3,'remote-desktop',NULL,$4::bigint)",&[&id,&project,&title,&position]).await?;
            tx.query("INSERT INTO remote_surfaces(id,project_id,worker_id,kind,preferred_transport,configuration,protected_state,state_revision) VALUES($1,$2,$3,'desktop','webrtc',$4,$5,1)",&[&id,&project,&worker,&configuration,&state]).await?;
            crate::pane_layouts::attach_entity(tx,&project,&input["id"],"project.remote-desktop",&input).await?;
            Ok(())
        })).await?;
        self.desktop(&lookup_owner, &lookup_id).await
    }
}
