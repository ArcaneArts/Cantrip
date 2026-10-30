//! Desktop command facade over the shared native broker verifier.
#[path = "direct_probe_connection.rs"]
mod connection;

pub(crate) use connection::connect_verified;
pub use connection::{
    DirectBrokerAdvertisement, DirectCapabilityBinding, DirectProbeRequest, DirectProbeResult,
};

#[tauri::command]
pub async fn probe_direct_worker(request: DirectProbeRequest) -> DirectProbeResult {
    connection::probe_direct_worker(request).await
}
