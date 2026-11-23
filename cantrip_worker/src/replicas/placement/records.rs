use super::{Manager, OWNER, error, io, path};
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};
use std::path::Path;
fn string(value: &Value, field: &str, nonempty: bool) -> bool {
    value
        .get(field)
        .and_then(Value::as_js_string)
        .is_some_and(|s| !nonempty || !s.is_empty())
}
fn fingerprint(value: &Value) -> bool {
    value["repositoryFingerprint"].as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn record(value: &Value) -> Result<Value> {
    let optional_path = value.get("linkPath").filter(|v| !v.is_null());
    if !value.is_object()
        || !["projectId", "workerId", "canonicalPath", "requestedPath"]
            .iter()
            .all(|f| string(value, f, true))
        || !fingerprint(value)
        || ["canonicalPath", "requestedPath"]
            .iter()
            .any(|f| value[*f].as_js_string().unwrap().len() > 8192)
        || optional_path.is_some_and(|v| {
            !v.as_js_string()
                .is_some_and(|v| !v.is_empty() && v.len() <= 8192)
        })
        || !["direct", "managed-link"]
            .iter()
            .any(|mode| value["mode"] == *mode)
        || !["cantrip", "user"]
            .iter()
            .any(|own| value["ownership"] == *own)
        || value
            .get("releasedAt")
            .is_some_and(|v| !v.is_null() && !v.is_string())
        || !string(value, "createdAt", false)
    {
        bail!("Invalid project replica placement record.");
    }
    Ok(
        json!({"canonicalPath":value["canonicalPath"],"createdAt":value["createdAt"],"linkPath":optional_path.cloned().unwrap_or(Value::Null),"mode":value["mode"],"ownership":value["ownership"],"projectId":value["projectId"],"releasedAt":value.get("releasedAt").filter(|v|v.is_string()).cloned().unwrap_or(Value::Null),"repositoryFingerprint":value["repositoryFingerprint"],"requestedPath":value["requestedPath"],"workerId":value["workerId"]}),
    )
}
pub(super) async fn read(target: &Path) -> Result<Vec<Value>> {
    let Some(metadata) = io::entry(target).await? else {
        return Ok(Vec::new());
    };
    if !metadata.is_file() || io::link_type(target, &metadata) {
        bail!("Invalid project replica placement registry.");
    }
    let value = io::parse(target).await?;
    if !value.is_object() || value["version"] != 1 || !value["records"].is_array() {
        bail!("Invalid project replica placement registry.");
    }
    value["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(record)
        .collect()
}
async fn optional(target: &Path) -> Option<Value> {
    let metadata = io::entry(target).await.ok()??;
    if !metadata.is_file() || io::link_type(target, &metadata) {
        return None;
    }
    io::parse(target).await.ok()
}
pub(super) async fn ownership(target: &Path) -> Option<Value> {
    let value = optional(target).await?;
    (value.is_object()
        && value["version"] == 1
        && value["createdBy"] == "cantrip"
        && string(&value, "projectId", false)
        && string(&value, "workerId", false)
        && fingerprint(&value))
    .then_some(value)
}
pub(super) async fn staging(target: &Path) -> Option<Value> {
    let value = optional(target).await?;
    // Source permits arrays here, although JSON arrays cannot carry the named
    // fields needed for a valid marker. Null/property failures are swallowed.
    (value["version"] == 1
        && ["jobId", "projectId", "workerId"]
            .iter()
            .all(|field| string(&value, field, false)))
    .then_some(value)
}
impl Manager {
    pub async fn record(&self, input: &Value) -> Result<()> {
        let _guard = self.writes.lock().await;
        let mut records = self.registry().await?;
        let collision = records.iter().find(|r| {
            r["releasedAt"].is_null()
                && (path::equal(&r["canonicalPath"], &input["canonicalPath"])
                    || (!r["linkPath"].is_null()
                        && !input["linkPath"].is_null()
                        && path::equal(&r["linkPath"], &input["linkPath"])))
        });
        if collision.is_some_and(|r| r["projectId"] != input["projectId"]) {
            return Err(error(
                "target-owned-by-another-project",
                "The requested repository target is already attached to another Cantrip project.",
            ));
        }
        records.retain(|r| r["projectId"] != input["projectId"]);
        let mut record = input.clone();
        record["workerId"] = Value::String(self.worker.clone());
        records.push(record);
        self.write(records).await
    }
    pub async fn verify_placement_ownership(&self, input: &Value) -> Result<()> {
        let records = self.registry().await?;
        let record = records
            .iter()
            .find(|r| r["projectId"] == input["projectId"] && r["releasedAt"].is_null());
        let matches = record.is_some_and(|r| {
            r["workerId"].as_js_string() == Some(&self.worker)
                && r["mode"] == input["mode"]
                && r["ownership"] == input["ownership"]
                && path::equal(&r["canonicalPath"], &input["canonicalPath"])
                && r["repositoryFingerprint"] == input["repositoryFingerprint"]
                && if input["linkPath"].is_null() {
                    r["linkPath"].is_null()
                } else {
                    !r["linkPath"].is_null() && path::equal(&r["linkPath"], &input["linkPath"])
                }
        });
        if !matches {
            return Err(error(
                "ownership-proof-missing",
                "The worker ownership record does not match this project replica.",
            ));
        }
        if input["mode"] == "direct"
            && input["ownership"] == "cantrip"
            && !self
                .marker(input)
                .await
                .as_ref()
                .is_some_and(|m| self.marker_matches(m, input))
        {
            return Err(error(
                "ownership-proof-missing",
                "The direct checkout no longer has matching Cantrip ownership proof.",
            ));
        }
        Ok(())
    }
    pub async fn release_placement(&self, input: &Value) -> Result<()> {
        {
            let _guard = self.writes.lock().await;
            let mut records = self.registry().await?;
            let index = records
                .iter()
                .position(|r| {
                    r["projectId"] == input["projectId"]
                        && path::equal(&r["canonicalPath"], &input["canonicalPath"])
                        && r["mode"] == input["mode"]
                        && r["ownership"] == input["ownership"]
                        && r["repositoryFingerprint"] == input["repositoryFingerprint"]
                })
                .ok_or_else(|| {
                    error(
                        "ownership-proof-missing",
                        "The repository placement ownership record cannot be released safely.",
                    )
                })?;
            if records[index]["workerId"].as_js_string() != Some(&self.worker) {
                return Err(error(
                    "ownership-proof-missing",
                    "The repository placement belongs to another worker.",
                ));
            }
            if records[index]["releasedAt"].is_null() {
                records[index]["releasedAt"] =
                    json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                self.write(records).await?;
            }
        }
        if input["mode"] == "direct"
            && input["ownership"] == "cantrip"
            && !input["gitCommonDir"].is_null()
        {
            let target = path::native(&input["gitCommonDir"]).join(OWNER);
            let marker = self.marker(input).await;
            if marker.is_none() && io::entry(&target).await?.is_none() {
                return Ok(());
            }
            if !marker
                .as_ref()
                .is_some_and(|m| self.marker_matches(m, input))
            {
                return Err(error(
                    "ownership-proof-missing",
                    "The direct checkout ownership marker cannot be released safely.",
                ));
            }
            let metadata = tokio::fs::symlink_metadata(&target)
                .await
                .map_err(|e| crate::filesystem::explorer::io_error("lstat", &target, e))?;
            if !metadata.is_file() || io::link_type(&target, &metadata) {
                return Err(error(
                    "ownership-proof-missing",
                    "The direct checkout ownership marker changed unexpectedly.",
                ));
            }
            io::unlink(&target).await?;
        }
        Ok(())
    }
    pub async fn is_placement_released(&self, input: &Value) -> Result<bool> {
        Ok(self.registry().await?.iter().any(|r| {
            r["projectId"] == input["projectId"]
                && r["workerId"].as_js_string() == Some(&self.worker)
                && r["mode"] == input["mode"]
                && path::equal(&r["canonicalPath"], &input["canonicalPath"])
                && r["repositoryFingerprint"] == input["repositoryFingerprint"]
                && !r["releasedAt"].is_null()
        }))
    }
    pub async fn forget_placement(&self, project: &Value, canonical: &Value) -> Result<()> {
        let _guard = self.writes.lock().await;
        let mut records = self.registry().await?;
        let count = records.len();
        records
            .retain(|r| r["projectId"] != *project || !path::equal(&r["canonicalPath"], canonical));
        if records.len() != count {
            self.write(records).await?;
        }
        Ok(())
    }
}
