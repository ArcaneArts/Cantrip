//! Runs the desktop's production identity-pinned broker probe without a WebView.
//! Input stays on stdin so disposable capability secrets never enter argv.
#[path = "../src/direct_probe_connection.rs"]
mod direct_probe;

use std::io::{self, BufRead, Write};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request: direct_probe::DirectProbeRequest = serde_json::from_str(&line?)?;
        let result = direct_probe::probe_direct_worker(request).await;
        println!("{}", serde_json::to_string(&result)?);
        io::stdout().flush()?;
    }
    Ok(())
}
