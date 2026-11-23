use super::{Manager, error, io, path};
use crate::filesystem::paths;
use anyhow::Result;
use cantrip_wire::{Value, value::json};
async fn verify(link: &Value, canonical: &Value) -> Result<()> {
    let native = path::native(link);
    let metadata = io::entry(&native).await?;
    if !metadata
        .as_ref()
        .is_some_and(|metadata| io::link_type(&native, metadata))
    {
        return Err(error(
            "link-target-mismatch",
            "The managed repository link is missing or has been replaced.",
        ));
    }
    let result = async {
        let real_link = Value::String(paths::text(&io::canonical(&native).await?));
        let real_target =
            Value::String(paths::text(&io::canonical(&path::native(canonical)).await?));
        if !path::equal(&real_link, &real_target) {
            return Err(error(
                "link-target-mismatch",
                "The managed repository link points to a different checkout.",
            ));
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    result.map_err(|e| {
        if e.is::<super::PlacementError>() {
            e
        } else {
            error(
                "link-target-mismatch",
                "The managed repository link could not be verified.",
            )
        }
    })
}
impl Manager {
    pub async fn materialize_managed_link(&self, input: &Value) -> Result<Value> {
        let _guard = self.writes.lock().await;
        let mut records = self.registry().await?;
        if records.iter().any(|r| {
            !r["releasedAt"].is_null() && path::equal(&r["canonicalPath"], &input["canonicalPath"])
        }) {
            return Err(error(
                "ownership-proof-missing",
                "The managed repository source was retained as user-managed storage and cannot be reclaimed automatically.",
            ));
        }
        let record = records
            .iter()
            .find(|r| r["projectId"] == input["projectId"] && r["releasedAt"].is_null());
        let matches = record.is_some_and(|r| {
            r["workerId"].as_js_string() == Some(&self.worker)
                && r["mode"] == "managed-link"
                && r["ownership"] == "cantrip"
                && path::equal(&r["canonicalPath"], &input["canonicalPath"])
                && !r["linkPath"].is_null()
                && path::equal(&r["linkPath"], &input["linkPath"])
                && r["repositoryFingerprint"] == input["repositoryFingerprint"]
        });
        if record.is_some() && !matches {
            return Err(error(
                "ownership-proof-missing",
                "The managed-link ownership record does not match this repository.",
            ));
        }
        if records.iter().any(|r| {
            r["projectId"] != input["projectId"]
                && r["releasedAt"].is_null()
                && (path::equal(&r["canonicalPath"], &input["canonicalPath"])
                    || (!r["linkPath"].is_null()
                        && path::equal(&r["linkPath"], &input["linkPath"])))
        }) {
            return Err(error(
                "target-owned-by-another-project",
                "The managed source or link is already assigned to another Cantrip project.",
            ));
        }
        let link = path::native(&input["linkPath"]);
        if io::entry(&link).await?.is_some() {
            if !matches {
                return Err(error(
                    "ownership-proof-missing",
                    "The existing repository link is not owned by this Cantrip project.",
                ));
            }
            verify(&input["linkPath"], &input["canonicalPath"]).await?;
            return Ok(json!({"changed":false}));
        }
        if input["requireExistingClaim"] == true && !matches {
            return Err(error(
                "ownership-proof-missing",
                "The managed link cannot be repaired without its worker ownership record.",
            ));
        }
        if !matches {
            records.retain(|r| r["projectId"] != input["projectId"]);
            records.push(json!({"canonicalPath":input["canonicalPath"],"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"linkPath":input["linkPath"],"mode":"managed-link","ownership":"cantrip","projectId":input["projectId"],"repositoryFingerprint":input["repositoryFingerprint"],"requestedPath":input["requestedPath"],"workerId":self.worker}));
            self.write(records).await?;
        }
        let mut changed = false;
        match io::directory_link(&path::native(&input["canonicalPath"]), &link).await {
            Ok(()) => changed = true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(failure) => {
                let permission = io::permission(&failure.into());
                return Err(super::PlacementError {
                    code: if permission {
                        "path-permission-denied"
                    } else {
                        "link-unsupported"
                    },
                    message: "The worker could not create the requested managed repository link.",
                    retryable: permission,
                }
                .into());
            }
        }
        verify(&input["linkPath"], &input["canonicalPath"]).await?;
        Ok(json!({"changed":changed}))
    }
    pub async fn remove_managed_link_if_matching(&self, input: &Value) -> Result<Value> {
        let link = path::native(&input["linkPath"]);
        let Some(metadata) = io::entry(&link).await? else {
            return Ok(json!({"removed":false,"warning":Value::Null}));
        };
        if !io::link_type(&link, &metadata) {
            return Ok(
                json!({"removed":false,"warning":"The original managed-link path now contains another entry and was left untouched."}),
            );
        }
        let resolved = async {
            Ok::<_, anyhow::Error>(path::equal(
                &Value::String(paths::text(&io::canonical(&link).await?)),
                &Value::String(paths::text(
                    &io::canonical(&path::native(&input["canonicalPath"])).await?,
                )),
            ))
        }
        .await;
        let matches = match resolved {
            Ok(value) => value,
            Err(_) => match tokio::fs::read_link(&link).await {
                Ok(destination) => {
                    let absolute = paths::resolve(&link.parent().unwrap().join(destination))?;
                    path::equal(
                        &Value::String(paths::text(&absolute)),
                        &input["canonicalPath"],
                    )
                }
                Err(_) => false,
            },
        };
        if !matches {
            return Ok(
                json!({"removed":false,"warning":"The original managed-link path no longer points to this checkout and was left untouched."}),
            );
        }
        io::unlink(&link).await?;
        Ok(json!({"removed":true,"warning":Value::Null}))
    }
}
