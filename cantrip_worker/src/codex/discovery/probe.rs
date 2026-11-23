use super::*;
use crate::codex::rpc_client::Client;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
pub struct Options {
    pub cwd: PathBuf,
    pub environment: HashMap<String, String>,
    pub bundled: bool,
    pub platform: String,
    pub probe_timeout: Duration,
    pub version_timeout: Option<Duration>,
}
impl Options {
    pub fn local(cwd: PathBuf, environment: HashMap<String, String>) -> Self {
        Self {
            cwd,
            environment,
            bundled: false,
            platform: crate::platform::platform().into(),
            probe_timeout: Duration::from_secs(10),
            version_timeout: None,
        }
    }
}
async fn collect(mut stream: tokio::sync::mpsc::Receiver<Vec<u8>>) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.recv().await {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            anyhow::bail!("Codex version output exceeded maxBuffer.");
        }
        bytes.extend(chunk);
    }
    Ok(bytes)
}
pub async fn version(binary: &Path, options: &Options) -> Option<JsString> {
    let mut child = codex_utils_pty::spawn_pipe_process_no_stdin(
        binary,
        &["--version".into()],
        &options.cwd,
        &options.environment,
        &None,
        &[],
    )
    .await
    .ok()?;
    let timeout = options.version_timeout.unwrap_or_else(|| {
        Duration::from_secs(if options.bundled && options.platform == "win32" {
            120
        } else {
            5
        })
    });
    let work = async {
        let (out, err, status) =
            tokio::try_join!(collect(child.stdout_rx), collect(child.stderr_rx), async {
                Ok::<_, anyhow::Error>(child.exit_rx.await?)
            })?;
        if status != 0 {
            return Ok(None);
        }
        let stdout = JsString::from(String::from_utf8_lossy(&out).as_ref()).trim();
        let value = if stdout.is_empty() {
            JsString::from(String::from_utf8_lossy(&err).as_ref()).trim()
        } else {
            stdout
        };
        Ok::<_, anyhow::Error>((!value.is_empty()).then_some(value))
    };
    // execFile's zero timeout disables the deadline rather than firing now.
    let result = if timeout.is_zero() {
        Ok(work.await)
    } else {
        tokio::time::timeout(timeout, work).await
    };
    child.session.terminate_and_wait().await;
    result.ok().and_then(Result::ok).flatten()
}
async fn feature_pages(client: &Client) -> Result<Value> {
    let mut features = Vec::<Value>::new();
    let mut errors = Vec::<Value>::new();
    let mut cursor = Value::Null;
    for _ in 0..20 {
        let response = client
            .request(
                "experimentalFeature/list".into(),
                Some(json!({"cursor":cursor,"limit":100})),
            )
            .await?;
        if response.get("error").is_some() {
            let unavailable = response["error"]["code"] == json!(-32601);
            if !unavailable {
                errors.push(response["error"]["message"].clone());
            }
            return Ok(
                json!({"features":features,"state":if unavailable {"unavailable"}else{"unknown"},"errors":errors}),
            );
        }
        let Some(page) = feature_page(&response["result"]) else {
            errors.push(s(
                "Codex returned an invalid experimentalFeature/list response.",
            ));
            return Ok(json!({"features":features,"state":"unknown","errors":errors}));
        };
        features.extend(page["data"].as_array().unwrap().iter().cloned());
        cursor = page["nextCursor"].clone();
        if !coercion::truthy(Some(&cursor)) {
            return Ok(json!({"features":features,"state":"available","errors":errors}));
        }
    }
    errors.push(s(
        "Codex feature discovery exceeded the 20-page safety limit.",
    ));
    Ok(json!({"features":features,"state":"unknown","errors":errors}))
}
async fn probe(binary: &Path, home: &Path, options: &Options, experimental: bool) -> Result<Value> {
    let client = Client::spawn(
        binary,
        home,
        &options.cwd,
        &options.environment,
        options.probe_timeout,
    )
    .await?;
    let outcome=async {
        let result=client.initialize("cantrip_compatibility_probe","Cantrip Compatibility Probe","0.0.0",experimental).await;
        let (initialized,error)=match result {
            Ok(response)=>{let init=initialize(&response,experimental);let error=init.is_none().then(||s("Codex returned an invalid initialize response."));(init,error)}
            Err(error)=>(None,Some(s(crate::error::message(&error)))),
        };
        let Some(initialized)=initialized else{return Ok(json!({"initialize":Value::Null,"methods":json!({}),"features":Vec::<Value>::new(),"errors":error.into_iter().collect::<Vec<_>>()}));};
        let feature=if experimental {feature_pages(&client).await?}else{json!({"features":Vec::<Value>::new(),"state":"unavailable","errors":Vec::<Value>::new()})};
        let mut methods=json!({"initialize":"available","experimentalFeature/list":feature["state"]});let mut errors=feature["errors"].as_array().unwrap().clone();
        for method in super::methods().filter(|method|!matches!(*method,"initialize"|"experimentalFeature/list")) {
            match client.request(method.into(),Some(json!(false))).await {
                Ok(response)=>methods[method]=s(if response["error"]["code"]==json!(-32601){"unavailable"}else{"available"}),
                Err(error)=>{methods[method]=s("unknown");errors.push(s(crate::error::message(&error)));},
            }
        }
        Ok(json!({"initialize":initialized,"methods":methods,"features":feature["features"],"errors":errors}))
    }.await;
    client.close().await?;
    outcome
}
pub async fn discover(binary: &Path, home: &Path, options: &Options) -> Result<Value> {
    let Some(raw) = version(binary, options).await else {
        return assess(&json!({"versionRaw":Value::Null,"initialize":Value::Null}));
    };
    tokio::fs::create_dir_all(home)
        .await
        .map_err(|error| crate::filesystem::explorer::io_error("mkdir", home, error))?;
    let outcome = async {
        let mut result = probe(binary, home, options, true).await?;
        if result["initialize"].is_null() {
            let first = result["errors"].as_array().unwrap().clone();
            result = probe(binary, home, options, false).await?;
            result["errors"] = Value::Array(
                first
                    .into_iter()
                    .chain(result["errors"].as_array().unwrap().iter().cloned())
                    .collect(),
            );
        }
        result["versionRaw"] = s(raw.clone());
        assess(&result)
    }
    .await;
    match outcome {
        Ok(report) => Ok(report),
        Err(error) => assess(
            &json!({"versionRaw":raw,"initialize":Value::Null,"errors":vec![crate::error::message(&error)]}),
        ),
    }
}
