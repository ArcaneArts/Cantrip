//! GPU resources only. Native windows and capture owners stay in sibling modules.
#[cfg(test)]
use crate::effects::Configuration;
use crate::effects::{
    source::{ShaderSource, diagnostic},
    uniforms::FrameUniform,
};
use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMClock, CMSampleBuffer};
use objc2_core_video::{
    CVImageBuffer, CVMetalTexture, CVMetalTextureCache, CVMetalTextureGetTexture,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth,
};
use objc2_foundation::NSString;
use objc2_metal::*;
use std::{
    ptr::{self, NonNull},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

pub(super) const CONTRACT: &str = include_str!("../../../shaders/contract.metal");
pub(super) const BUNDLED: &str = include_str!("../../../shaders/effects.metal");
pub(super) type Device = Retained<ProtocolObject<dyn MTLDevice>>;
pub(super) type Texture = Retained<ProtocolObject<dyn MTLTexture>>;
#[derive(Clone)]
pub(super) struct Pipeline {
    state: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    pub history: bool,
    pub continuous: bool,
    pub source: String,
}
#[cfg(test)]
pub(super) fn compile(
    device: &Device,
    config: &Configuration,
    source: &str,
) -> Result<Pipeline, String> {
    compile_source(device, &ShaderSource::bundled(config, source))
}
pub(super) fn compile_source(device: &Device, source: &ShaderSource) -> Result<Pipeline, String> {
    let library = device
        .newLibraryWithSource_options_error(
            &NSString::from_str(&source.compilation_source(CONTRACT)),
            None,
        )
        .map_err(|e| {
            diagnostic(format!(
                "Metal shader compilation failed: {}",
                e.localizedDescription()
            ))
        })?;
    let vertex = library
        .newFunctionWithName(&NSString::from_str("cantrip_surface"))
        .ok_or("Missing fixed vertex entry point")?;
    let fragment = library
        .newFunctionWithName(&NSString::from_str(&source.fragment))
        .ok_or_else(|| format!("Missing fragment entry point {}", &source.fragment))?;
    let descriptor = MTLRenderPipelineDescriptor::new();
    descriptor.setVertexFunction(Some(&vertex));
    descriptor.setFragmentFunction(Some(&fragment));
    unsafe {
        descriptor
            .colorAttachments()
            .objectAtIndexedSubscript(0)
            .setPixelFormat(MTLPixelFormat::BGRA8Unorm);
    }
    let state = device
        .newRenderPipelineStateWithDescriptor_error(&descriptor)
        .map_err(|e| {
            diagnostic(format!(
                "Metal pipeline creation failed: {}",
                e.localizedDescription()
            ))
        })?;
    Ok(Pipeline {
        state,
        history: source.history,
        continuous: source.continuous,
        source: source.label.clone(),
    })
}

/// Retain the source pixel buffer AND its CoreVideo Metal wrapper through GPU
/// completion. Holding only the MTLTexture does not pin the capture pool surface.
pub(super) struct Frame {
    _owner: FrameOwner,
    pub texture: Texture,
    pub source_ns: u64,
}
enum FrameOwner {
    Capture {
        _image: CFRetained<CVImageBuffer>,
        _bridge: CFRetained<CVMetalTexture>,
    },
    #[cfg(test)]
    Synthetic,
}
// SAFETY: these are immutable retained CoreVideo/Metal resources. The capture
// pool cannot recycle their backing surface while retained. GPU completion may
// release a frame on another thread, but never mutates it or calls AppKit.
unsafe impl Send for Frame {}
unsafe impl Sync for Frame {}
#[derive(Default)]
pub(super) struct Completion {
    pub in_flight: AtomicUsize,
    pub failed: AtomicBool,
    pub presented: Mutex<Presented>,
}
#[derive(Clone, Copy, Default)]
pub(super) struct Presented {
    pub at_ns: u64,
    pub serial: u64,
    pub generation: u64,
    pub source_sequence: u64,
}
impl Completion {
    pub fn snapshot(&self) -> Presented {
        *self.presented.lock().unwrap_or_else(|e| e.into_inner())
    }
}
pub(super) struct Destination<'a> {
    pub texture: &'a ProtocolObject<dyn MTLTexture>,
    pub drawable: Option<&'a ProtocolObject<dyn MTLDrawable>>,
    pub generation: u64,
    pub source_sequence: u64,
}
pub(super) struct Gpu {
    pub device: Device,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    cache: CFRetained<CVMetalTextureCache>,
    pub completion: Arc<Completion>,
    history: Option<[Texture; 2]>,
    history_index: usize,
    history_ready: bool,
    serial: u64,
}
impl Gpu {
    pub fn new(device: Device) -> Result<Self, String> {
        let queue = device
            .newCommandQueue()
            .ok_or("Metal command queue allocation failed")?;
        let mut cache = ptr::null_mut();
        let code = unsafe {
            CVMetalTextureCache::create(None, None, &device, None, NonNull::from(&mut cache))
        };
        if code != 0 {
            return Err(format!("CoreVideo texture-cache creation failed ({code})"));
        }
        let cache = unsafe {
            CFRetained::from_raw(NonNull::new(cache).ok_or("CoreVideo returned no texture cache")?)
        };
        Ok(Self {
            device,
            queue,
            cache,
            completion: Arc::default(),
            history: None,
            history_index: 0,
            history_ready: false,
            serial: 0,
        })
    }
    pub fn frame(&self, sample: &CMSampleBuffer) -> Result<Arc<Frame>, String> {
        let image =
            unsafe { sample.image_buffer() }.ok_or("ScreenCaptureKit supplied no image buffer")?;
        let width = CVPixelBufferGetWidth(&image);
        let height = CVPixelBufferGetHeight(&image);
        let mut bridge = ptr::null_mut();
        let code = unsafe {
            CVMetalTextureCache::create_texture_from_image(
                None,
                &self.cache,
                &image,
                None,
                MTLPixelFormat::BGRA8Unorm,
                width,
                height,
                0,
                NonNull::from(&mut bridge),
            )
        };
        if code != 0 {
            return Err(format!("CoreVideo texture import failed ({code})"));
        }
        let bridge = unsafe {
            CFRetained::from_raw(NonNull::new(bridge).ok_or("CoreVideo returned no texture")?)
        };
        let texture =
            CVMetalTextureGetTexture(&bridge).ok_or("CoreVideo texture has no Metal resource")?;
        // SCK presentation timestamps are on the host clock. Convert their age
        // using integer nanoseconds before mapping to our process-local epoch.
        let timestamp = unsafe { sample.presentation_time_stamp() };
        let host = unsafe { CMClock::host_time_clock().time() };
        let to_ns = |t: objc2_core_media::CMTime| -> Option<u64> {
            use objc2_core_media::CMTimeFlags;
            (t.timescale > 0
                && t.value >= 0
                && t.flags.contains(CMTimeFlags::Valid)
                && !t.flags.intersects(
                    CMTimeFlags::PositiveInfinity
                        | CMTimeFlags::NegativeInfinity
                        | CMTimeFlags::Indefinite,
                ))
            .then(|| {
                ((t.value as u128 * 1_000_000_000) / t.timescale as u128).min(u64::MAX as u128)
                    as u64
            })
        };
        let age = to_ns(host)
            .zip(to_ns(timestamp))
            .map(|(h, t)| h.saturating_sub(t))
            .ok_or("Capture frame has no valid timestamp")?;
        Ok(Arc::new(Frame {
            _owner: FrameOwner::Capture {
                _image: image,
                _bridge: bridge,
            },
            texture,
            source_ns: crate::effects::now_ns().saturating_sub(age),
        }))
    }
    pub fn reset_history(&mut self) {
        self.history = None;
        self.history_index = 0;
        self.history_ready = false;
    }
    fn history(&mut self, output: &ProtocolObject<dyn MTLTexture>) -> Result<(), String> {
        if self
            .history
            .as_ref()
            .is_some_and(|h| h[0].width() == output.width() && h[0].height() == output.height())
        {
            return Ok(());
        }
        self.reset_history();
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                output.width(),
                output.height(),
                false,
            )
        };
        descriptor.setStorageMode(MTLStorageMode::Private);
        descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        let a = self
            .device
            .newTextureWithDescriptor(&descriptor)
            .ok_or("History texture allocation failed")?;
        let b = self
            .device
            .newTextureWithDescriptor(&descriptor)
            .ok_or("History texture allocation failed")?;
        self.history = Some([a, b]);
        Ok(())
    }
    pub fn render(
        &mut self,
        frame: Arc<Frame>,
        pipeline: &Pipeline,
        uniform: &FrameUniform,
        destination: Destination<'_>,
    ) -> Result<bool, String> {
        let output = destination.texture;
        let drawable = destination.drawable;
        let generation = destination.generation;
        let source_sequence = destination.source_sequence;
        if self.completion.in_flight.load(Ordering::Acquire) >= 3 {
            return Ok(false);
        }
        if self.completion.failed.load(Ordering::Acquire) {
            return Err("Metal command execution failed".into());
        }
        if pipeline.history {
            self.history(output)?;
        } else {
            self.reset_history();
        }
        let command = self
            .queue
            .commandBuffer()
            .ok_or("Metal command buffer allocation failed")?;
        let bytes = uniform.bytes();
        let buffer = unsafe {
            self.device.newBufferWithBytes_length_options(
                NonNull::new(bytes.as_ptr().cast_mut().cast()).unwrap(),
                bytes.len(),
                MTLResourceOptions::StorageModeShared,
            )
        }
        .ok_or("Shader uniform allocation failed")?;
        let history = self.history.as_ref().map(|h| h[self.history_index].clone());
        let destination = self
            .history
            .as_ref()
            .map_or(output, |h| &*h[1 - self.history_index]);
        if !self.history_ready
            && let Some(previous) = &history
        {
            let pass = pass(previous);
            let encoder = command
                .renderCommandEncoderWithDescriptor(&pass)
                .ok_or("History initialization encoder failed")?;
            encoder.endEncoding();
        }
        let pass = pass(destination);
        let encoder = command
            .renderCommandEncoderWithDescriptor(&pass)
            .ok_or("Metal render encoder allocation failed")?;
        encoder.setRenderPipelineState(&pipeline.state);
        unsafe {
            encoder.setFragmentTexture_atIndex(Some(&frame.texture), 0);
            encoder.setFragmentTexture_atIndex(history.as_deref(), 1);
            encoder.setFragmentBuffer_offset_atIndex(Some(&buffer), 0, 0);
            encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 3);
        }
        encoder.endEncoding();
        if pipeline.history {
            let blit = command
                .blitCommandEncoder()
                .ok_or("History presentation encoder allocation failed")?;
            unsafe {
                blit.copyFromTexture_toTexture(destination, output);
            }
            blit.endEncoding();
        }
        if let Some(drawable) = drawable {
            command.presentDrawable(drawable);
        }
        let completion = self.completion.clone();
        self.serial = self.serial.saturating_add(1);
        let serial = self.serial;
        let resources = Mutex::new(Some((frame, buffer)));
        let callback = RcBlock::new(
            move |command: NonNull<ProtocolObject<dyn MTLCommandBuffer>>| {
                let command = unsafe { command.as_ref() };
                // Release the CoreVideo owner even if Metal keeps its completed
                // callback/command for diagnostics or caching.
                resources.lock().unwrap_or_else(|e| e.into_inner()).take();
                if command.status() == MTLCommandBufferStatus::Error {
                    completion.failed.store(true, Ordering::Release);
                } else {
                    let mut published = completion
                        .presented
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if serial > published.serial {
                        *published = Presented {
                            at_ns: crate::effects::now_ns(),
                            serial,
                            generation,
                            source_sequence,
                        };
                    }
                }
                completion.in_flight.fetch_sub(1, Ordering::AcqRel);
            },
        );
        unsafe {
            command.addCompletedHandler(RcBlock::as_ptr(&callback));
        }
        self.completion.in_flight.fetch_add(1, Ordering::AcqRel);
        command.commit();
        if pipeline.history {
            self.history_index = 1 - self.history_index;
            self.history_ready = true;
        }
        Ok(true)
    }
}
fn pass(texture: &ProtocolObject<dyn MTLTexture>) -> Retained<MTLRenderPassDescriptor> {
    let pass = MTLRenderPassDescriptor::new();
    unsafe {
        let attachment = pass.colorAttachments().objectAtIndexedSubscript(0);
        attachment.setTexture(Some(texture));
        attachment.setLoadAction(MTLLoadAction::Clear);
        attachment.setStoreAction(MTLStoreAction::Store);
        attachment.setClearColor(MTLClearColor {
            red: 0.,
            green: 0.,
            blue: 0.,
            alpha: 0.,
        });
    }
    pass
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::{EffectId, uniforms::FrameTiming};
    use std::time::{Duration, Instant};
    fn region() -> MTLRegion {
        MTLRegion {
            origin: MTLOrigin { x: 0, y: 0, z: 0 },
            size: MTLSize {
                width: 4,
                height: 4,
                depth: 1,
            },
        }
    }
    fn texture(device: &Device, bytes: &[u8; 64]) -> Texture {
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                4,
                4,
                false,
            )
        };
        descriptor.setStorageMode(MTLStorageMode::Shared);
        descriptor.setUsage(MTLTextureUsage::ShaderRead | MTLTextureUsage::RenderTarget);
        let texture = device.newTextureWithDescriptor(&descriptor).unwrap();
        unsafe {
            texture.replaceRegion_mipmapLevel_withBytes_bytesPerRow(
                region(),
                0,
                NonNull::new(bytes.as_ptr().cast_mut().cast()).unwrap(),
                16,
            );
        }
        texture
    }
    fn pixels(texture: &Texture) -> [u8; 64] {
        let mut bytes = [0; 64];
        unsafe {
            texture.getBytes_bytesPerRow_fromRegion_mipmapLevel(
                NonNull::new(bytes.as_mut_ptr().cast()).unwrap(),
                16,
                region(),
                0,
            );
        }
        bytes
    }
    fn wait(gpu: &Gpu, serial: u64) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while gpu.completion.snapshot().serial < serial
            && !gpu.completion.failed.load(Ordering::Acquire)
        {
            assert!(
                Instant::now() < deadline,
                "offscreen Metal command did not complete"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(!gpu.completion.failed.load(Ordering::Acquire));
    }
    fn uniform(config: &Configuration) -> FrameUniform {
        FrameUniform::new(
            FrameTiming {
                epoch_ns: 0,
                now_ns: 10,
                previous_ns: 0,
                source_ns: 0,
                frame: 0,
            },
            [4., 4.],
            [4, 4],
            config,
            &[],
        )
    }
    #[test]
    fn bundled_fragments_render_offscreen_and_leave_source_pixels_unchanged() {
        objc2::rc::autoreleasepool(|_| {
            let device = MTLCreateSystemDefaultDevice().expect("Metal test device");
            let mut gpu = Gpu::new(device.clone()).unwrap();
            let original = std::array::from_fn(|i| match i % 4 {
                0 => ((i / 4) % 4) * 30 + 20,
                1 => (i / 16) * 40 + 15,
                2 => 90,
                _ => 255,
            } as u8);
            let source = texture(&device, &original);
            let output = texture(&device, &[0; 64]);
            let frame = Arc::new(Frame {
                _owner: FrameOwner::Synthetic,
                texture: source.clone(),
                source_ns: 0,
            });
            let pass = Configuration {
                effect: EffectId::PassThrough,
                ..Configuration::default()
            };
            let pipeline = compile(&device, &pass, BUNDLED).unwrap();
            gpu.render(
                frame.clone(),
                &pipeline,
                &uniform(&pass),
                Destination {
                    texture: &output,
                    drawable: None,
                    generation: 1,
                    source_sequence: 1,
                },
            )
            .unwrap();
            wait(&gpu, 1);
            assert_eq!(
                pixels(&output),
                original,
                "pass-through must preserve orientation and pixels"
            );
            let debug = Configuration {
                effect: EffectId::DebugGradient,
                ..Configuration::default()
            };
            let pipeline = compile(&device, &debug, BUNDLED).unwrap();
            gpu.render(
                frame,
                &pipeline,
                &uniform(&debug),
                Destination {
                    texture: &output,
                    drawable: None,
                    generation: 1,
                    source_sequence: 2,
                },
            )
            .unwrap();
            wait(&gpu, 2);
            assert_ne!(
                pixels(&output),
                original,
                "debug must process the source image"
            );
            assert_eq!(
                pixels(&source),
                original,
                "filter must never modify clean capture"
            );
            assert_eq!(gpu.completion.snapshot().source_sequence, 2);
            assert!(
                gpu.history.is_none(),
                "bundled effects do not allocate history textures"
            );
        });
    }
    #[test]
    fn warp_responds_to_motion_and_clicks_without_changing_clean_video() {
        objc2::rc::autoreleasepool(|_| {
            let device = MTLCreateSystemDefaultDevice().expect("Metal test device");
            let mut gpu = Gpu::new(device.clone()).unwrap();
            let original = std::array::from_fn(|i| match i % 4 {
                0 => ((i / 4) % 4) * 60,
                1 => (i / 16) * 60,
                2 => 90,
                _ => 255,
            } as u8);
            let source = texture(&device, &original);
            let output = texture(&device, &[0; 64]);
            let frame = Arc::new(Frame {
                _owner: FrameOwner::Synthetic,
                texture: source.clone(),
                source_ns: 0,
            });
            let config = Configuration {
                effect: EffectId::CursorWarp,
                ..Configuration::default()
            };
            config.validate().unwrap();
            let pipeline = compile(&device, &config, BUNDLED).unwrap();
            assert!(pipeline.continuous);
            assert!(!pipeline.history);
            let mut data = uniform(&config);
            data.window = [128., 128., 4. / 128., 4. / 128.];
            let mut serial = 0;
            let mut render = |data: &FrameUniform| {
                serial += 1;
                assert!(
                    gpu.render(
                        frame.clone(),
                        &pipeline,
                        data,
                        Destination {
                            texture: &output,
                            drawable: None,
                            generation: 1,
                            source_sequence: serial,
                        }
                    )
                    .unwrap()
                );
                wait(&gpu, serial);
                pixels(&output)
            };
            assert_eq!(
                render(&data),
                original,
                "no cursors/events means clean pixels"
            );
            data.header[1] = 1;
            data.cursors[0].state[0] = 1;
            data.cursors[0].position = [64., 64., 0.5, 0.5];
            let idle = render(&data);
            data.cursors[0].velocity = [0., 0., 1800., 0.];
            let moving = render(&data);
            assert_ne!(moving, idle, "motion must change the sampled video");
            data.cursors[0].state[0] = 0;
            assert_eq!(render(&data), original, "invisible cursors do not warp");
            data.header[2] = 1;
            data.events[0].event = [1, 0, 0, 1];
            data.events[0].position = [64., 64., 0.5, 0.5];
            data.events[0].timing[1] = 0.17;
            assert_ne!(render(&data), original, "a recent press must ripple");
            let ripple = render(&data);
            data.parameters[1][0] = 0.1;
            data.events[0].timing[1] = 1.7;
            assert_eq!(
                render(&data),
                ripple,
                "slow dissipation stretches ripple time"
            );
            data.parameters[1][0] = 5.0;
            assert_eq!(
                render(&data),
                original,
                "fast dissipation expires the ripple"
            );
            data.parameters[1][0] = 1.0;
            data.events[0].timing[1] = 0.7;
            assert_eq!(render(&data), original, "old press ripples must decay away");
            data.cursors[0].state[0] = 1;
            data.events[0].timing[1] = 0.17;
            data.parameters[0][0] = 0.;
            assert_eq!(
                render(&data),
                original,
                "zero strength is pass-through even with input"
            );
            assert_eq!(
                pixels(&source),
                original,
                "clean source must remain unmodified"
            );
        });
    }
    #[test]
    fn history_is_initialized_and_stays_separate_from_capture() {
        objc2::rc::autoreleasepool(|_| {
            let device = MTLCreateSystemDefaultDevice().expect("Metal test device");
            let mut gpu = Gpu::new(device.clone()).unwrap();
            let source = texture(&device, &[0; 64]);
            let output = texture(&device, &[0; 64]);
            let config = Configuration {
                effect: EffectId::PassThrough,
                ..Configuration::default()
            };
            let mut pipeline=compile(&device,&config,r#"
                fragment float4 cantrip_passthrough(CantripVertex in [[stage_in]],texture2d<float> history [[texture(1)]]) {
                    constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::nearest);
                    return history.sample(s,in.uv)+float4(0.1f,0.05f,0,0.2f);
                }
            "#).unwrap();
            pipeline.history = true;
            let frame = Arc::new(Frame {
                _owner: FrameOwner::Synthetic,
                texture: source.clone(),
                source_ns: 0,
            });
            for serial in 1..=3 {
                gpu.render(
                    frame.clone(),
                    &pipeline,
                    &uniform(&config),
                    Destination {
                        texture: &output,
                        drawable: None,
                        generation: 1,
                        source_sequence: serial,
                    },
                )
                .unwrap();
                wait(&gpu, serial);
            }
            let result = pixels(&output);
            assert!((74..=79).contains(&result[2]));
            assert!((37..=40).contains(&result[1]));
            assert_eq!(result[0], 0);
            assert_eq!(pixels(&source), [0; 64]);
            gpu.reset_history();
            assert!(gpu.history.is_none());
            assert!(!gpu.history_ready);
        });
    }
    #[test]
    fn invalid_fragment_returns_compiler_diagnostics() {
        let device = MTLCreateSystemDefaultDevice().expect("Metal test device");
        let config = Configuration {
            effect: EffectId::PassThrough,
            ..Configuration::default()
        };
        let error = compile(&device, &config, "fragment not_valid_metal !!!")
            .err()
            .unwrap();
        assert!(error.contains("Metal shader compilation failed"));
        assert!(error.contains("error:"));
    }
}
