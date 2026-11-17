//! Complete worker placement/ownership mechanism. The provisioning command
//! adapter is separate; these methods never infer ownership from a path or PID.
mod io;
mod links;
mod path;
mod prepare;
mod records;
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use std::path::{Path, PathBuf};
const OWNER: &str = "cantrip-project-owner.json";
#[derive(Debug)]
pub struct PlacementError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}
impl std::fmt::Display for PlacementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for PlacementError {}
fn error(code: &'static str, message: &'static str) -> anyhow::Error {
    PlacementError {
        code,
        message,
        retryable: false,
    }
    .into()
}
pub struct Manager {
    data: PathBuf,
    worker: JsString,
    writes: tokio::sync::Mutex<()>,
}
impl Manager {
    pub fn new(data: &Path, worker: JsString) -> Self {
        Self {
            data: data.to_owned(),
            worker,
            writes: tokio::sync::Mutex::new(()),
        }
    }
    fn registry_path(&self) -> PathBuf {
        self.data.join("project-replica-placements.json")
    }
    async fn registry(&self) -> Result<Vec<Value>> {
        records::read(&self.registry_path()).await
    }
    async fn write(&self, records: Vec<Value>) -> Result<()> {
        io::mkdir(&self.data, true).await?;
        io::publish(
            &self.registry_path(),
            &json!({"version":1,"records":records}),
        )
        .await
    }
    fn owned_marker(&self, input: &Value) -> Value {
        json!({"version":1,"createdBy":"cantrip","projectId":input["projectId"],"workerId":self.worker,"repositoryFingerprint":input["repositoryFingerprint"]})
    }
    async fn marker(&self, input: &Value) -> Option<Value> {
        records::ownership(&path::native(&input["gitCommonDir"]).join(OWNER)).await
    }
    fn marker_matches(&self, marker: &Value, input: &Value) -> bool {
        marker["projectId"] == input["projectId"]
            && marker["workerId"].as_js_string() == Some(&self.worker)
            && marker["repositoryFingerprint"] == input["repositoryFingerprint"]
    }
    fn claim_matches(&self, marker: &Value, input: &Value) -> bool {
        marker["jobId"] == input["jobId"]
            && marker["projectId"] == input["projectId"]
            && marker["workerId"].as_js_string() == Some(&self.worker)
    }
    pub async fn write_created_marker(&self, input: &Value) -> Result<()> {
        io::publish(
            &path::native(&input["gitCommonDir"]).join(OWNER),
            &self.owned_marker(input),
        )
        .await
    }
    pub async fn claim_staging(&self, input: &Value) -> Result<()> {
        let staging = path::native(&input["stagingPath"]);
        let marker = path::native(&path::append(
            &input["stagingPath"],
            &".cantrip-owner.json".into(),
        ));
        if io::entry(&staging).await?.is_some() {
            let claim = records::staging(&marker).await;
            if !claim.as_ref().is_some_and(|m| self.claim_matches(m, input)) {
                return Err(error(
                    "target-type-mismatch",
                    "The repository staging path already exists and is not owned by this job.",
                ));
            }
            io::remove(&staging, true).await?;
        }
        io::mkdir(marker.parent().unwrap(), true).await?;
        let result=io::exclusive(&marker,&json!({"version":1,"jobId":input["jobId"],"projectId":input["projectId"],"workerId":self.worker})).await;
        if let Err(error) = result
            && !records::staging(&marker)
                .await
                .as_ref()
                .is_some_and(|m| self.claim_matches(m, input))
        {
            return Err(error);
        }
        Ok(())
    }
    pub async fn cleanup_staging(&self, input: &Value) -> Result<()> {
        let marker = path::native(&path::append(
            &input["stagingPath"],
            &".cantrip-owner.json".into(),
        ));
        if records::staging(&marker)
            .await
            .as_ref()
            .is_some_and(|m| self.claim_matches(m, input))
        {
            io::remove(&path::native(&input["stagingPath"]), true).await?;
            io::remove(&marker, false).await?;
        }
        Ok(())
    }
    pub async fn classify_existing(&self, input: &Value) -> Result<Value> {
        let records = self.registry().await?;
        let record = records.iter().find(|r| {
            r["releasedAt"].is_null() && path::equal(&r["canonicalPath"], &input["canonicalPath"])
        });
        if record.is_some_and(|r| r["projectId"] != input["projectId"]) {
            return Err(error(
                "target-owned-by-another-project",
                "The requested repository target is already attached to another Cantrip project.",
            ));
        }
        let marker = self.marker(input).await;
        if marker.is_none()
            && io::entry(&path::native(&input["gitCommonDir"]).join(OWNER))
                .await?
                .is_some()
        {
            return Err(error(
                "ownership-proof-missing",
                "The checkout contains invalid Cantrip ownership metadata.",
            ));
        }
        if let Some(marker) = marker {
            if marker["projectId"] != input["projectId"] {
                return Err(error(
                    "target-owned-by-another-project",
                    "The requested repository target is owned by another Cantrip project.",
                ));
            }
            if !self.marker_matches(&marker, input) {
                return Err(error(
                    "ownership-proof-missing",
                    "Cantrip ownership metadata does not match this repository checkout.",
                ));
            }
            return Ok(json!("cantrip"));
        }
        if record.is_some_and(|r| r["ownership"] == "cantrip") {
            return Err(error(
                "ownership-proof-missing",
                "Cantrip ownership metadata no longer matches this repository checkout.",
            ));
        }
        Ok(json!("user"))
    }
}
pub async fn probe_managed_link(data: &Path) -> bool {
    let mut temporary = None;
    let result = async {
        io::mkdir(data, true).await?;
        let directory = tempfile::Builder::new()
            .prefix(".project-link-capability-")
            .tempdir_in(data)?;
        let target = directory.path().join("target");
        let link = directory.path().join("link");
        temporary = Some(directory);
        io::mkdir(&target, false).await?;
        io::directory_link(&target, &link).await?;
        Ok::<_, anyhow::Error>(io::canonical(&target).await? == io::canonical(&link).await?)
    }
    .await;
    drop(temporary);
    result.unwrap_or(false)
}
