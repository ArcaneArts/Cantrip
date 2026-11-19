#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    cantrip_worker::guest_run_definitions::run()
}

#[cfg(not(target_os = "linux"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("The Cantrip OS Run definition helper runs on Linux.")
}
