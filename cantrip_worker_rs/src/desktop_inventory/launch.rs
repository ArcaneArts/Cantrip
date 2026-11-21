use super::{Capture, Captures, Inventory, Scope};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{process::Stdio, time::Duration};
use tokio::{
    process::Command,
    time::{sleep, timeout},
};

const WINDOW_WAIT: Duration = Duration::from_secs(12);
const WINDOW_POLL: Duration = Duration::from_millis(250);

impl Captures {
    pub(crate) async fn restore_window(
        &self,
        scope: Scope,
        requested: Value,
        authorize_launch: impl Fn() -> Result<()>,
    ) -> Result<(Capture, Inventory)> {
        let application = requested["application"]
            .as_js_string()
            .context("Missing desktop application name.")?;
        let inventory = self.inventory(scope.clone()).await?;
        if let Some(target) = application_window(&inventory.windows, &requested, application) {
            let capture = self.open_restored(scope, target, application).await?;
            return Ok((capture, inventory));
        }

        // There is no await between checking the original request's authority
        // and dispatching the platform launcher.
        authorize_launch()?;
        start_application(&application.lossy())
            .await
            .with_context(|| format!("Could not launch {}.", application.lossy()))?;
        let waiting = async {
            loop {
                let inventory = self.inventory(scope.clone()).await?;
                if let Some(target) =
                    application_window(&inventory.windows, &requested, application)
                {
                    let capture = self.open_restored(scope, target, application).await?;
                    return Ok((capture, inventory));
                }
                sleep(WINDOW_POLL).await;
            }
        };
        timeout(WINDOW_WAIT, waiting)
            .await
            .with_context(|| format!("{} did not open a capturable window.", application.lossy()))?
    }

    async fn open_restored(
        &self,
        scope: Scope,
        target: Value,
        application: &JsString,
    ) -> Result<Capture> {
        let capture = self.open(scope, target).await?;
        ensure!(
            same_label(&capture.selected_target()?["application"], application),
            "The desktop window changed applications before capture."
        );
        Ok(capture)
    }
}

fn same_label(value: &Value, expected: &JsString) -> bool {
    value
        .as_js_string()
        .is_some_and(|label| label.lowercase() == expected.lowercase())
}

fn application_window(
    windows: &[Value],
    requested: &Value,
    application: &JsString,
) -> Option<Value> {
    let mut candidates = windows
        .iter()
        .filter(|window| same_label(&window["application"], application));
    let first = candidates.next()?;
    let mut candidates = std::iter::once(first).chain(candidates);
    let selected = requested["id"]
        .as_str()
        .and_then(|id| candidates.clone().find(|window| window["id"] == id))
        .or_else(|| {
            let title = requested["title"].as_js_string()?;
            candidates.find(|window| same_label(&window["title"], title))
        })
        .unwrap_or(first);
    Some(json!({
        "kind":"window","application":selected["application"],"title":selected["title"],"id":selected["id"]
    }))
}

async fn start_application(application: &str) -> Result<()> {
    let mut command;
    #[cfg(target_os = "macos")]
    {
        command = Command::new("open");
        command.args(["-g", "-a", application]);
    }
    #[cfg(windows)]
    {
        command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Process -ErrorAction Stop -FilePath $env:CANTRIP_DESKTOP_APPLICATION",
            ])
            .env("CANTRIP_DESKTOP_APPLICATION", application)
            .creation_flags(0x08000000);
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        command = Command::new(application);
        #[cfg(unix)]
        command.process_group(0);
    }
    command
        .env_remove("CANTRIP_WORKER_CREDENTIAL")
        .env_remove("CANTRIP_WORKER_TOKEN")
        .env_remove("CANTRIP_WORKER_ENROLLMENT_CODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    if cfg!(any(target_os = "macos", windows)) {
        match timeout(Duration::from_secs(6), child.wait()).await {
            Ok(status) => {
                let status = status?;
                ensure!(
                    status.success(),
                    "The application launcher exited with {status}."
                );
            }
            Err(_) => {
                let _ = child.kill().await;
                bail!("The application launcher timed out.");
            }
        }
    } else {
        // Reap when the independent GUI exits. Worker disconnects and shutdown
        // leave this explicitly launched application under the desktop's owner.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
    }
    Ok(())
}
