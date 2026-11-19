//! Supervise a private Chromium profile and use the native DevTools protocol.
mod cdp;
mod process;

pub use cdp::{Client, Event, Subscription};
pub use process::Exit;

use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{ffi::OsString, net::SocketAddrV4, path::Path, sync::Arc, time::Duration};

pub struct Launch<'a> {
    pub executable: &'a Path,
    pub profile: &'a Path,
    pub viewport: (u32, u32),
    /// When supplied, these are the entire environment of the child.
    pub environment: Option<&'a [(OsString, OsString)]>,
}

pub struct Browser {
    client: Client,
    process: process::Process,
}

impl Browser {
    pub async fn launch(options: Launch<'_>) -> Result<Self> {
        Self::launch_inner(options, None).await
    }

    pub async fn launch_intercepted(options: Launch<'_>, deny_proxy: SocketAddrV4) -> Result<Self> {
        ensure!(
            deny_proxy.ip().is_loopback(),
            "Chromium deny proxy must be loopback."
        );
        Self::launch_inner(options, Some(deny_proxy)).await
    }

    async fn launch_inner(options: Launch<'_>, deny_proxy: Option<SocketAddrV4>) -> Result<Self> {
        ensure!(
            options.profile.is_absolute(),
            "Chromium needs an absolute profile path."
        );
        cantrip_host::files::private_directory(options.profile)?;
        let (process, endpoint) = process::Process::launch(options, deny_proxy)?;
        let handshake = async {
            let url = tokio::time::timeout(Duration::from_secs(20), endpoint)
                .await
                .context("Timed out waiting for Chromium remote debugging.")?
                .context("Chromium exited before remote debugging was ready.")??;
            let client = Client::connect(url, deny_proxy.is_some()).await?;
            client
                .request("Browser.getVersion", json!({}), None)
                .await?;
            client
                .request("Target.setDiscoverTargets", json!({"discover":true}), None)
                .await?;
            Ok::<_, anyhow::Error>(client)
        };
        match handshake.await {
            Ok(client) => Ok(Self { process, client }),
            Err(error) => match process.stop().await {
                Ok(_) => Err(error),
                Err(process_error) => Err(error.context(process_error)),
            },
        }
    }

    pub fn is_connected(&self) -> bool {
        self.client.is_connected()
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub async fn new_context(&self) -> Result<JsString> {
        let result = self
            .client
            .request(
                "Target.createBrowserContext",
                json!({"disposeOnDetach":true}),
                None,
            )
            .await?;
        identity(&result, "browserContextId")
    }

    pub async fn close_context(&self, context: &JsString) -> Result<()> {
        self.client
            .request(
                "Target.disposeBrowserContext",
                json!({"browserContextId":context}),
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn new_page(&self, context: Option<&JsString>) -> Result<Page> {
        let mut options = json!({"url":"about:blank"});
        if let Some(context) = context {
            options["browserContextId"] = json!(context);
        }
        let result = self
            .client
            .request("Target.createTarget", options, None)
            .await?;
        let target = identity(&result, "targetId")?;
        let attached = self
            .client
            .request(
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
                None,
            )
            .await
            .and_then(|attached| identity(&attached, "sessionId"));
        match attached {
            Ok(session) => Ok(Page {
                client: self.client.clone(),
                watcher: self.client.watch_target(&target, &session),
                target,
                session,
            }),
            Err(error) => {
                let _ = close_target(&self.client, &target).await;
                Err(error)
            }
        }
    }

    pub async fn close(self) -> Result<Exit> {
        let requested = tokio::time::timeout(
            Duration::from_secs(2),
            self.client.request("Browser.close", json!({}), None),
        )
        .await;
        // Some Chromium builds finish shutting down over the active DevTools
        // connection. Preserve it until the child actually exits.
        let exited = self.process.stop().await;
        self.client.close();
        match (exited, requested) {
            (Err(error), Ok(Err(request_error))) => Err(error.context(request_error)),
            (Err(error), Err(_)) => {
                Err(error.context("Chromium did not acknowledge Browser.close."))
            }
            (result, _) => result,
        }
    }
}

#[derive(Clone)]
pub struct Page {
    client: Client,
    target: JsString,
    session: JsString,
    watcher: Arc<cdp::Target>,
}

impl Page {
    pub fn is_connected(&self) -> bool {
        self.watcher.is_open() && self.client.is_connected()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        tokio::select! {
            biased;
            _ = self.watcher.closed() => bail!("Chromium page was detached or crashed."),
            result = self.client.request(method, params, Some(&self.session)) => result,
        }
    }

    pub fn session(&self) -> &JsString {
        &self.session
    }

    pub fn subscribe(&self) -> Subscription {
        self.client.subscribe_page(&self.watcher)
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        self.evaluate_in(expression, None).await
    }

    pub async fn evaluate_in(&self, expression: &str, context: Option<u64>) -> Result<Value> {
        let mut params = json!({"expression":expression,"returnByValue":true,"awaitPromise":true});
        if let Some(context) = context {
            params["contextId"] = json!(context);
        }
        let result = self.request("Runtime.evaluate", params).await?;
        if result.get("exceptionDetails").is_some() {
            // The page can include private source, page content or URLs in
            // exception details. Leave those in the browser.
            bail!("Chromium page evaluation failed.");
        }
        Ok(result["result"]
            .get("value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn close(self) -> Result<()> {
        close_target(&self.client, &self.target).await
    }
}

fn identity(value: &Value, key: &str) -> Result<JsString> {
    value[key]
        .as_js_string()
        .filter(|id| !id.is_empty())
        .cloned()
        .with_context(|| format!("Chromium did not return a {key}."))
}

async fn close_target(client: &Client, target: &JsString) -> Result<()> {
    client
        .request("Target.closeTarget", json!({"targetId":target}), None)
        .await?;
    Ok(())
}
