use super::*;
impl ReplicaRepository {
    pub async fn operation_context(&self, job: &str, command: &str) -> Result<Option<Value>> {
        self.database.query("SELECT jsonb_build_object('linkPath',s.link_path,'ownershipKind',s.ownership_kind,'placementMode',s.placement_mode,'primaryWorktreeId',w.id,'repositoryFingerprint',s.repository_fingerprint,'requestedPath',s.requested_path,'sourcePath',s.absolute_path)::text FROM project_replica_jobs j INNER JOIN project_sources s ON s.id=j.project_replica_id AND s.removed_at IS NULL INNER JOIN project_worktrees w ON w.project_source_id=s.id AND w.is_primary=true WHERE j.id=$1 AND j.command_id=$2 AND j.state='running' LIMIT 1",&[&job,&command]).await?.first().map(raw).transpose()
    }
    pub async fn link_repair_context(
        &self,
        owner: &str,
        project: &str,
        replica: &str,
    ) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT jsonb_build_object('capabilities',w.project_replica_capabilities,'linkPath',s.link_path,'ownershipKind',s.ownership_kind,'placementMode',s.placement_mode,'repository',p.github_repository_full_name,'repositoryFingerprint',s.repository_fingerprint,'sourcePath',s.absolute_path,'workerId',s.worker_id)::text FROM project_sources s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 INNER JOIN workers w ON w.id=s.worker_id AND w.unlinked_at IS NULL WHERE p.id=$2 AND s.id=$3 AND s.removed_at IS NULL LIMIT 1",&[&owner,&project,&replica]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let row = raw(row)?;
        let mut result = Value::object(
            [
                "linkPath",
                "ownershipKind",
                "placementMode",
                "repository",
                "repositoryFingerprint",
                "sourcePath",
                "workerId",
            ]
            .into_iter()
            .map(|key| (key, copy(&row, key))),
        );
        result["workerSupportsRepair"] =
            Value::Bool(row["capabilities"]["managedLinkPlacement"] == true);
        Ok(Some(result))
    }
    pub async fn removal_blocker(
        &self,
        replica: &str,
        current_job: &str,
    ) -> Result<Option<String>> {
        let rows = self
            .database
            .query(
                "SELECT id FROM project_worktrees WHERE project_source_id=$1",
                &[&replica],
            )
            .await?;
        if rows.len() != 1 {
            return Ok(Some(
                "Remove managed worktrees from this replica before removing it.".into(),
            ));
        }
        let worktree = rows[0].get::<String>(0)?;
        if worktree.is_empty() {
            return Ok(Some("The replica has no Primary worktree record.".into()));
        }
        let queries = [
            (
                "SELECT id FROM chats WHERE active_worktree_id=$1 LIMIT 1",
                "A chat is still assigned to this replica.",
            ),
            (
                "SELECT id FROM terminals WHERE worktree_id=$1 LIMIT 1",
                "A terminal is still assigned to this replica.",
            ),
            (
                "SELECT id FROM explorers WHERE worktree_id=$1 LIMIT 1",
                "An Explorer is still assigned to this replica.",
            ),
            (
                "SELECT id FROM code_tabs WHERE worktree_id=$1 LIMIT 1",
                "A Code tab is still assigned to this replica.",
            ),
            (
                "SELECT id FROM project_views WHERE worktree_id=$1 LIMIT 1",
                "A project view is still assigned to this replica.",
            ),
            (
                "SELECT id FROM chat_execution_lanes WHERE worktree_id=$1 AND state<>'released' LIMIT 1",
                "An execution lane is still using this replica.",
            ),
        ];
        let references = futures::future::try_join_all(
            queries
                .iter()
                .map(|(sql, _)| async { self.database.query(sql, &[&worktree]).await }),
        );
        let jobs = async {
            self.database.query("SELECT id FROM project_replica_jobs WHERE project_replica_id=$1 AND id<>$2 AND state IN ('queued','running','blocked') LIMIT 1",&[&replica,&current_job]).await
        };
        let (references, jobs) = tokio::try_join!(references, jobs)?;
        for (rows, (_, message)) in references.iter().zip(queries) {
            if !rows.is_empty() {
                return Ok(Some(message.into()));
            }
        }
        Ok((!jobs.is_empty()).then(|| "Another replica job is still active.".into()))
    }
    pub async fn mark_removal_started(&self, replica: &str) -> Result<bool> {
        let at = crate::auth::now();
        Ok(self.database.query("UPDATE project_worktrees SET lifecycle_state='removing',updated_at=$2 WHERE project_source_id=$1 AND is_primary=true AND lifecycle_state IN ('ready','removing') RETURNING id",&[&replica,&at]).await?.len()==1)
    }
    pub async fn restore_removal_ready(&self, replica: &str) -> Result<()> {
        let at = crate::auth::now();
        self.database.query("UPDATE project_worktrees SET lifecycle_state='ready',updated_at=$2 WHERE project_source_id=$1 AND is_primary=true AND lifecycle_state='removing'",&[&replica,&at]).await?;
        Ok(())
    }
}
