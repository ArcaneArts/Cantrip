use super::*;
impl Manager {
    pub fn configure_catalog(&self, input: Value) -> Result<bool> {
        let catalog = super::super::journal::checked("workerAdmissionCatalogSchema", Some(&input))?;
        self.edit(|state, effects| {
            let revision = catalog["catalogRevision"].as_f64().unwrap();
            if state
                .catalog_revision
                .is_some_and(|current| revision < current)
            {
                return Ok(false);
            }
            let mut providers = IndexMap::new();
            for configuration in catalog["configurations"].as_array().unwrap() {
                let provider = configuration["providerId"].as_js_string().unwrap().clone();
                let created = configuration["inferenceCatalogCreatedRevision"]
                    .as_f64()
                    .unwrap();
                if providers.contains_key(&provider) || created > revision {
                    bail!("The provider inference catalog has inconsistent membership.");
                }
                providers.insert(provider, created);
            }
            if state.catalog_revision == Some(revision)
                && (providers.len() != state.catalog.len()
                    || providers
                        .iter()
                        .any(|(id, value)| state.catalog.get(id) != Some(value)))
            {
                bail!("Conflicting provider inference catalog revision.");
            }
            state.catalog_revision = Some(revision);
            state.catalog = providers;
            let removed = state
                .pools
                .iter()
                .filter(|(id, pool)| {
                    !state.catalog.contains_key(*id)
                        && number(&pool.configuration, "inferenceCatalogCreatedRevision")
                            <= revision
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in removed {
                self.disable_pool(state, &id, effects);
            }
            for configuration in catalog["configurations"].as_array().unwrap() {
                let id = configuration["providerId"].as_js_string().unwrap();
                if state.pools.get(id).is_some_and(|pool| {
                    number(&pool.configuration, "inferenceCatalogCreatedRevision") > revision
                }) {
                    continue;
                }
                self.configure_locked(state, configuration, effects)?;
            }
            self.changed(state, effects);
            Ok(true)
        })
    }
    pub fn configure(&self, input: Value) -> Result<bool> {
        self.edit(|state, effects| self.configure_locked(state, &input, effects))
    }
    pub(super) fn configure_locked(
        &self,
        state: &mut State,
        input: &Value,
        effects: &mut Effects,
    ) -> Result<bool> {
        let provider = input["providerId"]
            .as_js_string()
            .cloned()
            .unwrap_or_else(|| "".into());
        let previous = state.pools.get(&provider);
        let mut config = input.clone();
        if !config.is_object() {
            config = Value::Object(Default::default());
        }
        config["maxConcurrentInference"] = input
            .get("maxConcurrentInference")
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| previous.map(|pool| pool.configuration["maxConcurrentInference"].clone()))
            .unwrap_or(Value::Null);
        if config["maxConcurrentInference"].is_null()
            && let Value::Object(fields) = &mut config
        {
            fields.shift_remove(&JsString::from("maxConcurrentInference"));
        }
        let revision = if input.get("maxConcurrentInference").is_none() {
            Some(previous.map_or(json!(0), |pool| {
                pool.configuration["inferenceConfigRevision"].clone()
            }))
        } else {
            input.get("inferenceConfigRevision").cloned()
        };
        if let Some(revision) = revision {
            config["inferenceConfigRevision"] = revision;
        }
        let created = input
            .get("inferenceCatalogCreatedRevision")
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| {
                previous
                    .filter(|pool| pool.creation_known)
                    .map(|pool| pool.configuration["inferenceCatalogCreatedRevision"].clone())
                    .or_else(|| state.catalog.get(&provider).map(|v| json!(v)))
                    .or_else(|| {
                        previous.map(|pool| {
                            pool.configuration["inferenceCatalogCreatedRevision"].clone()
                        })
                    })
            })
            .unwrap_or(json!(0));
        config["inferenceCatalogCreatedRevision"] = created;
        let configuration =
            super::super::journal::checked("workerAdmissionConfigurationSchema", Some(&config))?;
        let created = number(&configuration, "inferenceCatalogCreatedRevision");
        let creation_known = input.get("inferenceCatalogCreatedRevision").is_some()
            || state.catalog.contains_key(&provider);
        if state.catalog_revision.is_some_and(|revision| {
            created <= revision && state.catalog.get(&provider) != Some(&created)
        }) {
            return Ok(false);
        }
        if previous.is_some_and(|pool| {
            created < number(&pool.configuration, "inferenceCatalogCreatedRevision")
        }) {
            return Ok(false);
        }
        if previous.is_none() {
            state.pools.insert(
                provider,
                Pool {
                    configuration,
                    disabled: false,
                    creation_known,
                    configuration_known: input.get("maxConcurrentInference").is_some(),
                    replacing: false,
                    active: IndexSet::new(),
                    suspended: IndexSet::new(),
                    queue: Vec::new(),
                },
            );
            self.changed(state, effects);
            return Ok(true);
        }
        let replaced = previous.is_some_and(|pool| {
            pool.creation_known
                && created > number(&pool.configuration, "inferenceCatalogCreatedRevision")
        });
        let pool = state.pools.get_mut(&provider).unwrap();
        if !pool.creation_known && creation_known {
            pool.configuration["inferenceCatalogCreatedRevision"] = json!(created);
            pool.creation_known = true;
            self.changed(state, effects);
        }
        if replaced {
            // Keep this same pool while canceling old waiters: running work
            // retains its capacity across replacement of provider membership.
            let pool = state.pools.get_mut(&provider).unwrap();
            pool.disabled = true;
            pool.replacing = true;
            let operations = pool
                .queue
                .iter()
                .chain(&pool.active)
                .chain(&pool.suspended)
                .copied()
                .collect::<IndexSet<_>>();
            for id in operations {
                if matches!(
                    state.tickets[&id].phase,
                    Phase::Waiting | Phase::Granted | Phase::Suspended
                ) {
                    self.cancel_locked(state, id, unavailable(), effects);
                }
            }
            let pool = state.pools.get_mut(&provider).unwrap();
            pool.replacing = false;
            if pool.active.is_empty() && pool.suspended.is_empty() && pool.queue.is_empty() {
                let pool = state.pools.shift_remove(&provider).unwrap();
                state.pools.insert(provider.clone(), pool);
            }
            self.changed(state, effects);
        } else {
            let pool = &state.pools[&provider];
            if pool.disabled {
                return Ok(false);
            }
            if input.get("maxConcurrentInference").is_none()
                && input.get("inferenceConfigRevision").is_none()
            {
                return Ok(true);
            }
            let revision = number(&configuration, "inferenceConfigRevision");
            let current = number(&pool.configuration, "inferenceConfigRevision");
            if revision < current {
                return Ok(false);
            }
            if revision == current
                && (pool.configuration_known || input.get("maxConcurrentInference").is_none())
            {
                if configuration["maxConcurrentInference"]
                    != pool.configuration["maxConcurrentInference"]
                {
                    bail!("Conflicting provider inference configuration revision.");
                }
                return Ok(true);
            }
        }
        let pool = state.pools.get_mut(&provider).unwrap();
        pool.configuration = configuration;
        pool.configuration_known = (!replaced && pool.configuration_known)
            || input.get("maxConcurrentInference").is_some();
        pool.disabled = false;
        self.drain(state, &provider, effects);
        self.changed(state, effects);
        Ok(true)
    }
    pub(super) fn disable_pool(
        &self,
        state: &mut State,
        provider: &JsString,
        effects: &mut Effects,
    ) {
        let Some(pool) = state.pools.get_mut(provider) else {
            return;
        };
        pool.disabled = true;
        let operations = pool
            .queue
            .iter()
            .chain(&pool.active)
            .chain(&pool.suspended)
            .copied()
            .collect::<IndexSet<_>>();
        for id in operations {
            if matches!(
                state.tickets[&id].phase,
                Phase::Waiting | Phase::Granted | Phase::Suspended
            ) {
                self.cancel_locked(state, id, unavailable(), effects);
            }
        }
        self.prune_pool(state, provider);
        self.changed(state, effects);
    }
    pub(super) fn prune_pool(&self, state: &mut State, provider: &JsString) {
        if state.pools.get(provider).is_some_and(|pool| {
            pool.disabled
                && !pool.replacing
                && pool.active.is_empty()
                && pool.suspended.is_empty()
                && pool.queue.is_empty()
        }) {
            state.pools.shift_remove(provider);
        }
    }
}
pub(super) fn number(value: &Value, field: &str) -> f64 {
    value[field].as_f64().unwrap()
}
