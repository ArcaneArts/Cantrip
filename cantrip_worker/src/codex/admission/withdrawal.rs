use super::*;

impl Adapter {
    pub fn withdraw_unstarted(
        &self,
        source: &Source,
        reason: Option<anyhow::Error>,
    ) -> Result<Work<Value>> {
        let (operation, preparation, exited) = {
            let state = self.0.state.lock().unwrap();
            let lifetime = state
                .sources
                .iter()
                .find(|entry| entry.source.matches(source))
                .map(|entry| &entry.lifetime);
            let operation = lifetime.and_then(|life| state.operation_for(life));
            let preparation = lifetime.and_then(|life| {
                state
                    .before
                    .iter()
                    .find(|entry| {
                        entry
                            .request
                            .lifetime
                            .as_ref()
                            .is_some_and(|held| held.same(life))
                    })
                    .cloned()
            });
            (operation, preparation, state.exited)
        };
        if let Some(operation) = operation {
            if let Some(proof) = operation.state.lock().unwrap().withdrawal.clone() {
                return Ok(proof.work());
            }
            source.assert_current()?;
            if exited {
                return Err(unused("The canonical input is no longer unforwarded."));
            }
            return self.withdraw_operation(&operation, reason, None, None, false);
        }
        let preparation = preparation
            .ok_or_else(|| unused("This source does not own an inference reservation."))?;
        let mut withdrawal = preparation.withdrawal.lock().unwrap();
        if let Some(proof) = withdrawal.as_ref() {
            return Ok(proof.work());
        }
        source.assert_current()?;
        let reason = Failure::new(
            reason.unwrap_or_else(|| anyhow!("The unrequested response was withdrawn.")),
        );
        let request = preparation
            .request
            .worker_request(preparation.request.lifetime.clone().unwrap());
        let proof = self.0.runtime.withdraw_before_request(
            request,
            reason.error(),
            preparation.finished.clone(),
        )?;
        *preparation.reason.lock().unwrap() = Some(reason.clone());
        preparation.abort.abort(reason.error());
        let proof = Promise::spawn(proof);
        *withdrawal = Some(proof.clone());
        Ok(proof.work())
    }

    pub(super) fn withdraw_operation(
        &self,
        operation: &Arc<Operation>,
        reason: Option<anyhow::Error>,
        withdrawal: Option<Withdrawal>,
        revision: Option<u64>,
        private_goal: bool,
    ) -> Result<Work<Value>> {
        let ticket = operation.ticket()?;
        {
            let mut state = operation.state.lock().unwrap();
            if let Some(proof) = &state.withdrawal {
                return Ok(proof.work());
            }
            if state.settled
                || state.dispatched
                || state.input_dispatching
                || state.lease_started
                || state.starting
                || state.preparing
                || state.transferring
                || (private_goal && (!state.queued || state.revoked || state.observed_start))
                || (!private_goal && state.native_boundary)
            {
                return Err(unused("The canonical input is no longer unforwarded."));
            }
            state.transferring = true;
            state.withdrawal_reason = withdrawal;
        }
        let result = if private_goal {
            ticket.withdraw_task_goal_before_allow(
                reason.expect("private Goal withdrawal has a reason"),
            )
        } else {
            ticket.withdraw_unstarted(reason, revision)
        };
        let proof = {
            let mut state = operation.state.lock().unwrap();
            state.transferring = false;
            match result {
                Ok(work) => {
                    let proof = Promise::spawn(work);
                    state.withdrawal = Some(proof.clone());
                    proof
                }
                Err(error) => {
                    state.withdrawal_reason = None;
                    return Err(error);
                }
            }
        };
        self.settle(operation, Outcome::NeverStarted)?;
        Ok(proof.work())
    }
}
