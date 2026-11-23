//! Captured Linux service authority; no transport is taken from client frames.
use super::*;

impl Repository {
    pub(crate) async fn os_execution(
        &self,
        owner: &str,
        tunnel: &str,
        project: Option<&str>,
        destination: &Value,
        source: &Value,
        capture: &Value,
    ) -> Result<Option<Value>> {
        let incoming =
            destination["kind"] == "worker-adapter" && destination["adapter"] == "cantrip-os";
        let outgoing = source["kind"] == "worker-listener" && !capture.is_null();
        if !incoming && !outgoing {
            if !capture.is_null() {
                return Err(ManagementError("Host tunnels cannot capture an OS source.").into());
            }
            return Ok(None);
        }
        if capture.is_null()
            || project.is_none()
            || (if outgoing {
                destination["kind"] != "worker-tcp" || destination["workerId"] != source["workerId"]
            } else {
                source["kind"] != "desktop-loopback"
                    || !incoming
                    || destination["resourceId"] != tunnel
            })
        {
            return Err(ManagementError(
                "The OS tunnel source capture or direction is incomplete.",
            )
            .into());
        }
        let captured = serde_json::json!({
            "binding_id":text(capture,"bindingId")?,
            "binding_generation":text(capture,"bindingGeneration")?,
            "attachment_generation":text(capture,"attachmentGeneration")?,
            "runtime_generation":text(capture,"runtimeGeneration")?,
        });
        crate::cantrip_os::files::root(crate::database::Executor::Database(&self.database), owner,
            project.unwrap(), &text(capture,"worktreeId")?, &text(destination,"workerId")?, &captured)
            .await.map(Some).map_err(|_| ManagementError("The captured OS tunnel source is unavailable or changed; no Host fallback was attempted.").into())
    }

    pub async fn os_attachment_execution(&self, auth: &Value) -> Result<Option<Value>> {
        let source = auth
            .get("source")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!({"kind":"desktop-loopback"}));
        self.os_execution(
            &text(auth, "ownerId")?,
            &text(auth, "tunnelId")?,
            optional(auth, "projectId")?.as_deref(),
            &auth["destination"],
            &source,
            &auth["osSource"],
        )
        .await
    }

    pub async fn pin_os_service_identity(&self, auth: &Value, identity: &str) -> Result<bool> {
        if identity.len() != 64
            || !identity
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ManagementError("Invalid OS service identity.").into());
        }
        let id = text(auth, "attachmentId")?;
        let client = text(auth, "clientId")?;
        let secret = time(auth, "secretExpiresAt")?.context("Tunnel credential generation")?;
        Ok(!self.database.query("UPDATE tunnel_attachments SET os_service_identity=$4 WHERE id=$1 AND client_id=$2 AND secret_expires_at=$3 AND expires_at>$5 AND status<>'stopped' AND (os_service_identity IS NULL OR os_service_identity=$4) RETURNING id",
            &[&id,&client,&secret,&identity,&self.now()]).await?.is_empty())
    }
}
