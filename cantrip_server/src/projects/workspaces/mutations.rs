use super::*;
impl WorkspaceRepository {
    pub async fn create(
        &self,
        owner: &str,
        input: &Value,
        verified_attachment: bool,
    ) -> Result<Value> {
        let kind = input["storage"]["kind"].as_str();
        anyhow::ensure!(
            if verified_attachment {
                kind == Some("attached")
            } else {
                kind == Some("managed")
            },
            invariant(if verified_attachment {
                "Verified workspace attachment requires attached storage."
            } else {
                "Attached workspaces must be created through verified root attachment."
            })
        );
        super::super::folders::FolderRepository::new(self.database.clone())
            .ensure_default_workspace(owner)
            .await?;
        let rows = self.database.query("SELECT active_master_key_revision FROM account_encryption_profiles WHERE owner_id=$1 LIMIT 1", &[&owner]).await?;
        let profile = rows.first().ok_or_else(|| {
            invariant("Workspace encryption must be initialized before creating a workspace.")
        })?;
        anyhow::ensure!(
            input["nameProtection"]["keyRevision"] == json!(profile.get::<i32>(0)?),
            invariant("Workspace encryption key revision is not active.")
        );
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let last = tx.query("SELECT position FROM project_workspaces WHERE owner_id=$1 ORDER BY position DESC LIMIT 1", &[&owner]).await?;
            let position = (last.first().map(|r|r.get::<i32>(0)).transpose()?.map(i64::from).unwrap_or(-1)+1).to_string();
            let id=text(&input["id"])?;let name=&input["nameProtection"];let blind=text(&name["blindIndex"])?;let format=name["formatVersion"].stringify();let revision=name["keyRevision"].stringify();
            let rows=queries::annotate(tx.query("INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision,position,is_default) VALUES($1,$2,$3,$4,$5::text::integer,$6::text::integer,$7::text::integer,false) RETURNING to_jsonb(project_workspaces)::text", &[&id,&owner,&postgres_types::Json(&name["envelope"]),&blind,&format,&revision,&position]).await,"create",&[json!(id),json!(owner),json!(name["envelope"].stringify()),json!(blind),name["formatVersion"].clone(),name["keyRevision"].clone(),json!(position),json!(false)])?;
            let workspace=raw(rows.first().context("creating an encrypted project workspace")?)?;
            let storage=&input["storage"];let kind=text(&storage["kind"])?;
            let rows=if kind=="attached" {
                let worker=text(&storage["workerId"])?;let root=text(&storage["rootPathHandle"])?;let display=text(&storage["displayHandle"])?;
                queries::annotate(tx.query("INSERT INTO project_workspace_storage_profiles(workspace_id,kind,worker_id,protected_root_path_handle,protected_display_handle) VALUES($1,$2,$3,$4,$5) RETURNING to_jsonb(project_workspace_storage_profiles)::text", &[&id,&kind,&worker,&root,&display]).await,"attachedStorage",&[json!(id),json!(kind),json!(worker),json!(root),json!(display)])?
            }else{queries::annotate(tx.query("INSERT INTO project_workspace_storage_profiles(workspace_id,kind) VALUES($1,$2) RETURNING to_jsonb(project_workspace_storage_profiles)::text", &[&id,&kind]).await,"managedStorage",&[json!(id),json!(kind)])?};
            summary(&workspace,&raw(rows.first().context("creating workspace storage")?)?,vec![])
        })).await
    }
    pub async fn update(&self, owner: &str, id: &str, input: &Value) -> Result<Option<Value>> {
        if self
            .database
            .query(
                "SELECT id FROM project_workspaces WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&id, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        };
        let default = input["isDefault"] == true;
        if default {
            let rows=self.database.query("SELECT kind FROM project_workspace_storage_profiles WHERE workspace_id=$1 LIMIT 1", &[&id]).await?;
            anyhow::ensure!(
                rows.first()
                    .map(|r| r.get::<String>(0))
                    .transpose()?
                    .is_some_and(|kind| kind != "attached"),
                invariant("Attached workspaces cannot be the default workspace.")
            );
        }
        let name = input
            .get("nameProtection")
            .filter(|v| crate::wire::coercion::truthy(Some(v)));
        if let Some(name) = name {
            let rows=self.database.query("SELECT active_master_key_revision FROM account_encryption_profiles WHERE owner_id=$1 LIMIT 1", &[&owner]).await?;
            anyhow::ensure!(
                rows.first()
                    .map(|r| r.get::<i32>(0))
                    .transpose()?
                    .is_some_and(|revision| name["keyRevision"] == json!(revision)),
                invariant("Workspace encryption key revision is not active.")
            );
        }
        let (tx_owner, tx_id, input) = (owner.to_owned(), id.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let at=crate::auth::now();
            if default {tx.query("UPDATE project_workspaces SET is_default=false,revision=revision+1,updated_at=$3 WHERE owner_id=$1 AND is_default=true AND id<>$2", &[&tx_owner,&tx_id,&at]).await?;}
            let revision=input["expectedRevision"].stringify();
            let name=input.get("nameProtection").filter(|v|crate::wire::coercion::truthy(Some(v)));
            let rows=if let Some(name)=name {
                let blind=text(&name["blindIndex"])?;let format=name["formatVersion"].stringify();let key_revision=name["keyRevision"].stringify();
                tx.query("UPDATE project_workspaces SET name_envelope=$6,name_blind_index=$7,name_format_version=$8::text::integer,name_key_revision=$9::text::integer,is_default=CASE WHEN $4 THEN true ELSE is_default END,revision=revision+1,updated_at=$5 WHERE id=$1 AND owner_id=$2 AND revision=$3::text::integer RETURNING id", &[&tx_id,&tx_owner,&revision,&default,&at,&postgres_types::Json(&name["envelope"]),&blind,&format,&key_revision]).await?
            }else{tx.query("UPDATE project_workspaces SET is_default=CASE WHEN $4 THEN true ELSE is_default END,revision=revision+1,updated_at=$5 WHERE id=$1 AND owner_id=$2 AND revision=$3::text::integer RETURNING id", &[&tx_id,&tx_owner,&revision,&default,&at]).await?};
            anyhow::ensure!(!rows.is_empty(),invariant("Workspace revision changed before the update could be saved."));
            Ok(())
        })).await?;
        Ok(self.list(owner).await?["workspaces"]
            .as_array()
            .context("Workspace list")?
            .iter()
            .find(|v| v["id"] == json!(id))
            .cloned())
    }
}
