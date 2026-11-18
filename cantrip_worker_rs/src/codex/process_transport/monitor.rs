use super::*;
use crate::codex::rpc_protocol;
use cantrip_wire::value::json;
use tokio::sync::mpsc;
#[derive(Default)]
struct Lines {
    bytes: Vec<u8>,
    cr: bool,
}

impl Lines {
    fn chunk(&mut self, bytes: &[u8]) -> Vec<JsString> {
        let mut lines = Vec::new();
        for byte in bytes {
            if *byte == 10 && self.cr {
                self.cr = false;
                continue;
            }
            self.cr = *byte == 13;
            if matches!(*byte, 10 | 13) {
                lines.push(JsString::from(
                    String::from_utf8_lossy(&self.bytes).as_ref(),
                ));
                self.bytes.clear();
            } else {
                self.bytes.push(*byte);
            }
        }
        lines
    }
    fn end(&mut self) -> Vec<JsString> {
        if self.bytes.is_empty() {
            Vec::new()
        } else {
            let line = JsString::from(String::from_utf8_lossy(&self.bytes).as_ref());
            self.bytes.clear();
            vec![line]
        }
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    mut stdout: mpsc::Receiver<Vec<u8>>,
    mut stderr: mpsc::Receiver<Vec<u8>>,
    mut exit: oneshot::Receiver<i32>,
    send: oneshot::Sender<Result<JsString>>,
    exited: watch::Sender<Option<Exit>>,
    options: Options,
    observed: Arc<dyn Fn() -> Option<i32> + Send + Sync>,
) {
    let mut send = Some(send);
    let mut announced = false;
    let mut retained = Vec::<JsString>::new();
    let (mut out, mut err, mut code) = (true, true, None);
    let (mut out_lines, mut err_lines) = (Lines::default(), Lines::default());
    while out || err || code.is_none() {
        let (lines, is_stderr) = tokio::select! {
            bytes=stdout.recv(),if out=>match bytes{Some(bytes)=>(out_lines.chunk(&bytes),false),None=>{out=false;(out_lines.end(),false)}},
            bytes=stderr.recv(),if err=>match bytes{Some(bytes)=>(err_lines.chunk(&bytes),true),None=>{err=false;(err_lines.end(),true)}},
            status=&mut exit,if code.is_none()=>{let status=status.unwrap_or(-1);let actual=observed();let status=actual.unwrap_or(status);code=Some(status);let _=exited.send(Some(Exit{code:status,confirmed:actual.is_some()}));continue;}
        };
        for line in lines {
            if is_stderr && !line.trim().lossy().starts_with("listening on:") {
                let lower = line.lowercase();
                let lower = lower.lossy();
                let class = if lower.contains("panic") {
                    "panic"
                } else if lower.contains("error") {
                    "error"
                } else if lower.contains("warn") {
                    "warning"
                } else {
                    "diagnostic"
                };
                if let Some(logs) = &options.logs {
                    logs.repeated(format!("codex-subprocess:{}:{class}",options.runtime_id.as_deref().unwrap_or("starting")),if matches!(class,"panic"|"error"){"warn"}else{"debug"},"Codex app-server emitted a subprocess diagnostic",json!({"event":"codex.runtime.diagnostic","subsystem":"codex","operation":"subprocess-stderr","status":class,"runtimeId":options.runtime_id,"diagnosticClass":class}));
                }
                if !announced {
                    retained.push(options.policy.readable(&line));
                    if retained.len() > 20 {
                        retained.remove(0);
                    }
                }
            }
            if let Some(endpoint) = rpc_protocol::endpoint(&line) {
                announced = true;
                if let Some(send) = send.take() {
                    let _ = send.send(Ok(endpoint));
                }
            }
        }
    }
    // The Node process guard reports unexpected child signals as code 1.
    let code = code.unwrap_or(-1);
    if let Some(send) = send {
        let _ = send.send(Err(crate::error::WireError(rpc_protocol::startup_exit(
            &format!("code {code}"),
            &retained,
        ))
        .into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a_lost_waiter_never_becomes_confirmed_process_exit() {
        let (out, stdout) = mpsc::channel(1);
        let (err, stderr) = mpsc::channel(1);
        let (status, exit) = oneshot::channel();
        let (endpoint, announced) = oneshot::channel();
        let (exited, observed) = watch::channel(None);
        drop((out, err, status));
        run(
            stdout,
            stderr,
            exit,
            endpoint,
            exited,
            Options::local(".".into(), HashMap::new()),
            Arc::new(|| None),
        )
        .await;
        let status = observed.borrow().unwrap();
        assert_eq!(status.code, -1);
        assert!(!status.confirmed);
        assert!(announced.await.unwrap().is_err());
    }
}
