//! One executor owns all mutable session state. A reader can cancel that
//! executor even while it is capturing or stdout is under backpressure.
use crate::{
    backend::CaptureBackend,
    cancellation::Cancellation,
    error::{CuaError, ErrorCode},
    protocol::{Frame, Header, Message, Outcome, PROTOCOL_VERSION, read_frame, write_frame},
    service::{CuaService, Operation},
};
use serde_json::json;
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    sync::{
        Arc, Mutex,
        mpsc::{self},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// Sixteen ordinary correlations, sixteen native closes, four JS resets.
const MAX_PENDING: usize = 36;
const MAX_OUTBOUND: usize = 4;
pub(crate) type Pending = Arc<Mutex<HashMap<u64, Cancellation>>>;

pub(crate) enum Work {
    Request {
        id: u64,
        operation: serde_json::Value,
        cancellation: Cancellation,
    },
    InputClosed(io::Result<()>),
    OutputFailed,
}

pub(crate) fn frame(message: Message) -> Frame {
    Frame {
        header: Header {
            version: PROTOCOL_VERSION,
            message,
        },
        payload: vec![],
    }
}

fn error_response(id: u64, code: ErrorCode, message: &'static str) -> Frame {
    frame(Message::Response {
        request_id: id,
        result: Outcome::Error {
            error: CuaError::new(code, message),
        },
    })
}

pub(crate) fn emit(
    sender: &crossbeam_channel::Sender<Frame>,
    mut output: Frame,
    wait_for_capacity: bool,
) -> io::Result<()> {
    // Validate before any bytes hit the wire. Oversized inventory becomes a
    // bounded response, not a partially emitted frame or an allocation spike.
    if write_frame(io::sink(), &output).is_err() {
        let Message::Response { request_id, .. } = output.header.message else {
            return Err(io::Error::other("Invalid internal CUA event."));
        };
        output = error_response(
            request_id,
            ErrorCode::Capacity,
            "CUA response exceeds its transport limit.",
        );
    }
    if wait_for_capacity {
        sender
            .send_timeout(output, Duration::from_secs(2))
            .map_err(|_| io::Error::other("CUA output backpressure or closed transport."))
    } else {
        sender
            .try_send(output)
            .map_err(|_| io::Error::other("CUA output backpressure or closed transport."))
    }
}

fn cancel_all(pending: &Pending) {
    for token in pending.lock().unwrap().values() {
        token.cancel();
    }
}

/// At most 36 accepted jobs and four outgoing images can be pending. Rejected
/// overload never blocks the reader. Exhausted output capacity terminates the
/// stream rather than accumulating memory or replaying ambiguous operations.
pub fn run<B: CaptureBackend + 'static>(
    backend: B,
    mut input: impl Read + Send + 'static,
    mut output: impl Write + Send + 'static,
) -> io::Result<()> {
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let (jobs_tx, jobs_rx) = mpsc::channel();
    let (frames_tx, frames_rx) = crossbeam_channel::bounded(MAX_OUTBOUND);
    let (writer_done_tx, writer_done_rx) = mpsc::sync_channel(1);
    let (javascript, javascript_done) =
        crate::javascript::spawn(frames_tx.clone(), pending.clone(), jobs_tx.clone())?;
    let writer_jobs = jobs_tx.clone();
    let writer_pending = pending.clone();
    std::thread::spawn(move || {
        let result: io::Result<()> = (|| {
            for item in frames_rx {
                write_frame(&mut output, &item)?;
                output.flush()?;
            }
            Ok(())
        })();
        if result.is_err() {
            cancel_all(&writer_pending);
            let _ = writer_jobs.send(Work::OutputFailed);
        }
        let _ = writer_done_tx.send(result);
    });
    let reader_pending = pending.clone();
    let reader_frames = frames_tx.clone();
    let reader_javascript = javascript.clone();
    std::thread::spawn(move || {
        let result = (|| {
            let mut last_id = 0;
            while let Some(item) = read_frame(&mut input)? {
                match item.header.message {
                    Message::Cancel { request_id } => {
                        // Unknown/completed cancellation is idempotent; never
                        // retain it for a future request with this identifier.
                        if let Some(token) = reader_pending.lock().unwrap().get(&request_id) {
                            token.cancel();
                        }
                        reader_javascript.wake();
                    }
                    Message::HostResult {
                        evaluation_request_id,
                        call_id,
                        result,
                    } => {
                        reader_javascript.reply(evaluation_request_id, call_id, result)?;
                    }
                    Message::Request {
                        request_id,
                        operation,
                    } => {
                        if request_id <= last_id {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "CUA request identifiers must increase.",
                            ));
                        }
                        last_id = request_id;
                        let token = Cancellation::default();
                        let accepted = {
                            let mut jobs = reader_pending.lock().unwrap();
                            if jobs.len() >= MAX_PENDING {
                                false
                            } else {
                                jobs.insert(request_id, token.clone());
                                true
                            }
                        };
                        if accepted {
                            match serde_json::from_value::<Operation>(operation.clone()) {
                                Ok(Operation::JavascriptEvaluate { binding, source }) => {
                                    reader_javascript
                                        .evaluate(request_id, binding, source, token)?;
                                    continue;
                                }
                                Ok(Operation::JavascriptReset { binding }) => {
                                    reader_javascript.reset(request_id, binding, token)?;
                                    continue;
                                }
                                Ok(Operation::SessionClose { binding }) => {
                                    reader_javascript.close(binding)?
                                }
                                _ => {}
                            }
                            // This channel cannot grow beyond MAX_PENDING plus
                            // two control messages, because registration is bounded.
                            jobs_tx
                                .send(Work::Request {
                                    id: request_id,
                                    operation,
                                    cancellation: token,
                                })
                                .map_err(|_| io::Error::other("CUA executor closed."))?;
                        } else {
                            emit(
                                &reader_frames,
                                error_response(
                                    request_id,
                                    ErrorCode::Capacity,
                                    "Too many pending CUA requests.",
                                ),
                                false,
                            )?;
                        }
                    }
                    _ => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Unexpected inbound CUA frame kind.",
                        ));
                    }
                }
            }
            Ok(())
        })();
        cancel_all(&reader_pending);
        let _ = jobs_tx.send(Work::InputClosed(result));
    });

    let mut service = CuaService::new(backend);
    service.enable_javascript();
    let mut sequence = 0;
    let result = (|| {
        for work in jobs_rx {
            match work {
                Work::InputClosed(result) => return result,
                Work::OutputFailed => return Err(io::Error::other("CUA output closed.")),
                Work::Request {
                    id,
                    operation,
                    cancellation,
                } => {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let result = serde_json::from_value::<Operation>(operation)
                        .map_err(|_| CuaError::invalid("Invalid CUA operation."))
                        .and_then(|operation| service.execute(operation, &cancellation, now));
                    let (response, event) = match result {
                        Ok(result) => (
                            Frame {
                                header: Header {
                                    version: PROTOCOL_VERSION,
                                    message: Message::Response {
                                        request_id: id,
                                        result: Outcome::Ok { data: result.data },
                                    },
                                },
                                payload: result.payload,
                            },
                            result.event,
                        ),
                        Err(error) => (
                            frame(Message::Response {
                                request_id: id,
                                result: Outcome::Error { error },
                            }),
                            None,
                        ),
                    };
                    let sent = emit(&frames_tx, response, true);
                    pending.lock().unwrap().remove(&id);
                    sent?;
                    if let Some((kind, session)) = event {
                        sequence += 1;
                        emit(
                            &frames_tx,
                            frame(Message::Event {
                                sequence,
                                session_id: Some(session),
                                event: json!({ "kind": kind }),
                            }),
                            true,
                        )?;
                    }
                }
            }
        }
        Ok(())
    })();
    cancel_all(&pending);
    javascript.shutdown();
    drop(service);
    let javascript_closed = javascript_done.recv_timeout(Duration::from_secs(2));
    drop(frames_tx);
    // A parent that stops draining stdout must not make EOF shutdown hang.
    // The process owner exits after this bound, discarding blocked I/O threads.
    if result.is_ok() {
        javascript_closed.map_err(|_| io::Error::other("CUA JavaScript shutdown timed out."))?;
        writer_done_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| io::Error::other("CUA output shutdown timed out."))??;
    }
    result
}
