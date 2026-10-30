use super::catalog::{source, summary, tunnel_returning};
use super::*;
use postgres_types::ToSql;

#[derive(Debug)]
pub struct ManagementError(pub &'static str);
impl std::fmt::Display for ManagementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ManagementError {}

// Text bindings let PostgreSQL perform integer range checks, including owner
// positions at i32::MAX. Do not wrap or reject them in a Rust-only preflight.
#[derive(Default)]
pub(super) struct Bindings(Vec<Option<String>>);
impl Bindings {
    pub(super) fn add(&mut self, value: Option<String>, cast: &str) -> String {
        self.0.push(value);
        format!("${}::text::{cast}", self.0.len())
    }
    pub(super) fn params(&self) -> Vec<&(dyn ToSql + Sync)> {
        self.0.iter().map(|v| v as &(dyn ToSql + Sync)).collect()
    }
}
impl Repository {
    pub(super) async fn next_position(&self, owner: &str) -> Result<i64> {
        Ok(self
            .database
            .query(
                "SELECT position FROM tunnels WHERE owner_id=$1 ORDER BY position DESC LIMIT 1",
                &[&owner],
            )
            .await?
            .first()
            .map(|r| r.get::<i32>(0))
            .transpose()?
            .map_or(0, |v| i64::from(v) + 1))
    }
    async fn guard_user(&self, tunnel: &Value, editing: bool) -> Result<()> {
        if tunnel["management"] != "user-managed" {
            return Err(
                ManagementError("Managed tunnels are controlled by their owning feature.").into(),
            );
        }
        let id = text(tunnel, "id")?;
        if !self.database.query("SELECT id FROM tunnel_attachments WHERE tunnel_id=$1 AND status NOT IN ('stopped','failed') LIMIT 1",&[&id]).await?.is_empty() {
            return Err(ManagementError(if editing {"Stop every tunnel attachment before editing this tunnel."} else {"Stop every tunnel attachment before deleting this tunnel."}).into());
        }
        Ok(())
    }
    pub async fn create_user(&self, owner: &str, input: &Value) -> Result<Option<Value>> {
        let project = optional(input, "projectId")?;
        if !self
            .references_owned(
                owner,
                project.as_deref(),
                &json!({"kind":"desktop-loopback"}),
                &input["destination"],
            )
            .await?
        {
            return Ok(None);
        }
        let position = self.next_position(owner).await?;
        let mut bindings = Bindings::default();
        let fields = [
            ("id", Some(text(input, "id")?), "text"),
            ("owner_id", Some(owner.to_owned()), "text"),
            ("project_id", project, "text"),
            ("position", Some(position.to_string()), "integer"),
            ("origin", Some("user".into()), "text"),
            ("management", Some("user-managed".into()), "text"),
            ("protocol_hint", Some(text(input, "protocolHint")?), "text"),
            ("source_kind", Some("desktop-loopback".into()), "text"),
            ("source_adapter", None, "text"),
            ("source_worker_id", None, "text"),
            (
                "destination_kind",
                Some(text(&input["destination"], "kind")?),
                "text",
            ),
            ("destination_adapter", None, "text"),
            ("destination_resource_id", None, "text"),
            (
                "destination_worker_id",
                Some(text(&input["destination"], "workerId")?),
                "text",
            ),
            (
                "protected_content",
                Some(serde_json::to_string(
                    &input["protectedRecord"]["protectedContent"],
                )?),
                "jsonb",
            ),
            (
                "protected_operation_id",
                Some(text(&input["protectedRecord"], "operationId")?),
                "text",
            ),
            (
                "protected_revision",
                Some(
                    coercion::string(&input["protectedRecord"]["revision"])
                        .expect("numeric revision")
                        .lossy()
                        .into_owned(),
                ),
                "integer",
            ),
            ("managed_by_kind", None, "text"),
            ("managed_by_id", None, "text"),
            ("desired_state", Some("stopped".into()), "text"),
            ("status", Some("stopped".into()), "text"),
        ];
        let columns = fields
            .iter()
            .map(|(key, _, _)| *key)
            .collect::<Vec<_>>()
            .join(",");
        let values = fields
            .into_iter()
            .map(|(_, value, cast)| bindings.add(value, cast))
            .collect::<Vec<_>>()
            .join(",");
        let rows = self
            .database
            .query(
                &tunnel_returning(&format!(
                    "INSERT INTO tunnels ({columns}) VALUES ({values})"
                )),
                &bindings.params(),
            )
            .await?;
        let row = rows
            .first()
            .context("Expected a row while creating a tunnel.")?;
        summary(&raw(row, 0)?, &[]).map(Some)
    }
    pub async fn update_user(&self, owner: &str, id: &str, input: &Value) -> Result<Option<Value>> {
        let Some(existing) = self.catalog_row(owner, id).await? else {
            return Ok(None);
        };
        self.guard_user(&existing, true).await?;
        let protected = &input["protectedRecord"];
        if protected["revision"].as_f64()
            != existing["protected_revision"].as_f64().map(|v| v + 1.0)
            || protected["operationId"] == existing["protected_operation_id"]
        {
            return Err(ManagementError("Tunnel protected content has a stale revision.").into());
        }
        let project = if input.get("projectId").is_some() {
            optional(input, "projectId")?
        } else {
            optional(&existing, "project_id")?
        };
        let source = source(&existing)?;
        let destination = input
            .get("destination")
            .filter(|v| !v.is_null())
            .cloned()
            .map_or_else(|| destination(&existing), Ok)?;
        if !self
            .references_owned(owner, project.as_deref(), &source, &destination)
            .await?
        {
            return Ok(None);
        }
        let mut bindings = Bindings::default();
        let mut set = Vec::new();
        if input.get("projectId").is_some() {
            set.push(format!("project_id={}", bindings.add(project, "text")));
        }
        if input.get("protocolHint").is_some() {
            set.push(format!(
                "protocol_hint={}",
                bindings.add(optional(input, "protocolHint")?, "text")
            ));
        }
        if input.get("destination").is_some() {
            let adapter = destination["kind"] == "worker-adapter";
            for (field, value) in [
                ("destination_kind", Some(text(&destination, "kind")?)),
                (
                    "destination_adapter",
                    if adapter {
                        optional(&destination, "adapter")?
                    } else {
                        None
                    },
                ),
                (
                    "destination_resource_id",
                    if adapter {
                        optional(&destination, "resourceId")?
                    } else {
                        None
                    },
                ),
                (
                    "destination_worker_id",
                    Some(text(&destination, "workerId")?),
                ),
            ] {
                set.push(format!("{field}={}", bindings.add(value, "text")));
            }
        }
        for (field, value, cast) in [
            (
                "protected_content",
                Some(serde_json::to_string(&protected["protectedContent"])?),
                "jsonb",
            ),
            (
                "protected_operation_id",
                Some(text(protected, "operationId")?),
                "text",
            ),
            (
                "protected_revision",
                Some(
                    coercion::string(&protected["revision"])
                        .expect("numeric revision")
                        .lossy()
                        .into_owned(),
                ),
                "integer",
            ),
            (
                "updated_at",
                Some(crate::auth::iso(self.now())),
                "timestamptz",
            ),
        ] {
            set.push(format!("{field}={}", bindings.add(value, cast)));
        }
        let id_parameter = bindings.add(Some(id.to_owned()), "text");
        let owner_parameter = bindings.add(Some(owner.to_owned()), "text");
        let rows = self.database.query(&tunnel_returning(&format!("UPDATE tunnels SET {} WHERE id={id_parameter} AND owner_id={owner_parameter} AND management='user-managed'",set.join(","))),&bindings.params()).await?;
        if rows.is_empty() {
            return Ok(None);
        }
        self.get(owner, id).await
    }
    pub async fn delete_user(&self, owner: &str, id: &str) -> Result<bool> {
        // The reference deletion only reads management, not the complete
        // projection. Keep it usable even when unrelated metadata is invalid.
        let rows = self
            .database
            .query(
                "SELECT management FROM tunnels WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&id, &owner],
            )
            .await?;
        let Some(row) = rows.first() else {
            return Ok(false);
        };
        self.guard_user(&json!({"id":id,"management":row.get::<String>(0)?}), false)
            .await?;
        Ok(self.database.query("DELETE FROM tunnels WHERE id=$1 AND owner_id=$2 AND management='user-managed' RETURNING id",&[&id,&owner]).await?.len()==1)
    }
}
