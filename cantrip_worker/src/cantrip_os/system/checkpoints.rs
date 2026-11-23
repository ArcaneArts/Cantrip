//! Worker-private checkpoint transfer and recovery.
use super::{
    account,
    archive::{Archive, verified_plaintext},
    carrier::Capture,
    checked, key, load_record,
};
use crate::{
    cantrip_os::{
        lock::InstanceLock,
        operations::{digest, now, save, scope_key},
        text,
    },
    encryption::Service,
    filesystem::Scope,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::{
    Zeroizing,
    content::{SystemCipher, SystemFrame},
};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Prepare,
    Observe,
    Continue,
}

pub(super) struct Checkpoint<'a> {
    admission: Value,
    root: &'a Path,
    journal: PathBuf,
    host: PathBuf,
    file: PathBuf,
    encryption: &'a Service,
    lifetime: &'a Scope,
}

impl<'a> Checkpoint<'a> {
    pub fn new(
        admission: Value,
        root: &'a Path,
        encryption: &'a Service,
        lifetime: &'a Scope,
    ) -> Result<Self> {
        let admission = checked("cantripOsSystemCaptureAdmissionSchema", admission)?;
        let context = &admission["context"];
        let directory = root
            .join("cantrip-os-system-checkpoints")
            .join(scope_key(context));
        let id = text(context, "operationId")?;
        Ok(Self {
            root,
            journal: directory.join(format!("{id}.json")),
            host: directory.join(format!("{id}.json.docker")),
            file: directory.join(format!("{id}.json.ctos-system")),
            admission,
            encryption,
            lifetime,
        })
    }

    fn context(&self) -> &Value {
        &self.admission["context"]
    }

    fn active(&self) -> Result<()> {
        self.lifetime.check()?;
        account(self.context(), self.encryption)
    }

