//! One executor owns session state; independent input jobs own long gestures.
//! Requests within each session remain ordered, while other sessions can proceed.
use crate::{
    backend::CaptureBackend,
    cancellation::Cancellation,
    error::{CuaError, ErrorCode},
    protocol::{Frame, Header, Message, Outcome, PROTOCOL_VERSION, read_frame, write_frame},
    service::{CuaService, Dispatch, InputPlan, Operation, OperationResult},
};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    sync::{
        Arc, Mutex,
        mpsc::{self},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    InputDone {
        id: u64,
        result: Box<crate::input_job::InputResult>,
    },
    Wake,
    InputClosed(io::Result<()>),
    OutputFailed,
}

struct Request {
    id: u64,
    operation: Operation,
    cancellation: Cancellation,
}
struct ActiveInput {
    id: u64,
    plan: Box<InputPlan>,
    cancellation: Cancellation,
    thread: std::thread::JoinHandle<()>,
}

fn respond(
    id: u64,
    result: crate::error::Result<OperationResult>,
    frames: &crossbeam_channel::Sender<Frame>,
    pending: &Pending,
    sequence: &mut u64,
) -> io::Result<()> {
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
    let sent = emit(frames, response, true);
    pending.lock().unwrap().remove(&id);
    sent?;
    if let Some((kind, session)) = event {
        *sequence += 1;
        emit(
            frames,
            frame(Message::Event {
                sequence: *sequence,
                session_id: Some(session),
                event: json!({ "kind": kind }),
            }),
            true,
        )?;
    }
    Ok(())
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
    let completion_tx = jobs_tx.clone();
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
                        if let Some(token) = reader_pending.lock().unwrap().get(&request_id)
                            && !token.is_cancelled()
                        {
                            token.cancel();
                            let _ = jobs_tx.send(Work::Wake);
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
                                Ok(Operation::JavascriptEvaluate {
                                    binding,
                                    source,
                                    wall_timeout_ms,
                                }) => {
                                    reader_javascript.evaluate(
                                        request_id,
                                        binding,
                                        source,
                                        wall_timeout_ms,
                                        token,
                                    )?;
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
                            // Registration bounds requests, completions and first
                            // cancellation wakeups; progress uses a latest-only cell.
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
    let mut active: HashMap<String, ActiveInput> = HashMap::new();
    let mut deferred: VecDeque<Request> = VecDeque::new();
    let mut result = (|| {
        loop {
            // Drain only eligible requests. Busy sessions do not spin or prevent
            // unrelated work, and cancellation can retire a queued request now.
            while let Some(index) = deferred.iter().position(|request| {
                request.cancellation.is_cancelled()
                    || request
                        .operation
                        .binding()
                        .is_none_or(|binding| !active.contains_key(&binding.session_id))
            }) {
                let Request {
                    id,
                    operation,
                    cancellation,
                } = deferred.remove(index).unwrap();
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                match service.dispatch(operation, &cancellation, now) {
                    Dispatch::Complete(result) => {
                        respond(id, result, &frames_tx, &pending, &mut sequence)?
                    }
                    Dispatch::Input { plan, work } => {
                        let completion = completion_tx.clone();
                        let progress = plan.progress.clone();
                        let spawned = std::thread::Builder::new().name("cua-input".into()).spawn(move || {
                            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                work(&mut |point| progress.set(point))
                            })).unwrap_or_else(|_| Err(CuaError::new(
                                ErrorCode::InputUnknown,
                                "Native input failed unexpectedly; delivery is unknown. Do not replay automatically.",
                            )));
                            let _ = completion.send(Work::InputDone { id, result: Box::new(result) });
                        });
                        match spawned {
                            Ok(thread) => {
                                active.insert(
                                    plan.binding.session_id.clone(),
                                    ActiveInput {
                                        id,
                                        plan,
                                        cancellation,
                                        thread,
                                    },
                                );
                            }
                            Err(_) => {
                                let result = service.finish_input(
                                    *plan,
                                    Err(CuaError::new(
                                        ErrorCode::InputFailed,
                                        "Cannot start native input; no input was dispatched.",
                                    )),
                                );
                                respond(id, result, &frames_tx, &pending, &mut sequence)?;
                            }
                        }
                    }
                }
            }
            match jobs_rx.recv() {
                Err(_) => return Ok(()),
                Ok(Work::InputClosed(result)) => return result,
                Ok(Work::OutputFailed) => return Err(io::Error::other("CUA output closed.")),
                Ok(Work::Wake) => {}
                Ok(Work::InputDone { id, result }) => {
                    let session = active
                        .iter()
                        .find(|(_, job)| job.id == id)
                        .map(|(session, _)| session.clone());
                    if let Some(session) = session {
                        let job = active.remove(&session).unwrap();
                        let _ = job.thread.join();
                        let result = service.finish_input(*job.plan, *result);
                        respond(id, result, &frames_tx, &pending, &mut sequence)?;
                    }
                }
                Ok(Work::Request {
                    id,
                    operation,
                    cancellation,
                }) => {
                    match serde_json::from_value::<Operation>(operation) {
                        Err(_) => respond(
                            id,
                            Err(CuaError::invalid("Invalid CUA operation.")),
                            &frames_tx,
                            &pending,
                            &mut sequence,
                        )?,
                        Ok(operation) => {
                            if !cancellation.is_cancelled()
                                && let Some(binding) = operation.binding()
                                && let Some(job) = active.get(&binding.session_id)
                                && operation.replaces_input_lifetime(&job.plan)
                            {
                                job.cancellation.cancel();
                                // A lifecycle transition ends queued input from
                                // that exact authority too, before releasing its target.
                                for request in &deferred {
                                    if request.operation.binding() == Some(binding)
                                        && matches!(
                                            request.operation,
                                            Operation::InputPerform { .. }
                                                | Operation::InputClick { .. }
                                                | Operation::InputPress { .. }
                                        )
                                    {
                                        request.cancellation.cancel();
                                    }
                                }
                            }
                            deferred.push_back(Request {
                                id,
                                operation,
                                cancellation,
                            });
                        }
                    }
                }
            }
        }
    })();
    cancel_all(&pending);
    for job in active.values() {
        job.cancellation.cancel();
    }
    // Cancellation wakes native waits. Allow scoped release and source cleanup
    // before dropping the backend, but never hang transport shutdown on a broken
    // native API. Remaining jobs retain their own resources until they exit.
    let mut shutdown_result = if result.is_ok() {
        Ok(())
    } else {
        Err(io::Error::other("CUA transport already closed."))
    };
    let shutdown = Instant::now();
    while !active.is_empty() {
        let remaining = Duration::from_secs(2).saturating_sub(shutdown.elapsed());
        match jobs_rx.recv_timeout(remaining) {
            Ok(Work::InputDone { id, result }) => {
                let session = active
                    .iter()
                    .find(|(_, job)| job.id == id)
                    .map(|(session, _)| session.clone());
                if let Some(session) = session {
                    let job = active.remove(&session).unwrap();
                    let _ = job.thread.join();
                    let completed = service.finish_input(*job.plan, *result);
                    if shutdown_result.is_ok() {
                        shutdown_result =
                            respond(id, completed, &frames_tx, &pending, &mut sequence);
                    } else {
                        pending.lock().unwrap().remove(&id);
                    }
                }
            }
            Err(_) => break,
            _ if remaining.is_zero() => break,
            _ => {}
        }
    }
    if result.is_ok() {
        for request in deferred {
            if shutdown_result.is_err() {
                break;
            }
            shutdown_result = respond(
                request.id,
                Err(CuaError::new(
                    ErrorCode::Cancelled,
                    "CUA request cancelled.",
                )),
                &frames_tx,
                &pending,
                &mut sequence,
            );
        }
        result = if active.is_empty() {
            shutdown_result
        } else {
            Err(io::Error::other("CUA input shutdown timed out."))
        };
    }
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
