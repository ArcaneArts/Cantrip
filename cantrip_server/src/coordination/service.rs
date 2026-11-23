//! The same coordinator interface consumed by the reference bridge/services.
//! Futures own each operation; alternate implementations can model interruption
//! at an await boundary without changing bridge logic or production Redis code.
use super::{Listener, RedisCoordinator};
use crate::wire::{JsString, Value};
use anyhow::Result;
use futures::future::BoxFuture;
use std::sync::Arc;
pub trait RelayCoordinator: Send + Sync + 'static {
    fn instance_id(&self) -> &str;
    fn presence_ttl_ms(&self) -> u64;
    fn stats(&self) -> Value;
    fn subscribe(&self, listener: Listener) -> u64;
    fn unsubscribe(&self, id: u64);
    fn cached_worker(&self, worker: &JsString) -> Option<Value>;
    fn start(self: Arc<Self>) -> BoxFuture<'static, Result<()>>;
    fn begin_shutdown(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<()>>;
    fn health(&self) -> BoxFuture<'_, Result<bool>>;
    fn publish(&self, payload: Value, ttl: Option<f64>) -> BoxFuture<'_, Result<()>>;
    fn claim_worker(&self, input: Value) -> BoxFuture<'_, Result<Option<Value>>>;
    fn find_worker<'a>(&'a self, worker: &'a JsString) -> BoxFuture<'a, Result<Option<Value>>>;
    fn lookup_worker_claim<'a>(
        &'a self,
        worker: &'a JsString,
    ) -> BoxFuture<'a, Result<Option<Value>>>;
    fn refresh_worker<'a>(
        &'a self,
        worker: &'a JsString,
        connection: &'a JsString,
    ) -> BoxFuture<'a, Result<bool>>;
    fn release_worker<'a>(
        &'a self,
        worker: &'a JsString,
        connection: &'a JsString,
    ) -> BoxFuture<'a, Result<bool>>;
    fn claim_worker_link_session(&self, claim: Value) -> BoxFuture<'_, Result<Option<Value>>>;
    fn find_worker_link_session<'a>(
        &'a self,
        session: &'a JsString,
    ) -> BoxFuture<'a, Result<Option<Value>>>;
    fn refresh_worker_link_session(&self, claim: Value) -> BoxFuture<'_, Result<bool>>;
    fn release_worker_link_session<'a>(
        &'a self,
        session: &'a JsString,
        authority: &'a JsString,
    ) -> BoxFuture<'a, Result<bool>>;
}
impl RelayCoordinator for RedisCoordinator {
    fn instance_id(&self) -> &str {
        RedisCoordinator::instance_id(self)
    }
    fn presence_ttl_ms(&self) -> u64 {
        RedisCoordinator::presence_ttl_ms(self)
    }
    fn stats(&self) -> Value {
        RedisCoordinator::stats(self)
    }
    fn subscribe(&self, listener: Listener) -> u64 {
        RedisCoordinator::subscribe(self, listener)
    }
    fn unsubscribe(&self, id: u64) {
        RedisCoordinator::unsubscribe(self, id);
    }
    fn cached_worker(&self, worker: &JsString) -> Option<Value> {
        RedisCoordinator::cached_worker(self, worker)
    }
    fn start(self: Arc<Self>) -> BoxFuture<'static, Result<()>> {
        Box::pin(async move { RedisCoordinator::start(&self).await })
    }
    fn close(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(RedisCoordinator::close(self))
    }
    fn begin_shutdown(&self) {
        RedisCoordinator::begin_shutdown(self);
    }
    fn health(&self) -> BoxFuture<'_, Result<bool>> {
        Box::pin(RedisCoordinator::health(self))
    }
    fn publish(&self, payload: Value, ttl: Option<f64>) -> BoxFuture<'_, Result<()>> {
        Box::pin(RedisCoordinator::publish(self, payload, ttl))
    }
    fn claim_worker(&self, input: Value) -> BoxFuture<'_, Result<Option<Value>>> {
        Box::pin(RedisCoordinator::claim_worker(self, input))
    }
    fn find_worker<'a>(&'a self, worker: &'a JsString) -> BoxFuture<'a, Result<Option<Value>>> {
        Box::pin(RedisCoordinator::find_worker(self, worker))
    }
    fn lookup_worker_claim<'a>(
        &'a self,
        worker: &'a JsString,
    ) -> BoxFuture<'a, Result<Option<Value>>> {
        Box::pin(RedisCoordinator::lookup_worker_claim(self, worker))
    }
    fn refresh_worker<'a>(
        &'a self,
        worker: &'a JsString,
        connection: &'a JsString,
    ) -> BoxFuture<'a, Result<bool>> {
        Box::pin(RedisCoordinator::refresh_worker(self, worker, connection))
    }
    fn release_worker<'a>(
        &'a self,
        worker: &'a JsString,
        connection: &'a JsString,
    ) -> BoxFuture<'a, Result<bool>> {
        Box::pin(RedisCoordinator::release_worker(self, worker, connection))
    }
    fn claim_worker_link_session(&self, claim: Value) -> BoxFuture<'_, Result<Option<Value>>> {
        Box::pin(RedisCoordinator::claim_worker_link_session(self, claim))
    }
    fn find_worker_link_session<'a>(
        &'a self,
        session: &'a JsString,
    ) -> BoxFuture<'a, Result<Option<Value>>> {
        Box::pin(RedisCoordinator::find_worker_link_session(self, session))
    }
    fn refresh_worker_link_session(&self, claim: Value) -> BoxFuture<'_, Result<bool>> {
        Box::pin(RedisCoordinator::refresh_worker_link_session(self, claim))
    }
    fn release_worker_link_session<'a>(
        &'a self,
        session: &'a JsString,
        authority: &'a JsString,
    ) -> BoxFuture<'a, Result<bool>> {
        Box::pin(RedisCoordinator::release_worker_link_session(
            self, session, authority,
        ))
    }
}
