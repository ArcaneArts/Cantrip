use super::Database;
use crate::{
    operations::logging::{self, LogCall},
    wire::value::json,
};
use anyhow::Result;
use std::time::Instant;

impl Database {
    /// The reference's explicit health probe, not a wrapper around normal SQL.
    pub async fn ping(&self) -> Result<()> {
        let started = Instant::now();
        let result = self.query("SELECT 1", &[]).await;
        let elapsed = started.elapsed().as_millis() as f64;
        match &result {
            Ok(_) if elapsed >= 250.0 => logging::server_logger()(LogCall::event(
                "warn",
                "Database health check was slow",
                json!({"event":"database.health.slow","subsystem":"database","operation":"health-check","status":"degraded","reasonCode":"slow-operation","databaseEngine":self.engine(),"durationMs":elapsed}),
            )),
            Err(error) => logging::server_logger()(LogCall::repeated(
                format!("database-health-failed:{}", self.engine()).into(),
                "error",
                "Database health check failed",
                json!({"event":"database.health.failed","subsystem":"database","operation":"health-check","status":"failed","reasonCode":"query-failed","databaseEngine":self.engine(),"durationMs":elapsed,"error":logging::error_details(error)}),
                Some(json!({"summaryEvery":5,"windowMs":60000})),
            )),
            _ => {}
        }
        result.map(|_| ())
    }
}
