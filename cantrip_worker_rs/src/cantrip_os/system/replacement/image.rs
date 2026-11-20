use super::{LIMIT, Refused, Replacement};
use crate::cantrip_os::{
    docker::{DockerApiError, ImageUploadChanged, segment},
    system::{
        archive::{StagingChanged, verified_plaintext},
        private_labels,
    },
    text,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, value::json};
use hyper::{Method, StatusCode};
use std::path::Path;

impl Replacement<'_> {
    pub(super) async fn inspect_image(&self, id: &str) -> Result<Value> {
        self.engine
            .request(
                Method::GET,
                &format!("/images/{}/json", segment(id)),
                None,
                LIMIT,
                self.lifetime,
            )
            .await
    }

    pub(super) async fn ensure_image(
        &self,
        record: &mut Value,
        mutate: bool,
    ) -> Result<Option<Value>> {
        if record["steps"]["load"]["refused"] == true {
            return Err(Refused(
                "The original image upload was refused; it was not repeated.".into(),
            )
            .into());
        }
        let source = &self.request["source"];
        let id = text(source, "imageId")?;
        let actual = match self.inspect_image(id).await {
            Ok(image) => image,
            Err(error)
                if error
                    .downcast_ref::<DockerApiError>()
                    .is_some_and(|error| error.status == StatusCode::NOT_FOUND) =>
            {
                if !mutate || record["steps"]["load"]["claimed"] == true {
                    return Ok(None);
                }
                self.upload(record).await?;
                self.inspect_image(id).await?
            }
            Err(error) => return Err(error),
        };
        check_image(&actual, self.request)?;
        record["steps"]["load"]["observed"] = json!(true);
        record["phase"] = json!("image-verified");
        self.save(record, false)?;
        Ok(Some(actual))
    }

    async fn upload(&self, record: &mut Value) -> Result<()> {
        let archive = &self.request["archive"];
        ensure!(
            archive.is_object(),
            "The exact system image is unavailable and no authenticated staged archive was supplied."
        );
        let path = Path::new(text(archive, "path")?);
        let size = archive["bytes"]
            .as_u64()
            .filter(|size| *size > 0)
            .context("The staged system archive size is invalid.")?;
        let digest = text(archive, "sha256")?;
        let file = match verified_plaintext(path, size, digest, self.lifetime).await {
            Ok(file) => file,
            Err(error) if error.is::<StagingChanged>() => {
                record["steps"]["load"]["refused"] = json!(true);
                return Err(Refused(error.to_string()).into());
            }
            Err(error) => return Err(error),
        };
        record["steps"]["load"] = json!({"claimed":true, "acknowledged": false});
        record["phase"] = json!("load-requested");
        self.save(record, false)?;
        if let Err(error) = self
            .engine
            .load_image(file, size, digest, self.lifetime)
            .await
        {
            if error.is::<DockerApiError>() || error.is::<ImageUploadChanged>() {
                record["steps"]["load"]["refused"] = json!(true);
                return Err(Refused(error.to_string()).into());
            }
            return Err(error);
        }
        record["steps"]["load"]["acknowledged"] = json!(true);
        self.save(record, false)
    }
}

fn check_image(actual: &Value, request: &Value) -> Result<()> {
    let source = &request["source"];
    let labels = &actual["Config"]["Labels"];
    ensure!(
        actual["Id"] == source["imageId"]
            && actual["Os"] == "linux"
            && actual["RootFS"]["Layers"].is_array()
            && labels["io.cantrip.os"] == "foundation",
        "The exact foundation image could not be verified."
    );
    if source["kind"] == "checkpoint" {
        ensure!(
            labels["io.cantrip.os.system.operation"] == source["operationId"]
                && labels["io.cantrip.os.system.request"] == source["requestSha256"]
                && labels["io.cantrip.os.system.container"] == source["containerId"]
                && labels["io.cantrip.os.system.instance"] == request["instanceId"],
            "The checkpoint image belongs to another original instance/admission."
        );
    } else {
        ensure!(
            !private_labels(labels),
            "A private system image cannot be used as a reusable base template."
        );
    }
    Ok(())
}
