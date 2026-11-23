use super::{Manager, error, io, path};
use crate::filesystem::paths;
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use std::path::{Path, PathBuf};
fn requested(value: &Value) -> Result<Value> {
    let trimmed = path::value(value).trim();
    let units = trimmed.units();
    if trimmed.is_empty()
        || trimmed.len() > 8192
        || units.contains(&0)
        || !paths::absolute(&paths::native(&trimmed))
        || units.last().is_some_and(|u| [47, 92].contains(u))
    {
        return Err(error(
            "path-invalid",
            "The repository placement must be an exact absolute worker path.",
        ));
    }
    let last = units.rsplit(|u| [47, 92].contains(u)).next().unwrap();
    if last == [46] || last == [46, 46] {
        return Err(error(
            "path-invalid",
            "The repository placement cannot end in '.' or '..'.",
        ));
    }
    let normalized = path::normalized(&trimmed);
    let native = paths::native(&normalized);
    if native.parent().is_none() {
        return Err(error(
            "path-invalid",
            "A filesystem root cannot be used as a repository placement.",
        ));
    }
    Ok(Value::String(normalized))
}
async fn parents(parent: &Path) -> Result<PathBuf> {
    let mut missing = Vec::new();
    let mut ancestor = parent.to_owned();
    while io::entry(&ancestor).await?.is_none() {
        let Some(parent) = ancestor.parent().filter(|p| *p != ancestor) else {
            return Err(error(
                "parent-creation-failed",
                "No existing ancestor could be found for the repository placement.",
            ));
        };
        missing.push(ancestor.file_name().unwrap().to_owned());
        ancestor = parent.to_owned();
    }
    let result = async {
        let mut canonical = io::canonical(&ancestor).await?;
        if !tokio::fs::metadata(&canonical).await?.is_dir() {
            anyhow::bail!("Ancestor is not a directory.");
        }
        for component in missing.into_iter().rev() {
            let next = canonical.join(component);
            match crate::filesystem::storage::make_directory(&next, false).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            };
            let metadata = tokio::fs::symlink_metadata(&next).await?;
            if !metadata.is_dir() || io::link_type(&next, &metadata) {
                return Err(error(
                    "parent-creation-failed",
                    "A repository parent path changed during directory creation.",
                ));
            }
            canonical = io::canonical(&next).await?;
        }
        Ok::<_, anyhow::Error>(canonical)
    }
    .await;
    result.map_err(|e| {
        if e.is::<super::PlacementError>() {
            e
        } else {
            error(
                if io::permission(&e) {
                    "path-permission-denied"
                } else {
                    "parent-creation-failed"
                },
                "The repository parent directories could not be created safely.",
            )
        }
    })
}
fn prepared(input: &Value, requested: Value, target: Value, link: Value, exists: bool) -> Value {
    let suffix = JsString::new(
        ".cantrip-provision-"
            .encode_utf16()
            .chain(path::value(&input["jobId"]).units().iter().copied())
            .collect(),
    );
    json!({"exists":exists,"linkPath":link,"mode":input["placement"]["mode"],"requestedPath":requested,"stagingPath":path::append(&target,&suffix),"targetPath":target})
}
impl Manager {
    pub async fn prepare(&self, input: &Value) -> Result<Value> {
        let placement = &input["placement"];
        if placement["mode"] == "managed" || placement["mode"] == "managed-link" {
            let managed = path::native(&input["managedTarget"]);
            io::mkdir(managed.parent().unwrap_or(Path::new(".")), true).await?;
            let managed = paths::resolve(&managed)?;
            let target = Value::String(paths::text(&managed));
            if placement["mode"] == "managed" {
                if let Some(record) = self
                    .registry()
                    .await?
                    .iter()
                    .find(|record| path::equal(&record["canonicalPath"], &target))
                {
                    return Err(error(
                        "ownership-proof-missing",
                        if record["releasedAt"].is_null() {
                            "The managed repository source is already assigned to a custom-placement project."
                        } else {
                            "The managed repository source was retained as user-managed storage and cannot be reclaimed automatically."
                        },
                    ));
                }
                return Ok(prepared(
                    input,
                    Value::Null,
                    target.clone(),
                    Value::Null,
                    io::entry(&managed).await?.is_some(),
                ));
            }
            let requested = requested(&placement["path"])?;
            let requested_native = path::native(&requested);
            let canonical_parent = parents(requested_native.parent().unwrap()).await?;
            let link = path::child(&canonical_parent, &path::basename(path::value(&requested)));
            if paths::within(&managed, &path::native(&link)) {
                return Err(error(
                    "link-target-mismatch",
                    "The managed link must be outside its canonical repository source.",
                ));
            }
            let records = self.registry().await?;
            if records
                .iter()
                .any(|r| !r["releasedAt"].is_null() && path::equal(&r["canonicalPath"], &target))
            {
                return Err(error(
                    "ownership-proof-missing",
                    "The managed repository source was retained as user-managed storage and cannot be reclaimed automatically.",
                ));
            }
            let collision = records.iter().find(|r| {
                r["releasedAt"].is_null()
                    && (path::equal(&r["canonicalPath"], &target)
                        || (!r["linkPath"].is_null() && path::equal(&r["linkPath"], &link)))
            });
            if collision.is_some_and(|r| r["projectId"] != input["projectId"]) {
                return Err(error(
                    "target-owned-by-another-project",
                    "The requested managed link is already assigned to another Cantrip project.",
                ));
            }
            if let Some(metadata) = io::entry(&path::native(&link)).await? {
                if !io::link_type(&path::native(&link), &metadata) {
                    return Err(error(
                        "link-target-mismatch",
                        "The requested managed-link path is occupied by another filesystem entry.",
                    ));
                }
                if !collision.is_some_and(|r| r["projectId"] == input["projectId"]) {
                    return Err(error(
                        "ownership-proof-missing",
                        "The existing repository link is not owned by this Cantrip project.",
                    ));
                }
            }
            return Ok(prepared(
                input,
                requested,
                target,
                link,
                io::entry(&managed).await?.is_some(),
            ));
        }
        let requested = requested(&placement["path"])?;
        let native = path::native(&requested);
        let metadata = io::entry(&native).await?;
        let exists = metadata.is_some();
        let target = if let Some(metadata) = metadata {
            if !metadata.is_dir() && !io::link_type(&native, &metadata) {
                return Err(error(
                    "target-type-mismatch",
                    "The requested repository target already exists and is not a directory.",
                ));
            }
            let result = async {
                let canonical = io::canonical(&native).await?;
                if !tokio::fs::metadata(&canonical).await?.is_dir() {
                    return Err(error(
                        "target-type-mismatch",
                        "The requested repository target does not resolve to a directory.",
                    ));
                }
                Ok::<_, anyhow::Error>(Value::String(paths::text(&canonical)))
            }
            .await;
            result.map_err(|e| {
                if e.is::<super::PlacementError>() {
                    e
                } else {
                    error(
                        if io::permission(&e) {
                            "path-permission-denied"
                        } else {
                            "target-type-mismatch"
                        },
                        "The requested repository target could not be resolved safely.",
                    )
                }
            })?
        } else {
            let parent = parents(native.parent().unwrap()).await?;
            path::child(&parent, &path::basename(path::value(&requested)))
        };
        if self
            .registry()
            .await?
            .iter()
            .find(|r| r["releasedAt"].is_null() && path::equal(&r["canonicalPath"], &target))
            .is_some_and(|r| r["projectId"] != input["projectId"])
        {
            return Err(error(
                "target-owned-by-another-project",
                "The requested repository target is already attached to another Cantrip project.",
            ));
        }
        Ok(prepared(input, requested, target, Value::Null, exists))
    }
}
