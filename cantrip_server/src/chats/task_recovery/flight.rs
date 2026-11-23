use super::*;
struct Finished {
    state: Arc<Mutex<State>>,
    key: Key,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Drop for Finished {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.recovering.remove(&self.key);
        state.observed_at.insert(self.key.clone(), (self.clock)());
    }
}
impl Service {
    fn admit(
        &self,
        owner: &str,
        chat: &str,
        resume: bool,
        automatic: bool,
    ) -> (Operation, Option<(bool, bool)>) {
        let key = (owner.to_owned(), chat.to_owned());
        let mut state = self.state.lock().unwrap();
        if let Some(prior) = state.recovering.get(&key) {
            return (
                prior.operation.clone(),
                Some((prior.resume, prior.automatic)),
            );
        }
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        let finished = Finished {
            state: self.state.clone(),
            key: key.clone(),
            clock: self.dependencies.clock.clone(),
        };
        let operation = self
            .operations
            .run(async move {
                let _finished = finished;
                Ok(this
                    .run(&owner, &chat, resume, automatic)
                    .await
                    .map_err(Arc::new))
            })
            .map(|received: Result<Outcome>| received.unwrap_or_else(|error| Err(Arc::new(error))))
            .boxed()
            .shared();
        state.recovering.insert(
            key,
            Flight {
                operation: operation.clone(),
                resume,
                automatic,
            },
        );
        (operation, None)
    }
    pub fn recover(
        &self,
        owner: &str,
        chat: &str,
        resume: bool,
        automatic: bool,
    ) -> BoxFuture<'static, Result<bool>> {
        // Admit synchronously: the first call owns the passive/explicit intent
        // even when its caller has not yet polled the returned future.
        let first = self.admit(owner, chat, resume, automatic);
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        self.operations.run(async move {
            let mut selected = first;
            loop {
                let (operation, prior) = selected;
                let recovered = operation
                    .await
                    .map_err(crate::operations::shared_failure::owned)?;
                if prior.is_some_and(|(was_resume, was_automatic)| {
                    resume && (!was_resume || (was_automatic && !automatic))
                }) {
                    selected = this.admit(&owner, &chat, true, automatic);
                } else {
                    return Ok(recovered);
                }
            }
        })
    }
}
