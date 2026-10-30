//! Feature-owned tunnels preserve the source's separate read/write boundaries.
use super::management::{Bindings, ManagementError};
use super::*;

impl Repository {
    pub async fn register_managed(
        &self,
        owner: &str,
        input: &Value,
        protected: Option<&Value>,
    ) -> Result<Option<Value>> {
        let source = &input["source"];
        let destination = &input["destination"];
        if (source["kind"] == "worker-listener" || destination["kind"] == "worker-tcp")
            && protected.is_none()
        {
            return Err(
                ManagementError("Private tunnel endpoints require protected content.").into(),
            );
        }
        let project = optional(input, "projectId")?;
        if !self
            .references_owned(owner, project.as_deref(), source, destination)
            .await?
        {
            return Ok(None);
        }
        let kind = text(&input["managedBy"], "kind")?;
        let managed_id = text(&input["managedBy"], "id")?;
        let rows = self.database.query("SELECT id,protected_operation_id,protected_revision FROM tunnels WHERE owner_id=$1 AND managed_by_kind=$2 AND managed_by_id=$3 LIMIT 1",&[&owner,&kind,&managed_id]).await?;
        let existing = rows.first();
        let provided_id = protected.map(|v| optional(v, "id")).transpose()?.flatten();
        if let Some(row) = existing
            && provided_id.as_ref().is_some_and(|id| !id.is_empty())
            && provided_id.as_deref() != Some(row.get::<String>(0)?.as_str())
        {
            return Err(ManagementError("Managed tunnel identity is stale.").into());
        }
        if let Some(protected) = protected {
            let record = &protected["protectedRecord"];
            let expected = existing
                .map(|row| row.get::<i32>(2))
                .transpose()?
                .map_or(1.0, |revision| f64::from(revision) + 1.0);
            // An absent existing row has undefined operation identity in JS,
            // which is distinct from a persisted NULL operation identity.
            let previous = existing
                .map(|row| row.get::<Option<String>>(1).map(|v| json!(v)))
                .transpose()?;
            if record["revision"].as_f64() != Some(expected)
                || record.get("operationId") == previous.as_ref()
            {
                return Err(
                    ManagementError("Tunnel protected content has a stale revision.").into(),
                );
            }
        }
        let adapter = destination["kind"] == "worker-adapter";
        let mut fields = vec![
            ("project_id", project, "text"),
            ("origin", Some(text(input, "origin")?), "text"),
            ("management", Some(text(input, "management")?), "text"),
            ("protocol_hint", Some(text(input, "protocolHint")?), "text"),
            ("source_kind", Some(text(source, "kind")?), "text"),
            ("source_adapter", None, "text"),
            (
                "source_worker_id",
                if source["kind"] == "worker-listener" {
                    optional(source, "workerId")?
                } else {
                    None
                },
                "text",
            ),
            ("destination_kind", Some(text(destination, "kind")?), "text"),
            (
                "destination_adapter",
                if adapter {
                    optional(destination, "adapter")?
                } else {
                    None
                },
                "text",
            ),
            (
                "destination_resource_id",
                if adapter {
                    optional(destination, "resourceId")?
                } else {
                    None
                },
                "text",
            ),
            (
                "destination_worker_id",
                Some(text(destination, "workerId")?),
                "text",
            ),
            ("managed_by_kind", Some(kind), "text"),
            ("managed_by_id", Some(managed_id), "text"),
            ("desired_state", Some(text(input, "desiredState")?), "text"),
            ("status", Some(text(input, "status")?), "text"),
            ("error_code", None, "text"),
            (
                "updated_at",
                Some(crate::auth::iso(self.now())),
                "timestamptz",
            ),
        ];
        if let Some(protected) = protected {
            let record = &protected["protectedRecord"];
            fields.extend([
                (
                    "protected_content",
                    Some(serde_json::to_string(&record["protectedContent"])?),
                    "jsonb",
                ),
                (
                    "protected_operation_id",
                    optional(record, "operationId")?,
                    "text",
                ),
                (
                    "protected_revision",
                    Some(
                        coercion::string(&record["revision"])
                            .expect("numeric revision")
                            .lossy()
                            .into_owned(),
                    ),
                    "integer",
                ),
            ]);
        }
        let id = if let Some(row) = existing {
            row.get::<String>(0)?
        } else {
            provided_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
        };
        let mut bindings = Bindings::default();
        if existing.is_some() {
            let assignments = fields
                .into_iter()
                .map(|(column, value, cast)| format!("{column}={}", bindings.add(value, cast)))
                .collect::<Vec<_>>()
                .join(",");
            let id_parameter = bindings.add(Some(id.clone()), "text");
            // The source writes by the selected ID, without adding a revision,
            // owner or management fence after the pre-write snapshot.
            self.database
                .query(
                    &format!("UPDATE tunnels SET {assignments} WHERE id={id_parameter}"),
                    &bindings.params(),
                )
                .await?;
        } else {
            fields.extend([
                ("id", Some(id.clone()), "text"),
                ("owner_id", Some(owner.to_owned()), "text"),
                (
                    "position",
                    Some(self.next_position(owner).await?.to_string()),
                    "integer",
                ),
            ]);
            let columns = fields
                .iter()
                .map(|(column, _, _)| *column)
                .collect::<Vec<_>>()
                .join(",");
            let values = fields
                .into_iter()
                .map(|(_, value, cast)| bindings.add(value, cast))
                .collect::<Vec<_>>()
                .join(",");
            self.database
                .query(
                    &format!("INSERT INTO tunnels ({columns}) VALUES ({values})"),
                    &bindings.params(),
                )
                .await?;
        }
        self.get(owner, &id).await
    }

    pub async fn get_managed(&self, owner: &str, managed_by: &Value) -> Result<Option<Value>> {
        let kind = text(managed_by, "kind")?;
        let id = text(managed_by, "id")?;
        let rows = self.database.query("SELECT id FROM tunnels WHERE owner_id=$1 AND management<>'user-managed' AND managed_by_kind=$2 AND managed_by_id=$3 LIMIT 1",&[&owner,&kind,&id]).await?;
        match rows.first() {
            Some(row) => self.get(owner, &row.get::<String>(0)?).await,
            None => Ok(None),
        }
    }

    pub async fn remove_managed(&self, owner: &str, managed_by: &Value) -> Result<bool> {
        let kind = text(managed_by, "kind")?;
        let id = text(managed_by, "id")?;
        Ok(self.database.query("DELETE FROM tunnels WHERE owner_id=$1 AND management<>'user-managed' AND managed_by_kind=$2 AND managed_by_id=$3 RETURNING id",&[&owner,&kind,&id]).await?.len()==1)
    }
}