    pub async fn stage(&self, destination: &Path, allow_write: bool) -> Result<Option<Value>> {
        let _lock = InstanceLock::acquire(&self.lock_key(), self.lifetime).await?;
        self.active()?;
        let record = self
            .load()?
            .filter(|value| value["state"] == "ready")
            .context("The original system checkpoint is not complete.")?;
        let manifest = &record["manifest"];
        let receipt = &record["archive"];
        let source = Archive {
            file: &self.file,
            context: self.context(),
            encryption: self.encryption,
            lifetime: self.lifetime,
        };
        match verified_plaintext(
            destination,
            receipt["archiveBytes"].as_u64().context("Archive size")?,
            text(receipt, "archiveSha256")?,
            self.lifetime,
        )
        .await
        {
            Ok(_) => {
                let (verified_manifest, verified_receipt) = source.verify().await?;
                ensure!(
                    &verified_manifest == manifest && &verified_receipt == receipt,
                    "The original system archive proof changed."
                );
            }
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                if !allow_write {
                    return Ok(None);
                }
                source
                    .stage(destination, self.root, manifest, receipt)
                    .await?;
            }
            Err(error) => return Err(error),
        };
        Ok(Some(json!({"manifest":manifest, "receipt":receipt})))
    }

    fn lock_key(&self) -> String {
        let scope = self.context();
        let fields = [
            "serverId",
            "ownerId",
            "workerId",
            "instanceId",
            "guestInstanceId",
            "operationId",
        ];
        let authority = Value::Array(
            fields
                .into_iter()
                .map(|field| scope[field].clone())
                .collect(),
        );
        format!("system-transfer:{}", digest(authority))
    }

    fn load(&self) -> Result<Option<Value>> {
        let Some(record) = load_record(&self.journal)? else {
            return Ok(None);
        };
        ensure!(
            record["version"].as_i64() == Some(1) && record["admission"] == self.admission,
            "The system checkpoint operation already has a different immutable admission."
        );
        let outcome = self.outcome(&record)?;
        if !record["manifest"].is_null() {
            checked("cantripOsSystemManifestSchema", record["manifest"].clone())?;
        }
        if !record["archive"].is_null() {
            checked(
                "cantripOsSystemArchiveReceiptSchema",
                record["archive"].clone(),
            )?;
        }
        ensure!(
            (record["archive"].is_null() || record["manifest"].is_object())
                && (outcome["state"] != "ready"
                    || (record["archive"].is_object() && record["phase"] == "complete")),
            "The system checkpoint journal has no completed private proof."
        );
        Ok(Some(record))
    }

    fn protect(&self, record: &mut Value) -> Result<()> {
        self.active()?;
        let material = key(self.context(), self.encryption, None)?;
        let stream = json!(Uuid::new_v4().to_string());
        let revision = material.key_revision;
        let cipher = SystemCipher::new(self.context(), &stream, revision, &material.key)?;
        let clear = Zeroizing::new(json!({"version":1,"state":record["state"],"phase":record["phase"],
            "startedAt":record["startedAt"],"updatedAt":record["updatedAt"],"manifest":record["manifest"],
            "archive":record["archive"],"error":record["lastError"]}).stringify().into_bytes());
        let frame = cipher.seal(SystemFrame::Result, 0, &clear)?;
        self.active()?;
        record["protectedResult"] = json!({"streamId":stream,"keyRevision":revision,"frame":frame});
        Ok(())
    }

    fn save(&self, record: &mut Value, exclusive: bool) -> Result<()> {
        self.active()?;
        record["updatedAt"] = json!(now());
        save(&self.journal, record, exclusive)
    }

    fn outcome(&self, record: &Value) -> Result<Value> {
        let c = self.context();
        checked(
            "cantripOsSystemCaptureOutcomeSchema",
            json!({"operationId":c["operationId"],
            "checkpointId":c["checkpointId"],"state":record["state"],"phase":record["phase"],
            "protectedResult":record["protectedResult"]}),
        )
    }

    pub fn details(&self, outcome: &Value) -> Result<Value> {
        let proof = &outcome["protectedResult"];
        if proof.is_null() {
            return Ok(Value::Null);
        }
        let proof = checked("cantripOsSystemProtectedResultSchema", proof.clone())?;
        let revision = proof["keyRevision"]
            .as_u64()
            .context("System checkpoint key revision")?;
        let material = key(self.context(), self.encryption, Some(revision))?;
        let cipher =
            SystemCipher::new(self.context(), &proof["streamId"], revision, &material.key)?;
        let clear = cipher.open(SystemFrame::Result, 0, &proof["frame"])?;
        let value = parse_json_text(std::str::from_utf8(&clear)?)
            .map_err(|_| anyhow!("Invalid private checkpoint outcome"))?;
        self.active()?;
        Ok(json!({"manifest":value["manifest"],"archive":value["archive"]}))
    }

    pub async fn run(&self, mode: Mode) -> Result<Option<Value>> {
        let _lock = InstanceLock::acquire(&self.lock_key(), self.lifetime).await?;
        self.active()?;
        let prior = self.load()?;
        let mut record = match (prior, mode) {
            (Some(record), _) => record,
            (None, Mode::Observe) => return Ok(None),
            (None, Mode::Continue) => {
                return Err(anyhow!(
                    "There is no original system checkpoint admission to continue."
                ));
            }
            (None, Mode::Prepare) => {
                let at = now();
                let mut record = json!({"version":1,"admission":self.admission,"state":"running",
                    "phase":"prepared","startedAt":at,"updatedAt":at,"manifest":Value::Null,
                    "archive":Value::Null,"protectedResult":Value::Null,"lastError":Value::Null});
                self.protect(&mut record)?;
                self.save(&mut record, true)?;
                record
            }
        };
        if mode == Mode::Prepare || matches!(record["state"].as_str(), Some("ready" | "failed")) {
            return Ok(Some(self.outcome(&record)?));
        }
        if let Err(error) = self.advance(&mut record, mode).await {
            record["state"] = json!("unknown");
            record["lastError"] = json!(error.to_string());
        }
        record["updatedAt"] = json!(now());
        self.protect(&mut record)?;
        self.save(&mut record, false)?;
        Ok(Some(self.outcome(&record)?))
    }

    async fn advance(&self, record: &mut Value, mode: Mode) -> Result<()> {
        let carrier = Capture {
            path: &self.host,
            context: self.context(),
            admission: &self.admission,
            encryption: self.encryption,
            lifetime: self.lifetime,
        };
        if record["manifest"].is_null() {
            record["phase"] = json!("capture-requested");
            self.save(record, false)?;
            let host = carrier
                .run(mode == Mode::Continue)
                .await?
                .unwrap_or(Value::Null);
            if host["state"] != "ready" {
                record["state"] = json!(host["state"].as_str().unwrap_or("unknown"));
                record["phase"] = json!(format!(
                    "capture-{}",
                    host["phase"].as_str().unwrap_or("unobserved")
                ));
                record["lastError"] = json!(
                    host["error"]
                        .as_str()
                        .unwrap_or("The original system capture is not verified.")
                );
                return Ok(());
            }
            record["manifest"] = checked(
                "cantripOsSystemManifestSchema",
                json!({"version":1,"snapshot":host["snapshot"]}),
            )?;
            record["phase"] = json!("captured");
            self.save(record, false)?;
        }

        let archive = Archive {
            file: &self.file,
            context: self.context(),
            encryption: self.encryption,
            lifetime: self.lifetime,
        };
        match archive.verify().await {
            Ok((manifest, receipt)) => {
                ensure!(
                    manifest == record["manifest"]
                        && (record["archive"].is_null() || receipt == record["archive"]),
                    "The published system archive proof changed."
                );
                record["archive"] = receipt;
            }
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                ensure!(
                    record["archive"].is_null(),
                    "The completed system archive is unavailable; it was not regenerated."
                );
                if mode == Mode::Observe {
                    record["state"] = json!("unknown");
                    record["lastError"] = json!(
                        "No published archive is present. Explicit continuation can authorize a new read of the captured image."
                    );
                    return Ok(());
                }
                record["phase"] = json!("export-requested");
                self.save(record, false)?;
                let stream = carrier.export().await?;
                record["archive"] = archive.seal(&record["manifest"], stream, self.root).await?;
            }
            Err(error) => return Err(error),
        }
        self.active()?;
        record["state"] = json!("ready");
        record["phase"] = json!("complete");
        record["lastError"] = Value::Null;
        Ok(())
    }
}
