use super::{
    release::{Source, Target},
    runtime::Runtime,
    storage::Storage,
};
use crate::filesystem::Scope;
use cantrip_wire::{Value, value::json};
use flate2::{Compression, write::GzEncoder};
use http_body_util::Full;
use hyper::{Request, Response, body::Bytes, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    fs,
    io::Cursor,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::watch};
use url::Url;

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct Publication {
    version: &'static str,
    archive: Vec<u8>,
    archive_digest: String,
    checksums: Vec<u8>,
}

impl Publication {
    fn new(version: &'static str, healthy_mcp: bool, matching_checksum: bool) -> Self {
        let server_name = if healthy_mcp {
            "codegraph"
        } else {
            "unhealthy"
        };
        let cli = format!(
            r#"#!/bin/sh
[ "$CODEGRAPH_DIR" = ".codegraph-cantrip" ] && [ "$DO_NOT_TRACK" = 1 ] &&
[ "$CODEGRAPH_NO_UPDATE_CHECK" = 1 ] && [ "$CODEGRAPH_TELEMETRY" = 0 ] || exit 7
case "$1" in
  --version) printf '%s\n' '{version}' ;;
  telemetry) test "$2" = off ;;
  serve)
    IFS= read -r request
    case "$request" in *'"method":"initialize"'*) ;; *) exit 8 ;; esac
    printf '%s\n' '{{"jsonrpc":"2.0","id":0,"result":{{"serverInfo":{{"name":"{server_name}"}},"capabilities":{{"tools":{{}}}}}}}}'
    ;;
  *) exit 9 ;;
esac
"#
        );
        let output = GzEncoder::new(Vec::new(), Compression::fast());
        let mut tar = tar::Builder::new(output);
        let mut header = tar::Header::new_gnu();
        header.set_size(cli.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, "distribution/bin/codegraph", Cursor::new(cli))
            .unwrap();
        let archive = tar.into_inner().unwrap().finish().unwrap();
        let archive_digest = digest(&archive);
        let checksum = if matching_checksum {
            archive_digest.clone()
        } else {
            "0".repeat(64)
        };
        let target = Target::host().unwrap();
        let checksums = format!("{checksum}  {}\n", target.asset).into_bytes();
        Self {
            version,
            archive,
            archive_digest,
            checksums,
        }
    }

    fn description(&self, origin: &Url, asset: &str) -> Value {
        let entry = |name: &str, bytes: &[u8], hash: &str| {
            let url = origin
                .join(&format!("download/v{}/{name}", self.version))
                .unwrap();
            json!({"name":name,"size":bytes.len(),"digest":format!("sha256:{hash}"),
                "browser_download_url":url.as_str()})
        };
        json!({"tag_name":format!("v{}",self.version),"draft":false,"prerelease":false,"assets":[
            entry(asset,&self.archive,&self.archive_digest),
            entry("SHA256SUMS",&self.checksums,&digest(&self.checksums))
        ]})
    }
}

