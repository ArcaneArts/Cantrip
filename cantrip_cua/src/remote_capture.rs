//! Worker-owned capture leases, independent of agent authority and input holds.
use crate::{
    backend::{Capture, CaptureBackend},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    interaction::Binding,
    service::{BoundedImage, OperationResult},
    target::{MAX_SEQUENCE, Target, validate_id},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Open {
        binding: Binding,
        target_id: String,
        target_generation: u64,
    },
    Frame {
        binding: Binding,
        handle: u64,
    },
    Close {
        binding: Binding,
        handle: u64,
    },
    CloseBinding {
        binding: Binding,
    },
}
struct Lease {
    binding: Binding,
    target: Target,
    flight: Option<Cancellation>,
}
pub(crate) struct FramePlan {
    binding: Binding,
    handle: u64,
    cancellation: Cancellation,
}
pub(crate) struct EncodedFrame {
    target: Target,
    width: u32,
    height: u32,
    png: Vec<u8>,
}
pub(crate) type FrameWork = Box<dyn FnOnce() -> Result<EncodedFrame> + Send>;
#[derive(Default)]
pub struct Captures {
    next: u64,
    live: HashMap<u64, Lease>,
}
impl Captures {
    pub(crate) fn prepare_frame(
        &mut self,
        backend: &mut impl CaptureBackend,
        binding: &Binding,
        handle: u64,
        cancel: &Cancellation,
    ) -> Result<Option<(FramePlan, FrameWork)>> {
        let lease = self.get(binding, handle)?;
        cancel.check()?;
        if lease.flight.is_some() {
            return Err(CuaError::new(
                ErrorCode::Capacity,
                "A frame is already pending for this capture.",
            ));
        }
        let selected = lease.target.clone();
        let Some(work) = backend.capture_work(&selected, cancel)? else {
            return Ok(None);
        };
        self.live.get_mut(&handle).unwrap().flight = Some(cancel.clone());
        let cancellation = cancel.clone();
        Ok(Some((
            FramePlan {
                binding: binding.clone(),
                handle,
                cancellation: cancel.clone(),
            },
            Box::new(move || encode_frame(&selected, work()?, &cancellation)),
        )))
    }
    pub(crate) fn finish_frame(
        &mut self,
        plan: FramePlan,
        result: Result<EncodedFrame>,
    ) -> Result<OperationResult> {
        // A closed/replaced lease cannot publish a late frame or resurrect capture.
        self.get(&plan.binding, plan.handle)?;
        self.live.get_mut(&plan.handle).unwrap().flight = None;
        plan.cancellation.check()?;
        let frame = result?;
        self.live.get_mut(&plan.handle).unwrap().target = frame.target.clone();
        Ok(frame_result(plan.handle, frame))
    }
    fn get(&self, binding: &Binding, handle: u64) -> Result<&Lease> {
        binding.validate()?;
        let lease = self.live.get(&handle).ok_or_else(|| {
            CuaError::new(ErrorCode::SessionNotFound, "Remote capture is closed.")
        })?;
        if &lease.binding != binding {
            return Err(CuaError::new(
                ErrorCode::OwnershipMismatch,
                "Remote capture belongs to another attachment.",
            ));
        }
        Ok(lease)
    }
    pub fn execute(
        &mut self,
        backend: &mut impl CaptureBackend,
        request: Request,
        cancel: &Cancellation,
    ) -> Result<OperationResult> {
        let result = self.run(backend, request, cancel);
        backend.retain_remote_captures(self.live.values().map(|v| v.target.clone()).collect());
        result
    }
    fn run(
        &mut self,
        backend: &mut impl CaptureBackend,
        request: Request,
        cancel: &Cancellation,
    ) -> Result<OperationResult> {
        match request {
            Request::Open {
                binding,
                target_id,
                target_generation,
            } => {
                binding.validate()?;
                validate_id(&target_id)?;
                cancel.check()?;
                if self.live.len() >= 16 {
                    return Err(CuaError::new(
                        ErrorCode::Capacity,
                        "Remote capture capacity reached.",
                    ));
                }
                if self.live.values().any(|v| v.binding == binding) {
                    return Err(CuaError::invalid("Capture binding already open."));
                }
                let target = backend.resolve_target(&target_id, target_generation, cancel)?;
                target.validate()?;
                if target.id != target_id || target.generation != target_generation {
                    return Err(CuaError::new(
                        ErrorCode::StaleTarget,
                        "Remote capture target changed.",
                    ));
                }
                cancel.check()?;
                self.next = self
                    .next
                    .checked_add(1)
                    .filter(|n| *n <= MAX_SEQUENCE)
                    .ok_or_else(|| {
                        CuaError::new(ErrorCode::Capacity, "Capture handles exhausted.")
                    })?;
                let handle = self.next;
                let data = json!({"handle":handle,"target":target});
                self.live.insert(
                    handle,
                    Lease {
                        binding,
                        target,
                        flight: None,
                    },
                );
                Ok(OperationResult {
                    data,
                    payload: vec![],
                    event: None,
                })
            }
            Request::Frame { binding, handle } => {
                let selected = self.get(&binding, handle)?.target.clone();
                // Capture resolves identity itself; no extra inventory or focus request.
                let capture = backend.capture(&selected, cancel)?;
                let frame = encode_frame(&selected, capture, cancel)?;
                self.live.get_mut(&handle).unwrap().target = frame.target.clone();
                Ok(frame_result(handle, frame))
            }
            Request::Close { binding, handle } => {
                self.get(&binding, handle)?;
                if let Some(flight) = self.live.remove(&handle).and_then(|lease| lease.flight) {
                    flight.cancel();
                }
                Ok(empty())
            }
            Request::CloseBinding { binding } => {
                binding.validate()?;
                for lease in self.live.values().filter(|lease| lease.binding == binding) {
                    if let Some(flight) = &lease.flight {
                        flight.cancel();
                    }
                }
                self.live.retain(|_, v| v.binding != binding);
                Ok(empty())
            }
        }
    }
}
fn encode_frame(
    selected: &Target,
    capture: Capture,
    cancel: &Cancellation,
) -> Result<EncodedFrame> {
    capture.target.validate()?;
    if capture.target.id != selected.id
        || capture.target.generation != selected.generation
        || capture.target.process_id != selected.process_id
    {
        return Err(CuaError::new(
            ErrorCode::StaleTarget,
            "Remote capture target was replaced.",
        ));
    }
    capture.raster.validate()?;
    cancel.check()?;
    let mut encoded = BoundedImage(Vec::new());
    {
        let mut encoder =
            png::Encoder::new(&mut encoded, capture.raster.width, capture.raster.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(encode_error)?;
        writer
            .write_image_data(&capture.raster.rgba)
            .map_err(encode_error)?;
        writer.finish().map_err(encode_error)?;
    }
    cancel.check()?;
    Ok(EncodedFrame {
        target: capture.target,
        width: capture.raster.width,
        height: capture.raster.height,
        png: encoded.0,
    })
}
fn frame_result(handle: u64, frame: EncodedFrame) -> OperationResult {
    OperationResult {
        data: json!({"handle":handle,"target":frame.target,"image":{"mediaType":"image/png","width":frame.width,"height":frame.height,"cursorIncluded":false}}),
        payload: frame.png,
        event: None,
    }
}
fn encode_error(_: png::EncodingError) -> CuaError {
    CuaError::new(ErrorCode::CaptureFailed, "Remote frame encoding failed.")
}
fn empty() -> OperationResult {
    OperationResult {
        data: json!({"closed":true}),
        payload: vec![],
        event: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::FakeBackend;
    fn binding(id: &str) -> Binding {
        Binding {
            worker_id: "worker".into(),
            surface_id: "surface".into(),
            attachment_id: id.into(),
            participant_id: id.into(),
        }
    }
    fn open(captures: &mut Captures, backend: &mut FakeBackend, id: &str) -> u64 {
        captures
            .execute(
                backend,
                Request::Open {
                    binding: binding(id),
                    target_id: "fake-window".into(),
                    target_generation: 1,
                },
                &Cancellation::default(),
            )
            .unwrap()
            .data["handle"]
            .as_u64()
            .unwrap()
    }
    #[test]
    fn frames_are_original_pixels_without_a_cursor() {
        let mut captures = Captures::default();
        let mut backend = FakeBackend;
        let handle = open(&mut captures, &mut backend, "a");
        let frame = captures
            .execute(
                &mut backend,
                Request::Frame {
                    binding: binding("a"),
                    handle,
                },
                &Cancellation::default(),
            )
            .unwrap();
        assert_eq!(frame.data["image"]["cursorIncluded"], false);
        let mut reader = png::Decoder::new(std::io::Cursor::new(frame.payload))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut pixels).unwrap();
        let target = backend
            .targets(&Cancellation::default())
            .unwrap()
            .into_iter()
            .find(|t| t.id == "fake-window")
            .unwrap();
        assert_eq!(
            pixels,
            backend
                .capture(&target, &Cancellation::default())
                .unwrap()
                .raster
                .rgba
        );
    }
    #[test]
    fn cleanup_is_scoped_idempotent_and_works_after_cancellation() {
        let mut captures = Captures::default();
        let mut backend = FakeBackend;
        let a = open(&mut captures, &mut backend, "a");
        let b = open(&mut captures, &mut backend, "b");
        assert!(
            captures
                .execute(
                    &mut backend,
                    Request::Close {
                        binding: binding("b"),
                        handle: a
                    },
                    &Cancellation::default()
                )
                .is_err()
        );
        let cancelled = Cancellation::default();
        cancelled.cancel();
        for _ in 0..2 {
            captures
                .execute(
                    &mut backend,
                    Request::CloseBinding {
                        binding: binding("a"),
                    },
                    &cancelled,
                )
                .unwrap();
        }
        let next = open(&mut captures, &mut backend, "a");
        assert_ne!(a, next);
        assert!(
            captures
                .execute(
                    &mut backend,
                    Request::Frame {
                        binding: binding("a"),
                        handle: a
                    },
                    &Cancellation::default()
                )
                .is_err()
        );
        assert!(
            captures
                .execute(
                    &mut backend,
                    Request::Frame {
                        binding: binding("b"),
                        handle: b
                    },
                    &Cancellation::default()
                )
                .is_ok()
        );
    }
}
