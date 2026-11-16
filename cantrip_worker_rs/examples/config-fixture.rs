//! Development-only oracle driver. Never a worker launcher; secrets emitted
//! here are synthetic fixture inputs and must not be used with real profiles.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    config::{self, Host},
    credentials::{self, Credential},
    installation,
};
use std::{
    io::{self, BufRead},
    path::Path,
};

fn execute(input: &Value) -> Result<Value> {
    let directory = Path::new(input["directory"].as_str().unwrap());
    match input["operation"].as_str().unwrap_or("config") {
        "installation" => Ok(installation::discover(Path::new(input["workerRoot"].as_str().unwrap()), input["platform"].as_str().unwrap(), input["architecture"].as_str().unwrap(), input["override"].as_str()).to_value()),
        "save" => {
            credentials::save(directory, &Credential { credential:input["credential"].as_str().unwrap().into(), server_url:input["serverUrl"].as_str().unwrap().into(), worker_id:input["workerId"].as_js_string().unwrap().clone() })?;
            Ok(Value::Null)
        }
        "load" => Ok(credentials::load(directory,input["serverUrl"].as_str().unwrap())?.map(|v| json!({"version":1,"serverUrl":v.server_url,"workerId":v.worker_id,"credential":v.credential})).unwrap_or(Value::Null)),
        "identity" => Ok(json!(credentials::identity(directory)?)),
        _ => {
            let environment = input["environment"].as_object().unwrap().iter().map(|(k,v)| (k.as_str().unwrap().into(),v.as_str().unwrap().into())).collect();
            let host = Host { cwd:directory, worker_root:Path::new(input["workerRoot"].as_str().unwrap()), platform:input["platform"].as_str().unwrap_or("darwin"), architecture:input["architecture"].as_str().unwrap_or("arm64"), hostname:input["hostname"].as_str().unwrap_or("fixture-host") };
            let value = config::read(&environment,&host)?;
            let replacement = value.replacement.map(|v| json!({"workerId":v.worker_id,"credential":v.credential}));
            Ok(json!({"codexBinary":value.codex_installation.binary.to_string_lossy(),"codexInstallation":value.codex_installation.to_value(),"dataDirectory":value.data_directory.to_string_lossy(),"name":value.name,"serverUrl":value.server_url,"enrollmentCode":value.enrollment_code,"replacement":replacement,"token":value.token,"tokenSource":value.token_source,"workerId":value.worker_id}))
        }
    }
}
fn main() -> Result<()> {
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|e| anyhow!("{e}"))?;
        let result = match execute(&input) {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        println!("{}", result.stringify());
    }
    Ok(())
}
