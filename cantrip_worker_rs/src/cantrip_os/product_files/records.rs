//! Reopen the original worker admission and native process record formats.
use super::{RpcError, Session, Transport, digest, text};
use crate::{
    cantrip_os::operations::save, filesystem::Scope, run_definitions::repository::read_bounded,
};
use anyhow::{Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(super) struct Records {
    root: PathBuf,
}

pub(super) fn read(path: &Path) -> Result<Option<Value>> {
    let bytes = match read_bounded(path, 8 * 1024 * 1024) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let record = parse_json_text(std::str::from_utf8(&bytes)?)
        .map_err(|_| anyhow!("Invalid Linux file operation record."))?;
    Ok(Some(record))
}

impl Records {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
        }
    }

    fn helper(&self, identity: &str) -> PathBuf {
        self.root
            .join("os-file-helpers")
            .join(format!("{identity}.json"))
    }

    pub fn observe(&self, identity: &str, context: &Value, frame: &Value) -> Result<bool> {
        let key = digest(json!({"identity":identity,"context":context}));
        let file = self
            .root
            .join("os-file-admissions")
            .join(format!("{key}.json"));
        let fingerprint = digest(frame.clone());
        let record = json!({"digest":fingerprint});
        match save(&file, &record, true) {
            Ok(()) => Ok(false),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|cause| cause.kind() == ErrorKind::AlreadyExists) =>
            {
                let prior =
                    read(&file)?.ok_or_else(|| anyhow!("OS file admission disappeared."))?;
                ensure!(
                    prior["digest"] == fingerprint,
                    "OS file admission identity was reused with different input."
                );
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }

    pub fn start(
        &self,
        identity: &str,
        binding: &Value,
        session: &str,
        process: &str,
    ) -> Result<()> {
        save(
            &self.helper(identity),
            &json!({
                "sessionId":session,"processId":process,"executorGeneration":binding["executor_generation"],
            }),
            true,
        )
    }

    pub fn finished(&self, identity: &str) -> Result<()> {
        match fs::remove_file(self.helper(identity)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn retire(
        &self,
        identity: &str,
        transport: &Transport,
        binding: &Value,
        lifetime: &Scope,
    ) -> Result<()> {
        let Some(prior) = read(&self.helper(identity))? else {
            return Ok(());
        };
        if prior["executorGeneration"] != binding["executor_generation"] {
            return self.finished(identity);
        }

        let expected = text(&prior, "sessionId")?;
        let process_id = text(&prior, "processId")?;
        Uuid::parse_str(expected)?;
        Uuid::parse_str(process_id)?;
        let (mut session, id) = match Session::connect(
            transport,
            binding.clone(),
            super::CLIENT,
            Some(expected),
            lifetime,
        )
        .await
        {
            Err(error)
                if error
                    .downcast_ref::<RpcError>()
                    .is_some_and(|rpc| rpc.unknown_session(expected)) =>
            {
                return self.finished(identity);
            }
            result => result?,
        };
        let stopped = async {
            ensure!(
                id == expected,
                "The retained Linux file helper session changed."
            );
            super::process::terminate(&mut session, process_id).await
        }
        .await;
        session.close().await;
        stopped?;
        self.finished(identity)
    }
}
