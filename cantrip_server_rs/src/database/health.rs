use super::Database;
use crate::{
    operations::logging::{self, LogCall},
    wire::value::json,
};
use anyhow::Result;
use std::time::{Duration, Instant};

const POSTGRES_READINESS_TIMEOUT: Duration = Duration::from_secs(3);

impl Database {
    /// The reference's explicit health probe, not a wrapper around normal SQL.
    pub async fn ping(&self) -> Result<()> {
        self.check_health(None).await
    }

    pub(crate) async fn ping_for_readiness(&self) -> Result<()> {
        let deadline = match &self.backend {
            super::Backend::Postgres(_) => Some(POSTGRES_READINESS_TIMEOUT),
            super::Backend::Pglite(_) => None,
        };
        self.check_health(deadline).await
    }

    async fn check_health(&self, deadline: Option<Duration>) -> Result<()> {
        let started = Instant::now();
        let probe = self.query("SELECT 1", &[]);
        let result = match deadline {
            Some(timeout) => match tokio::time::timeout(timeout, probe).await {
                Ok(result) => result,
                Err(error) => {
                    Err(anyhow::Error::new(error).context("PostgreSQL readiness query timed out"))
                }
            },
            None => probe.await,
        };
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
