use super::*;
impl Owner {
    /// Registration is synchronous so a shared claim cannot reorder frames.
    pub fn journal(&self, command: Value) -> Work<Response> {
        let (send, receive) = tokio::sync::oneshot::channel();
        let start = {
            let mut state = self.0.state.lock().unwrap();
            state.journal.push_back((command, send));
            let start = !state.sending;
            state.sending = true;
            start
        };
        if start {
            let this = self.clone();
            tokio::spawn(async move {
                loop {
                    let result = this.ensure_owner().await;
                    let batch = {
                        let mut state = this.0.state.lock().unwrap();
                        if state.journal.is_empty() {
                            state.sending = false;
                            return;
                        }
                        state.journal.drain(..).collect::<Vec<_>>()
                    };
                    for (command, send) in batch {
                        let helper = this
                            .0
                            .state
                            .lock()
                            .unwrap()
                            .keeper
                            .as_ref()
                            .map(|v| v.helper.clone());
                        if let Err(error) = &result {
                            let _ = send
                                .send(Err(
                                    crate::error::WireError(crate::error::message(error)).into()
                                ));
                        } else if let Some(helper) = helper.filter(|_| this.available()) {
                            let work = helper.journal(command);
                            tokio::spawn(async move {
                                let _ = send.send(work.await);
                            });
                        } else {
                            let _ = send
                                .send(Err(anyhow!("Native inference journal has no live owner.")));
                        }
                    }
                }
            });
        }
        let keep = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let _keep = keep;
            receive
                .await
                .map_err(|_| anyhow!("Native inference journal owner exited."))?
        })
    }
}
