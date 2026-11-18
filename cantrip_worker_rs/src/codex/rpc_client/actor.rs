use super::*;
use crate::codex::diagnostics;
use cantrip_wire::parse_json_text;
use indexmap::IndexMap;
use std::collections::VecDeque;
struct Pending {
    method: JsString,
    send: oneshot::Sender<Reply>,
    timer: tokio::task::AbortHandle,
}
struct Waiting {
    pending: Pending,
    predicate: Predicate,
}
#[derive(Default)]
struct State {
    requests: IndexMap<u64, Pending>,
    waiters: IndexMap<u64, Waiting>,
    notifications: VecDeque<Value>,
    observe: Option<Observe>,
}
impl State {
    fn reject(&mut self, message: JsString) {
        for (_, pending) in self.requests.drain(..) {
            pending.timer.abort();
            let _ = pending.send.send(Err(message.clone()));
        }
        for (_, waiting) in self.waiters.drain(..) {
            waiting.pending.timer.abort();
            let _ = waiting.pending.send.send(Err(message.clone()));
        }
        self.notifications.clear();
    }
    fn line(&mut self, line: &[u8]) {
        let Ok(message) = parse_json_text(&String::from_utf8_lossy(line)) else {
            return;
        };
        if !message.is_object() {
            return;
        }
        if let Some(id) = message["id"].as_f64() {
            if id.fract() != 0. || id < 1. || id > u64::MAX as f64 {
                return;
            }
            if let Some(pending) = self.requests.shift_remove(&(id as u64)) {
                pending.timer.abort();
                let mut response = json!({"id":id});
                if let Some(result) = message.get("result") {
                    response["result"] = result.clone();
                }
                let error = &message["error"];
                if error.is_object() && error["code"].is_number() && error["message"].is_string() {
                    response["error"] = json!({"code":error["code"],"message":error["message"]});
                }
                let _ = pending.send.send(Ok(response));
            }
            return;
        }
        let Some(method) = message["method"].as_js_string() else {
            return;
        };
        let mut notification = json!({"method":method});
        if let Some(params) = message.get("params") {
            notification["params"] = params.clone();
        }
        if let Some(observe) = &self.observe {
            observe(&notification);
            return;
        }
        let matching = self
            .waiters
            .iter()
            .find(|(_, waiting)| {
                waiting.pending.method == *method && (waiting.predicate)(&notification["params"])
            })
            .map(|(id, _)| *id);
        if let Some(id) = matching {
            let waiter = self.waiters.shift_remove(&id).unwrap();
            waiter.pending.timer.abort();
            let _ = waiter.pending.send.send(Ok(notification));
        } else {
            self.notifications.push_back(notification);
            if self.notifications.len() > 100 {
                self.notifications.pop_front();
            }
        }
    }
}
impl Drop for State {
    fn drop(&mut self) {
        self.reject("Codex app-server client closed.".into());
    }
}
struct Lines {
    bytes: Vec<u8>,
    cr: bool,
}
impl Lines {
    fn feed(&mut self, chunk: &[u8], state: &mut State) {
        for byte in chunk {
            if *byte == 10 && self.cr {
                self.cr = false;
                continue;
            }
            self.cr = *byte == 13;
            if matches!(*byte, 10 | 13) {
                state.line(&self.bytes);
                self.bytes.clear();
            } else {
                self.bytes.push(*byte);
            }
        }
    }
}
fn timer(
    sender: mpsc::UnboundedSender<Operation>,
    id: u64,
    notification: bool,
    duration: Duration,
) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
        tokio::time::sleep(duration.max(Duration::from_millis(1))).await;
        let _ = sender.send(Operation::Expired { id, notification });
    })
    .abort_handle()
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    mut operations: mpsc::UnboundedReceiver<Operation>,
    sender: mpsc::UnboundedSender<Operation>,
    closed: Arc<AtomicBool>,
    writer: mpsc::Sender<Vec<u8>>,
    mut stdout: mpsc::Receiver<Vec<u8>>,
    mut stderr: mpsc::Receiver<Vec<u8>>,
    mut exit: oneshot::Receiver<i32>,
    timeout: Duration,
    observed: Arc<dyn Fn() -> Option<std::process::ExitStatus> + Send + Sync>,
    observe: Option<Observe>,
) {
    let (outgoing, mut writes) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(value) = writes.recv().await {
            if writer
                .send((value.stringify() + "\n").into_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let auth = observe.is_some();
    let mut state = State {
        observe,
        requests: IndexMap::new(),
        waiters: IndexMap::new(),
        notifications: VecDeque::new(),
    };
    let mut lines = Lines {
        bytes: Vec::new(),
        cr: false,
    };
    let mut tail = JsString::from("");
    let (mut out, mut err, mut code) = (true, true, None);
    while out || err || code.is_none() {
        tokio::select! {
            chunk=stdout.recv(),if out=>match chunk {Some(bytes)=>lines.feed(&bytes,&mut state),None=>{out=false;if !lines.bytes.is_empty(){state.line(&lines.bytes);lines.bytes.clear();}}},
            chunk=stderr.recv(),if err=>match chunk {Some(bytes) if !auth=>{let mut units=tail.units().to_vec();units.extend(String::from_utf8_lossy(&bytes).encode_utf16());if units.len()>16384{units.drain(..units.len()-16384);}tail=JsString::new(units);}, Some(_)=>{},None=>err=false},
            status=&mut exit,if code.is_none()=>code=Some(status.unwrap_or(-1)),
            operation=operations.recv()=>{
                let Some(operation)=operation else{break;};
                match operation {
                    Operation::Request {id,method,params,send}=>{
                        if closed.load(Ordering::Acquire){let _=send.send(Err("Codex app-server client closed.".into()));continue;}
                        let pending=Pending {method:method.clone(),send,timer:timer(sender.clone(),id,false,timeout)};
                        state.requests.insert(id,pending);
                        let mut frame=json!({"id":id,"method":method});if let Some(params)=params{frame["params"]=params;}
                        let _=outgoing.send(frame);
                    }
                    Operation::Notify(value)=>{let _=outgoing.send(value);}
                    Operation::Wait {id,method,predicate,timeout,send}=>{
                        if closed.load(Ordering::Acquire){let _=send.send(Err("Codex app-server client closed.".into()));continue;}
                        if let Some(index)=state.notifications.iter().position(|value|value["method"]==Value::String(method.clone()) && predicate(&value["params"])) {
                            let _=send.send(Ok(state.notifications.remove(index).unwrap()));
                        }else{state.waiters.insert(id,Waiting {pending:Pending {method,send,timer:timer(sender.clone(),id,true,timeout)},predicate});}
                    }
                    Operation::Expired {id,notification}=>{
                        let pending=if notification {state.waiters.shift_remove(&id).map(|v|v.pending)}else{state.requests.shift_remove(&id)};
                        if let Some(pending)=pending {let message=format!("Codex App Server {} {} timed out.",if notification {"notification"}else{"request"},pending.method.lossy());let _=pending.send.send(Err(message.into()));}
                    }
                    Operation::Close=>state.reject("Codex app-server client closed.".into()),
                }
            }
        }
    }
    closed.store(true, Ordering::Release);
    // The former process guard reports unexpected child signals as exit 1.
    // An ordinary exit(130) remains code 130, never a guessed SIGINT.
    let code = observed()
        .map(|status| status.code().unwrap_or(1))
        .unwrap_or(code.unwrap_or(-1));
    state.reject(if auth {
        "Codex authentication service exited.".into()
    } else {
        diagnostics::exit_message(code, &tail)
    });
    writer.abort();
    let _ = writer.await;
}
