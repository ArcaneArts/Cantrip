use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
struct Pending {
    send: oneshot::Sender<Result<Response>>,
    timer: tokio::task::AbortHandle,
}
#[derive(Default)]
struct Decoder {
    tail: Vec<u8>,
}
impl Decoder {
    fn push(&mut self, chunk: &[u8]) -> String {
        self.tail.extend(chunk);
        let mut text = String::new();
        let mut at = 0;
        loop {
            match std::str::from_utf8(&self.tail[at..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    at = self.tail.len();
                    break;
                }
                Err(error) => {
                    text.push_str(
                        std::str::from_utf8(&self.tail[at..at + error.valid_up_to()]).unwrap(),
                    );
                    at += error.valid_up_to();
                    match error.error_len() {
                        Some(size) => {
                            text.push('\u{fffd}');
                            at += size;
                        }
                        None => break,
                    }
                }
            }
        }
        self.tail.drain(..at);
        text
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    mut child: tokio::process::Child,
    mut operations: mpsc::UnboundedReceiver<Operation>,
    sender: mpsc::UnboundedSender<Operation>,
    ack: watch::Sender<Ack>,
    done: watch::Sender<Option<End>>,
    generation: JsString,
    control: bool,
    options: Options,
    on_closed: Arc<dyn Fn() + Send + Sync>,
) {
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let (writes, mut outgoing) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    let mut writes = Some(writes);
    let failures = sender.clone();
    let writer = tokio::spawn(async move {
        let mut reported = false;
        while let Some((id, bytes)) = outgoing.recv().await {
            if let Err(error) = stdin.write_all(&bytes).await {
                let message = if error.kind() == std::io::ErrorKind::BrokenPipe {
                    JsString::from("write EPIPE")
                } else {
                    error.to_string().into()
                };
                let _ = failures.send(Operation::WriteFailed {
                    id,
                    message,
                    report: !reported,
                });
                reported = true;
            }
        }
        let _ = stdin.shutdown().await;
    });
    let deadline = tokio::time::Instant::now() + options.ack_timeout;
    let mut pending = HashMap::<String, Pending>::new();
    let mut decoder = Decoder::default();
    let mut buffer = String::new();
    let mut buffer_units = 0;
    let mut ack_buffer = JsString::from("");
    let mut errors = JsString::from("");
    let (mut out, mut err, mut accepting, mut acknowledged, mut expired) =
        (true, true, true, false, false);
    let mut status = None;
    let (mut out_bytes, mut err_bytes) = ([0u8; 8192], [0u8; 8192]);
    while out || err || status.is_none() {
        tokio::select! {
            read=stdout.read(&mut out_bytes),if out=>match read {
                Ok(0)=>out=false,
                Ok(size)=>{
                    if !acknowledged && !expired {
                        let mut units=ack_buffer.units().to_vec();units.extend(String::from_utf8_lossy(&out_bytes[..size]).encode_utf16());ack_buffer=JsString::new(units);
                        if ack_buffer.units().len()>4096 {let _=child.start_kill();}
                        else if let Some(at)=ack_buffer.units().iter().position(|u|*u==10) {
                            let line=JsString::new(ack_buffer.units()[..at].to_vec());
                            acknowledged=cantrip_wire::parse_json_text(&line.lossy()).is_ok_and(|v|v["version"]==json!(1)&&v["generation"]==Value::String(generation.clone())&&v["ready"]==true);
                            if !acknowledged {let _=child.start_kill();}else if !control{let _=ack.send(Ack::Ready);}
                        }
                    }
                    let decoded=decoder.push(&out_bytes[..size]);buffer_units+=decoded.encode_utf16().count();buffer.push_str(&decoded);
                    if buffer_units>16*1024*1024 {let _=child.start_kill();}
                    else {
                        while let Some(at)=buffer.find('\n') {
                            let line=buffer[..at].to_owned();buffer_units-=line.encode_utf16().count()+1;buffer.drain(..=at);
                            match cantrip_wire::parse_json_text(&line) {
                                Ok(value)=>if let Some(id)=value["requestId"].as_str() && let Some(entry)=pending.remove(id){entry.timer.abort();let result=if value["ok"]==true {Ok(value.get("result").cloned())}else{Err(anyhow!("Native inference journal operation failed."))};let _=entry.send.send(result);},
                                Err(_)=>{let _=child.start_kill();break;},
                            }
                        }
                    }
                }
                Err(error)=>{options.report_error(error.to_string().into());let _=child.start_kill();out=false;},
            },
            read=stderr.read(&mut err_bytes),if err=>match read {Ok(0)=>err=false,Ok(size)=>{let mut units=errors.units().to_vec();units.extend(String::from_utf8_lossy(&err_bytes[..size]).encode_utf16());if units.len()>4096{units.drain(..units.len()-4096);}errors=JsString::new(units);},Err(error)=>{options.report_error(error.to_string().into());let _=child.start_kill();err=false;}},
            exit=child.wait(),if status.is_none()=>status=Some(exit),
            _=tokio::time::sleep_until(deadline),if !expired && (!acknowledged || control)=>{expired=true;let _=child.start_kill();},
            operation=operations.recv(),if accepting=>match operation {
                Some(Operation::Request{id,command,send})=>{
                    let timer_id=id.clone();let expire=sender.clone();let delay=options.journal_timeout;
                    let timer=tokio::spawn(async move{tokio::time::sleep(delay).await;let _=expire.send(Operation::Expired(timer_id));}).abort_handle();
                    let frame=json!({"requestId":id,"command":command});pending.insert(id.clone(),Pending{send,timer});
                    if writes.as_ref().is_none_or(|writer|writer.send((id.clone(),(frame.stringify()+"\n").into_bytes())).is_err()) {
                        let entry=pending.remove(&id).unwrap();entry.timer.abort();let _=entry.send.send(Err(anyhow!("Native inference journal has no live owner.")));
                    }
                }
                Some(Operation::Expired(id))=>if let Some(entry)=pending.remove(&id){let _=entry.send.send(Err(anyhow!("Native inference journal acknowledgement timed out.")));},
                Some(Operation::WriteFailed{id,message,report})=>{
                    if report {options.report_error(message.clone());}
                    if let Some(entry)=pending.remove(&id){entry.timer.abort();let _=entry.send.send(Err(crate::error::WireError(message).into()));}
                },
                Some(Operation::Close)=>{writes.take();},
                None=>{writes.take();accepting=false;},
            }
        }
    }
    writes.take();
    let _ = writer.await;
    let confirmed = status.as_ref().is_some_and(|v| v.is_ok());
    let code = status
        .as_ref()
        .and_then(|v| v.as_ref().ok())
        .and_then(std::process::ExitStatus::code);
    if !acknowledged || expired || control && code != Some(0) {
        let tail = errors.trim();
        let fallback = code.map_or_else(|| "exit null".to_owned(), |code| format!("exit {code}"));
        let mut units = format!(
            "Native ownership operation failed{}: ",
            if expired { " (deadline)" } else { "" }
        )
        .encode_utf16()
        .collect::<Vec<_>>();
        units.extend(
            if tail.is_empty() {
                JsString::from(fallback)
            } else {
                tail
            }
            .units(),
        );
        if !acknowledged || control {
            let _ = ack.send(Ack::Failed(JsString::new(units)));
        }
    } else if control {
        let _ = ack.send(Ack::Ready);
    }
    // Publish lost ownership before waking request waiters. A caller observing
    // its failed acknowledgement must already see this generation fenced.
    on_closed();
    for (_, entry) in pending {
        entry.timer.abort();
        let _ = entry
            .send
            .send(Err(anyhow!("Native inference journal owner exited.")));
    }
    let _ = done.send(Some(End { confirmed }));
}
