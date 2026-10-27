//! Durable account storage and application-payload bandwidth accounting.
pub mod background;
pub mod live_traffic;
mod maintenance;
pub mod meter;
pub mod meter_service;
pub mod repository;
pub mod response;
pub mod service;
mod types;
pub use types::*;

use std::sync::LazyLock;
static CONTRACT: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../contracts/resource-usage.json"))
        .expect("embedded resource usage contract")
});
pub fn measurement_sql() -> &'static str {
    CONTRACT["measurementSql"]
        .as_str()
        .expect("storage measurement SQL")
}
pub fn basis_version() -> &'static str {
    CONTRACT["basisVersion"]
        .as_str()
        .expect("storage accounting basis")
}
