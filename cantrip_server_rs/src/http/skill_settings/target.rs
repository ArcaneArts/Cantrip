use super::*;

pub(super) struct Target {
    pub worker: String,
    pub cwd: Value,
    pub provider_id: Value,
    pub provider_kind: Value,
    pub model: Value,
    pub provider: Value,
}

pub(super) async fn resolve(service: &AuthService, owner: &str, input: &Value) -> Result<Target> {
    let repository = SettingsRepository::new(service.repository.database.clone());
    let provider = repository
        .get_model_provider(owner, &text(&input["providerId"])?)
        .await?
        .ok_or(TargetError(404, "Model provider not found."))?;
    // This existing repository embeds the same Source getProjectSource query,
    // including primary readiness, replica removal and worker selection.
    let source = if !input["projectId"].is_null() {
        crate::project_shares::repository::Repository::new(service.repository.database.clone())
            .source(owner, &text(&input["projectId"])?, &input["workerId"])
            .await?
    } else {
        None
    };
    if !input["projectId"].is_null() && source.is_none() {
        return Err(TargetError(404, "Project source not found.").into());
    }
    if source
        .as_ref()
        .is_some_and(|s| s["workerId"] != input["workerId"])
    {
        return Err(TargetError(409, "The selected project belongs to a different worker.").into());
    }
    let worker = text(
        source
            .as_ref()
            .map_or(&input["workerId"], |s| &s["workerId"]),
    )?;
    if source.is_none()
        && service
            .workers
            .repository
            .get_worker(owner, &worker)
            .await?
            .is_none()
    {
        return Err(TargetError(404, "Worker not found.").into());
    }
    if !service.workers.commands.is_connected(&worker) {
        return Err(TargetError(503, "Selected worker is offline.").into());
    }
    // Source enriches the full configured runtime collection before choosing
    // this provider. Disabled routes are intentionally retained for settings.
    let runtime = repository
        .get_model_runtimes(owner, None, None, true, None)
        .await?
        .into_iter()
        .find(|r| r["provider"]["id"] == provider["id"]);
    Ok(Target {
        worker,
        cwd: source.as_ref().map_or(Value::Null, |s| s["cwd"].clone()),
        provider_id: Value::from_serialize(&provider["id"]),
        provider_kind: Value::from_serialize(&provider["kind"]),
        model: runtime
            .as_ref()
            .map_or(Value::Null, |r| Value::from_serialize(&r["model"])),
        provider: runtime
            .as_ref()
            .map_or(Value::Null, |r| Value::from_serialize(&r["provider"])),
    })
}
