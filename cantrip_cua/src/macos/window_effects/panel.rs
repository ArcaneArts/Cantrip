//! The filtered surface is a separate window below unfiltered cursor panels.
use super::super::overlay::{self, Window};
use objc2::runtime::ProtocolObject;
use objc2::{
    msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGColorSpace, kCGColorSpaceSRGB};
use objc2_metal::{MTLDevice, MTLPixelFormat};
use objc2_quartz_core::{CAMetalLayer, CATransaction};

pub(super) struct Panel {
    window: overlay::OverlayWindow,
    _view: Retained<AnyObject>,
    pub layer: Retained<CAMetalLayer>,
    pub id: u32,
    pub shown: bool,
}
impl Panel {
    pub fn new(device: &ProtocolObject<dyn MTLDevice>) -> Option<Self> {
        let window = overlay::create_window()?;
        let id = window.id;
        unsafe {
            let allocated: Allocated<AnyObject> = msg_send![AnyClass::get(c"NSView")?, alloc];
            let view: Retained<AnyObject> = msg_send![allocated,initWithFrame:CGRect::ZERO];
            let layer = CAMetalLayer::new();
            layer.setDevice(Some(device));
            layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
            layer.setFramebufferOnly(false); // Optional history presents through a GPU blit.
            layer.setOpaque(false);
            layer.setMaximumDrawableCount(3);
            layer.setAllowsNextDrawableTimeout(true);
            layer.setPresentsWithTransaction(false);
            if let Some(color) = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)) {
                layer.setColorspace(Some(&color));
            }
            let _: () = msg_send![&*view,setWantsLayer:true];
            let _: () = msg_send![&*view,setLayer:&*layer];
            let _: () = msg_send![&*window,setContentView:&*view];
            Some(Self {
                window,
                _view: view,
                layer,
                id,
                shown: false,
            })
        }
    }
    pub fn position(&mut self, window: &Window, pixels: [u32; 2]) {
        let frame = overlay::appkit_frame(window.bounds);
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        unsafe {
            let _: () = msg_send![&*self.window,setFrame:frame,display:false];
            let _: () = msg_send![&*self._view,setFrame:CGRect::new(CGPoint::ZERO,frame.size)];
            let _: () = msg_send![&*self.window,setLevel:window.level];
        }
        self.layer.setFrame(CGRect::new(CGPoint::ZERO, frame.size));
        self.layer
            .setContentsScale(pixels[0] as f64 / window.bounds.width);
        self.layer
            .setDrawableSize(CGSize::new(pixels[0] as f64, pixels[1] as f64));
        CATransaction::commit();
    }
    pub fn scale(&self) -> f64 {
        unsafe { msg_send![&*self.window, backingScaleFactor] }
    }
    pub fn show(&mut self, window: &Window, ready: bool) {
        self.layer.setOpacity(if ready { 1.0 } else { 0.0 });
        unsafe {
            let _: () = msg_send![&*self.window,orderWindow:1_isize,relativeTo:window.id as isize];
        }
        self.shown = ready;
    }
    pub fn hide(&mut self) {
        unsafe {
            let _: () = msg_send![&*self.window,orderOut:Option::<&AnyObject>::None];
        }
        self.shown = false;
    }
}
impl Drop for Panel {
    fn drop(&mut self) {
        self.hide();
    }
}