#[tokio::test]
async fn verify_publish_reopen_and_preserve_the_active_release() {
    let data = tempfile::tempdir().unwrap();
    let storage = Storage::new(data.path());
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let release = Arc::new(Mutex::new(Publication::new("1.0.0", true, true)));
    let downloads = Arc::new(AtomicUsize::new(0));
    let cache_hits = Arc::new(AtomicUsize::new(0));
    let server = tokio::spawn({
        let (origin, release, downloads, cache_hits) = (
            origin.clone(),
            release.clone(),
            downloads.clone(),
            cache_hits.clone(),
        );
        async move {
            let asset = Target::host().unwrap().asset;
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let (client, _) = accepted.unwrap();
                        let (origin, release, downloads, cache_hits, asset) =
                            (origin.clone(), release.clone(), downloads.clone(), cache_hits.clone(), asset.clone());
                        connections.spawn(async move {
                            let _ = http1::Builder::new().serve_connection(TokioIo::new(client), service_fn(|request: Request<_>| {
                                let publication = release.lock().unwrap();
                                let etag = format!("\"{}\"", publication.version);
                                let url = request.uri().path();
                                let (status, bytes) = if url == "/latest" {
                                    if request.headers().get("if-none-match").is_some_and(|header| header == etag.as_str()) {
                                        cache_hits.fetch_add(1, Ordering::Relaxed);
                                        (304, Vec::new())
                                    } else {
                                        (200, publication.description(&origin, &asset).stringify().into_bytes())
                                    }
                                } else if url == format!("/download/v{}/{}", publication.version, asset) {
                                    downloads.fetch_add(1, Ordering::Relaxed);
                                    (200, publication.archive.clone())
                                } else if url == format!("/download/v{}/SHA256SUMS", publication.version) {
                                    downloads.fetch_add(1, Ordering::Relaxed);
                                    (200, publication.checksums.clone())
                                } else { (404, Vec::new()) };
                                let response = Response::builder().status(status).header("etag", etag)
                                    .body(Full::new(Bytes::from(bytes))).unwrap();
                                std::future::ready(Ok::<_, Infallible>(response))
                            })).await;
                        });
                    }
                }
            }
        }
    });
    let (_cancel, stop) = watch::channel(false);
    let scope = Scope::with_stop(stop.clone());
    let source = Source::fixture(&origin);
    let runtime = Runtime::new(data.path());
    assert!(!runtime.reopen(&scope).await.unwrap());
    assert!(
        runtime
            .update(&source, &scope, stop.clone())
            .await
            .unwrap()
            .0
    );
    let leased = runtime.active().unwrap();
    let first = storage.current().unwrap().unwrap();
    assert_eq!(first.version, "1.0.0");
    assert!(
        first
            .executable
            .starts_with(Path::new("versions").join(&first.package))
    );
    assert!(
        !runtime
            .update(&source, &scope, stop.clone())
            .await
            .unwrap()
            .0
    );
    assert_eq!(cache_hits.load(Ordering::Relaxed), 1);
    assert_eq!(downloads.load(Ordering::Relaxed), 2);

    for version in ["1.1.0", "1.2.0"] {
        *release.lock().unwrap() = Publication::new(version, true, true);
        assert!(
            runtime
                .update(&source, &scope, stop.clone())
                .await
                .unwrap()
                .0
        );
    }
    assert_eq!(runtime.status()["installedVersion"], "1.2.0");
    assert_eq!(runtime.status()["previousVersion"], "1.1.0");
    let executor = leased
        .run(
            &scope,
            data.path(),
            &["--version".into()],
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(
        executor.stdout, b"1.0.0\n",
        "an in-use older release is retained"
    );
    drop(leased);

    let pointer = fs::read(storage.root.join("bin/current.json")).unwrap();
    for (version, healthy, checksum, expected) in [
        ("1.3.0", true, false, "SHA256SUMS"),
        ("1.4.0", false, true, "MCP initialize"),
    ] {
        *release.lock().unwrap() = Publication::new(version, healthy, checksum);
        let error = runtime
            .update(&source, &scope, stop.clone())
            .await
            .unwrap_err();
        assert!(error.to_string().contains(expected), "{error}");
        runtime.failed(&error);
        assert_eq!(runtime.status()["runtimeState"], "degraded");
        assert_eq!(runtime.status()["healthy"], false);
        assert_eq!(runtime.status()["cliAvailable"], true);
        assert_eq!(runtime.status()["installedVersion"], "1.2.0");
        assert_eq!(
            fs::read(storage.root.join("bin/current.json")).unwrap(),
            pointer
        );
        assert_eq!(
            fs::read_dir(storage.root.join("staging")).unwrap().count(),
            0
        );
        assert!(!storage.root.join("update.lock").exists());
    }

    let mut bad_digest = Publication::new("1.5.0", true, true);
    bad_digest.archive_digest = "0".repeat(64);
    *release.lock().unwrap() = bad_digest;
    let error = runtime.update(&source, &scope, stop).await.unwrap_err();
    assert!(error.to_string().contains("GitHub digest"), "{error}");
    assert_eq!(
        fs::read(storage.root.join("bin/current.json")).unwrap(),
        pointer
    );

    drop(runtime);
    let restarted = Runtime::new(data.path());
    assert!(restarted.reopen(&scope).await.unwrap());
    assert_eq!(restarted.status()["installedVersion"], "1.2.0");
    server.abort();
    let _ = server.await;
}
