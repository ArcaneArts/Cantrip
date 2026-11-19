//! Headless Chromium health check for the native worker and managed packages.
use anyhow::{Context, Result, ensure};
use cantrip_browser::{Browser, Exit, Launch, Page};
use cantrip_wire::{Value, value::json};
use http_body_util::Full;
use hyper::{Response, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use std::{convert::Infallible, ffi::OsString, path::Path, time::Duration};
use tokio::{net::TcpListener, task::JoinSet};

pub fn run(mut args: impl Iterator<Item = OsString>) -> Result<()> {
    let executable = args
        .next()
        .context("Usage: cantrip-worker chromium-probe <executable>")?;
    ensure!(
        args.next().is_none(),
        "Usage: cantrip-worker chromium-probe <executable>"
    );
    let report = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(probe(Path::new(&executable)))?;
    println!("{}", report.stringify());
    Ok(())
}

async fn probe(executable: &Path) -> Result<Value> {
    let root = tempfile::Builder::new()
        .prefix("cantrip-chromium-probe-")
        .tempdir()?;
    let directory = root.path().canonicalize()?;
    let profile = directory.join("profile");
    let home = directory.join("home");
    let temporary = directory.join("temp");
    for private in [&home, &temporary] {
        cantrip_host::files::private_directory(private)?;
    }
    let environment = [
        Some(("HOME".into(), home.into_os_string())),
        Some(("TMPDIR".into(), temporary.clone().into_os_string())),
        Some(("TEMP".into(), temporary.clone().into_os_string())),
        Some(("TMP".into(), temporary.into_os_string())),
        Some(("PATH".into(), OsString::new())),
        std::env::var_os("SystemRoot").map(|root| ("SystemRoot".into(), root)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let fixture = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/", fixture.local_addr()?);
    let mut server = JoinSet::new();
    server.spawn(serve(fixture));
    let browser = Browser::launch(Launch {
        executable,
        profile: &profile,
        viewport: (1024, 768),
        environment: Some(&environment),
    })
    .await?;
    let checked = check_browser(&browser, &url).await;
    let shutdown = browser.close().await;
    server.shutdown().await;
    let mut receipt = checked?;
    receipt["shutdown"] = json!(match shutdown? {
        Exit::Exited => "exited",
        Exit::Terminated => "terminated",
        Exit::Forced => "forced",
    });
    root.close()?;
    Ok(receipt)
}

async fn serve(listener: TcpListener) {
    let mut served = JoinSet::new();
    loop {
        tokio::select! {
            outcome = listener.accept() => {
                let Ok((socket, _)) = outcome else { break };
                served.spawn(async move {
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(socket), service_fn(|_| async {
                        Ok::<_, Infallible>(Response::builder()
                            .header("content-type", "text/html; charset=utf-8")
                            .body(Full::new(bytes::Bytes::from_static(
                                b"<!doctype html><title>Cantrip Chromium probe</title><h1>Cantrip browser ready</h1><button>Inspect</button>",
                            )))
                            .expect("valid Chromium probe response"))
                    })).await;
                });
            }
            _ = served.join_next(), if !served.is_empty() => {}
        }
    }
}

async fn check_browser(browser: &Browser, url: &str) -> Result<Value> {
    let version = browser
        .client()
        .request("Browser.getVersion", json!({}), None)
        .await?;
    let first = browser.new_context().await?;
    let second = browser.new_context().await?;
    let (page, separate) = tokio::try_join!(
        browser.new_page(Some(&first)),
        browser.new_page(Some(&second))
    )?;
    tokio::try_join!(load(&page, url), load(&separate, url))?;
    let snapshot = page
        .request("Accessibility.getFullAXTree", json!({}))
        .await?;
    let nodes = snapshot["nodes"]
        .as_array()
        .context("Chromium returned no accessibility tree.")?;
    for (role, name) in [("heading", "Cantrip browser ready"), ("button", "Inspect")] {
        ensure!(
            nodes
                .iter()
                .any(|node| node["role"]["value"] == role && node["name"]["value"] == name),
            "Chromium accessibility probe did not find {role} {name}."
        );
    }
    page.evaluate("localStorage.setItem('cantripProbe', 'isolated')")
        .await?;
    ensure!(
        page.evaluate("localStorage.getItem('cantripProbe')")
            .await?
            == "isolated"
            && separate
                .evaluate("localStorage.getItem('cantripProbe')")
                .await?
                == Value::Null,
        "Chromium did not isolate the two browser contexts."
    );
    page.close().await?;
    browser.close_context(&first).await?;
    browser.close_context(&second).await?;
    Ok(json!({
        "product": version["product"],
        "protocolVersion": version["protocolVersion"],
        "accessibility": true,
        "isolatedContexts": true
    }))
}

async fn load(page: &Page, url: &str) -> Result<()> {
    page.request("Page.enable", json!({})).await?;
    page.request("Page.setLifecycleEventsEnabled", json!({"enabled":true}))
        .await?;
    let mut events = page.subscribe();
    let navigation = page.request("Page.navigate", json!({"url":url})).await?;
    ensure!(
        navigation["errorText"] == Value::Null,
        "Chromium could not load the probe page."
    );
    let loader = navigation["loaderId"]
        .as_js_string()
        .context("Chromium did not start a probe page navigation.")?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.next().await?;
            if event.method() == "Page.lifecycleEvent"
                && event.params()["name"] == "DOMContentLoaded"
                && event.params()["loaderId"].as_js_string() == Some(loader)
            {
                return Ok(());
            }
        }
    })
    .await
    .context("Chromium probe page did not load.")?
}
