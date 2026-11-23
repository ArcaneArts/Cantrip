use super::*;
impl Manager {
    pub fn create_runtime(&self) -> Result<Runtime> {
        self.create_owned_runtime(None)
    }
    pub(super) fn create_owned_runtime(
        &self,
        direct_owner: Option<DirectOwner>,
    ) -> Result<Runtime> {
        self.edit(|state, _| {
            if state.closing {
                bail!("The inference admission service is closing.");
            }
            let id = state.id();
            let generation = JsString::from(uuid::Uuid::new_v4().to_string());
            state.runtimes.insert(
                id,
                RuntimeData {
                    generation: generation.clone(),
                    records: IndexMap::new(),
                    retired: false,
                    prepared: direct_owner.is_some() || self.0.options.ownership.is_none(),
                    direct_owner,
                    retiring: None,
                },
            );
            Ok(Runtime {
                manager: self.clone(),
                id,
                generation,
            })
        })
    }
    pub(super) fn prepare_native_launch(
        &self,
        id: Id,
        generation: JsString,
    ) -> Work<HashMap<String, String>> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            if this
                .0
                .state
                .lock()
                .unwrap()
                .runtimes
                .get(&id)
                .is_some_and(|runtime| runtime.direct_owner.is_some())
            {
                bail!("A direct inference owner cannot launch a native runtime.");
            }
            this.prepare_recovery().work().await?;
            let environment = match &this.0.options.ownership {
                Some(owner) => owner.prepare(generation).await?,
                None => HashMap::new(),
            };
            this.edit(|state, effects| {
                if state.closing
                    || state
                        .runtimes
                        .get(&id)
                        .is_none_or(|runtime| runtime.retiring.is_some() || runtime.retired)
                {
                    bail!("The inference runtime was retired during launch.");
                }
                state.runtimes.get_mut(&id).unwrap().prepared = true;
                for provider in state.pools.keys().cloned().collect::<Vec<_>>() {
                    this.drain(state, &provider, effects);
                }
                Ok(())
            })?;
            Ok(environment)
        })
    }
    pub(super) fn retire(&self, runtime_id: Id) -> Promise<()> {
        self.edit(|state, effects| {
            let Some(runtime) = state.runtimes.get_mut(&runtime_id) else {
                return Ok(Promise::ready(Ok(())));
            };
            if let Some(retiring) = &runtime.retiring {
                return Ok(retiring.clone());
            }
            if runtime.retired {
                return Ok(Promise::ready(Ok(())));
            }
            let (complete, pending) = Promise::pair();
            runtime.retiring = Some(pending.clone());
            let generation = runtime.generation.clone();
            let direct = runtime.direct_owner.clone();
            for pool in state.pools.values_mut() {
                pool.queue
                    .retain(|id| state.tickets[id].runtime != runtime_id);
            }
            let tickets = state.runtimes[&runtime_id]
                .records
                .values()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>();
            for id in tickets {
                self.cancel_locked(
                    state,
                    id,
                    anyhow!("Inference operation cancelled."),
                    effects,
                );
            }
            effects.push(Box::new(move |manager| {
                let manager = manager.clone();
                tokio::spawn(async move {
                    let result = async {
                        if let Some(direct) = direct {
                            (direct.cancel)(anyhow!("Direct inference ownership is retiring."));
                            direct.settled.work().await?;
                        } else if let Some(owner) = &manager.0.options.ownership {
                            owner.retire(generation).await?;
                        }
                        let dependencies = {
                            let state = manager.0.state.lock().unwrap();
                            state
                                .runtimes
                                .get(&runtime_id)
                                .into_iter()
                                .flat_map(|runtime| runtime.records.values())
                                .flat_map(|(id, _)| {
                                    state.tickets[id].external_work.values().cloned()
                                })
                                .collect::<Vec<_>>()
                        };
                        futures::future::try_join_all(dependencies.iter().map(Promise::work))
                            .await?;
                        manager.edit(|state, effects| {
                            let Some(runtime) = state.runtimes.get_mut(&runtime_id) else {
                                return Ok(());
                            };
                            runtime.retired = true;
                            for pool in state.pools.values_mut() {
                                pool.queue
                                    .retain(|id| state.tickets[id].runtime != runtime_id);
                            }
                            let ids = state.runtimes[&runtime_id]
                                .records
                                .values()
                                .map(|(id, _)| *id)
                                .collect::<Vec<_>>();
                            for id in &ids {
                                if matches!(
                                    state.tickets[id].phase,
                                    Phase::Waiting | Phase::Granted
                                ) {
                                    manager.cancel_locked(
                                        state,
                                        *id,
                                        anyhow!("Inference operation cancelled."),
                                        effects,
                                    );
                                }
                            }
                            let ids = state.runtimes[&runtime_id]
                                .records
                                .values()
                                .map(|(id, _)| *id)
                                .collect::<Vec<_>>();
                            for id in ids {
                                manager.settle_locked(
                                    state,
                                    id,
                                    Outcome::RuntimeExited,
                                    effects,
                                )?;
                                let abort = state.tickets[&id].abort.clone();
                                effects.push(Box::new(move |_| {
                                    abort.abort(anyhow!("The inference runtime exited."))
                                }));
                            }
                            state.runtimes.shift_remove(&runtime_id);
                            manager.changed(state, effects);
                            Ok(())
                        })
                    }
                    .await;
                    complete.finish(result);
                });
            }));
            Ok(pending)
        })
        .unwrap()
    }
    pub fn close(&self) -> Work<()> {
        self.edit(|state, effects| {
            if let Some(closure) = &state.closure {
                return Ok(closure.clone());
            }
            state.closing = true;
            if let Some(retry) = state.recovery_retry.take() {
                retry.abort();
            }
            let (complete, pending) = Promise::pair();
            state.closure = Some(pending.clone());
            let runtimes = state.runtimes.keys().copied().collect::<Vec<_>>();
            effects.push(Box::new(move |manager| {
                manager
                    .0
                    .recovery_abort
                    .abort(anyhow!("Inference ownership is retiring."));
                let retired = runtimes
                    .into_iter()
                    .map(|id| manager.retire(id))
                    .collect::<Vec<_>>();
                let manager = manager.clone();
                tokio::spawn(async move {
                    let result = async {
                        futures::future::try_join_all(retired.iter().map(Promise::work)).await?;
                        let (startup, work) = {
                            let state = manager.0.state.lock().unwrap();
                            (
                                state
                                    .recovery_startup
                                    .as_ref()
                                    .map(|(_, pending)| pending.clone()),
                                state.recovery_work.clone(),
                            )
                        };
                        if let Some(startup) = startup {
                            let _ = startup.work().await;
                        }
                        if let Some(work) = work {
                            let _ = work.work().await;
                        }
                        if let Some(journal) = &manager.0.journal {
                            journal.flush().await?;
                        }
                        if let Some(owner) = &manager.0.options.ownership {
                            owner.close().await?;
                        }
                        let mut state = manager.0.state.lock().unwrap();
                        state.unrequested_settlements.clear();
                        state.goal_preparations.clear();
                        Ok(())
                    }
                    .await;
                    complete.finish(result);
                });
            }));
            Ok(pending)
        })
        .unwrap()
        .work()
    }
}
