//! A failed concurrent detail request replies immediately, as Promise.all does.
//! Its sibling remains owned until completion or runtime stop, independently of
//! the response receiver. Shutdown drains these tasks after command admission ends.
use super::{Client, api};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value};
use std::sync::Mutex;
use tokio::{
    sync::oneshot,
    task::{JoinError, JoinSet},
};

#[derive(Default)]
pub(super) struct Reads {
    tasks: JoinSet<()>,
    failure: Option<JoinError>,
}
impl Client {
    pub(super) async fn read_pair(
        &self,
        left: String,
        right: String,
        arguments: Vec<JsString>,
        scope: Scope,
    ) -> Result<(Value, Value)> {
        let (sender, receiver) = oneshot::channel();
        {
            let mut reads = self.reads.lock().unwrap();
            while let Some(result) = reads.tasks.try_join_next() {
                if let Err(error) = result {
                    reads.failure.get_or_insert(error);
                }
            }
            reads.tasks.spawn(async move {
                let reply = Mutex::new(Some(sender));
                let observe = |result: Result<Value>| match result {
                    Ok(value) => Some(value),
                    Err(error) => {
                        if let Some(reply) = reply.lock().unwrap().take() {
                            let _ = reply.send(Err(error));
                        }
                        None
                    }
                };
                let (left, right) = tokio::join!(
                    async { observe(api::request(&left, &[], &scope).await) },
                    async { observe(api::request(&right, &arguments, &scope).await) }
                );
                if let (Some(left), Some(right)) = (left, right)
                    && let Some(reply) = reply.into_inner().unwrap()
                {
                    let _ = reply.send(Ok((left, right)));
                }
            });
        }
        receiver
            .await
            .map_err(|_| anyhow!("GitHub detail read stopped."))?
    }
    /// Stop admission and signal the runtime scope before draining on shutdown.
    /// A fixture may also drain completed reads between response configurations.
    pub async fn drain(&self) -> Result<()> {
        let mut reads = std::mem::take(&mut *self.reads.lock().unwrap());
        while let Some(result) = reads.tasks.join_next().await {
            if let Err(error) = result {
                reads.failure.get_or_insert(error);
            }
        }
        reads.failure.map_or(Ok(()), |error| Err(error.into()))
    }
}
