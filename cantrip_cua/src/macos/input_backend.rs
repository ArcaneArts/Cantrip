//! Concrete window-directed backend for the shared input host.
//! Packets own native buffers; preparation allocates only, posting never moves
//! the system pointer and never falls back to a global mouse/keyboard event.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::{Modifier, MouseButton, key_code, modifier_flags, text_units},
    target::{Point, Target},
};
use cantrip_interaction::{
    host::{Delivery, InputBackend, PostFailure, Prepared},
    input::{InputEvent, TextInput},
};
use std::{ffi::c_void, time::Instant};
type Ref = *const c_void;
#[repr(C)]
struct NativePoint {
    x: f64,
    y: f64,
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceCreate(state: i32) -> Ref;
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetTimestamp(event: Ref) -> u64;
    fn CGEventSetTimestamp(event: Ref, timestamp: u64);
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    fn CGEventKeyboardSetUnicodeString(event: Ref, length: usize, text: *const u16);
    fn CGEventCreateMouseEvent(source: Ref, kind: u32, point: NativePoint, button: u32) -> Ref;
    fn CGEventCreateScrollWheelEvent(source: Ref, units: u32, wheels: u32, ...) -> Ref;
    fn CGEventSetIntegerValueField(event: Ref, field: u32, value: i64);
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventSetLocation(event: Ref, point: NativePoint);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
}
struct Event(Ref);
// These are exclusively owned CoreGraphics buffers, created and used on the
// native worker thread already. Moving ownership is safe; concurrent access is
// not provided (Event remains !Sync and the shared host serializes posting).
unsafe impl Send for Event {}
impl Drop for Event {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
impl Event {
    fn owned(value: Ref) -> Result<Self> {
        if value.is_null() {
            Err(CuaError::new(
                ErrorCode::InputFailed,
                "Native event allocation failed; no input was posted.",
            ))
        } else {
            Ok(Self(value))
        }
    }
    fn set_modifiers(&self, modifiers: &[crate::gesture::Modifier]) {
        // Event-local flags only: never press/release a hardware modifier or
        // change the flags of interleaved keyboard events in the timeline.
        unsafe { CGEventSetFlags(self.0, modifier_flags(modifiers)) };
    }
    fn mouse(source: Ref, kind: u32, point: Point) -> Result<Self> {
        Self::mouse_button(source, kind, point, crate::gesture::MouseButton::Left)
    }
    fn mouse_button(
        source: Ref,
        kind: u32,
        point: Point,
        button: crate::gesture::MouseButton,
    ) -> Result<Self> {
        Self::owned(unsafe {
            CGEventCreateMouseEvent(
                source,
                kind,
                NativePoint {
                    x: point.x,
                    y: point.y,
                },
                crate::gesture::mouse_button_number(button),
            )
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Control {
    Key(u16),
    // Native apps have a single mouse drag context, even across mouse buttons.
    Pointer,
}
#[derive(Clone)]
pub(super) struct Destination {
    pub target: Target,
    pub participant: String,
    pub position: Point,
    pub cancel: Cancellation,
    pub group: i64,
}
enum Payload {
    Events(Vec<Event>),
    Text(Vec<(Event, Event)>),
    Prepare,
    Focus,
    Media(crate::gesture::MediaKey, Vec<Modifier>),
}
pub(super) struct Packet {
    payload: Payload,
    prepare_window: bool,
    pub point: Option<Point>,
    button: Option<MouseButton>,
    modifiers: Vec<Modifier>,
    cleanup: bool,
    identity: cantrip_interaction::ownership::TargetIdentity,
    scroll: Option<[i32; 2]>,
}
impl Packet {
    fn events(events: Vec<Event>, target: &Target) -> Self {
        Self {
            payload: Payload::Events(events),
            prepare_window: false,
            point: None,
            button: None,
            modifiers: vec![],
            cleanup: false,
            identity: cantrip_interaction::ownership::TargetIdentity {
                id: target.id.clone(),
                generation: target.generation,
            },
            scroll: None,
        }
    }
    fn action(payload: Payload, target: &Target) -> Self {
        Self {
            payload,
            ..Self::events(vec![], target)
        }
    }
}
struct Context {
    source: Event,
    delivery: super::skylight::Delivery,
    epoch: u64,
    clock: Instant,
}
pub(super) struct NativeInput {
    contexts: std::collections::BTreeMap<i64, Context>,
}
impl NativeInput {
    pub fn new() -> Self {
        Self {
            contexts: Default::default(),
        }
    }
    fn context(&mut self, target: &Destination) -> Result<&Context> {
        if let std::collections::btree_map::Entry::Vacant(entry) = self.contexts.entry(target.group)
        {
            let source = Event::owned(unsafe { CGEventSourceCreate(-1) })?;
            let clock_event = Event::owned(unsafe { CGEventCreate(source.0) })?;
            entry.insert(Context {
                source,
                delivery: super::skylight::Delivery::load()?,
                epoch: unsafe { CGEventGetTimestamp(clock_event.0) },
                clock: Instant::now(),
            });
        }
        Ok(&self.contexts[&target.group])
    }
    pub fn key_pair(
        &mut self,
        target: &Destination,
        key: u16,
        text: &[u16],
        modifiers: &[Modifier],
    ) -> Result<Prepared<Control, Packet>> {
        let context = self.context(target)?;
        let down =
            Event::owned(unsafe { CGEventCreateKeyboardEvent(context.source.0, key, true) })?;
        let up = Event::owned(unsafe { CGEventCreateKeyboardEvent(context.source.0, key, false) })?;
        for event in [&down, &up] {
            context.route(target, event, target.position, false, modifiers)?;
            if !text.is_empty() {
                unsafe {
                    CGEventKeyboardSetUnicodeString(event.0, text.len(), text.as_ptr());
                }
            }
        }
        let mut release = Packet::events(vec![up], &target.target);
        release.cleanup = true;
        release.modifiers = modifiers.to_vec();
        Ok(Prepared::Down {
            control: Control::Key(key),
            packet: Packet::events(vec![down], &target.target),
            release,
        })
    }
    fn pointer_packet(
        &mut self,
        target: &Destination,
        point: Point,
        button: MouseButton,
        modifiers: &[Modifier],
        kind: u32,
        tracking: bool,
    ) -> Result<Packet> {
        let context = self.context(target)?;
        let global = target.target.bounds.to_global(point)?;
        let mut events = Vec::with_capacity(if tracking { 2 } else { 1 });
        if tracking {
            events.push(Event::mouse(context.source.0, 5, global)?);
        }
        events.push(Event::mouse_button(context.source.0, kind, global, button)?);
        for event in &events {
            context.route(target, event, point, true, modifiers)?;
        }
        let mut packet = Packet::events(events, &target.target);
        packet.point = Some(point);
        packet.button = Some(button);
        packet.modifiers = modifiers.to_vec();
        Ok(packet)
    }
}
impl Context {
    fn post(&self, target: &Destination, pid: i32, event: &Event) {
        unsafe {
            CGEventSetTimestamp(
                event.0,
                self.epoch
                    .saturating_add(self.clock.elapsed().as_nanos().min(u64::MAX as u128) as u64),
            );
            self.delivery.post(pid, event.0);
            super::input_telemetry::posted(&target.participant, &target.target, event.0);
        }
    }

    fn route(
        &self,
        target: &Destination,
        event: &Event,
        point: Point,
        mouse: bool,
        modifiers: &[Modifier],
    ) -> Result<()> {
        let (pid, window) = super::click::process_destination(&target.target)?;
        unsafe {
            CGEventSetFlags(event.0, 0);
            if mouse {
                self.delivery
                    .prepare(event.0, pid, window, point, target.group, 1);
            } else {
                self.delivery
                    .prepare_routed(event.0, pid, window, point, target.group);
            }
        }
        event.set_modifiers(modifiers);
        Ok(())
    }
}
impl InputBackend for NativeInput {
    type Target = Destination;
    type Control = Control;
    type Packet = Packet;
    type Error = CuaError;
    fn closed(&mut self, target: &Destination) {
        self.contexts.remove(&target.group);
    }
    fn refreshed(&mut self, previous: &Destination, next: &Destination) {
        if previous.group != next.group {
            self.contexts.remove(&previous.group);
        }
    }
    fn capabilities(&self) -> cantrip_interaction::capabilities::InputCapabilities {
        use cantrip_interaction::capabilities::{InputCapabilities, PointerIsolation, Support::*};
        InputCapabilities {
            pointer: PointerIsolation::SurfaceDirected,
            buttons: vec![
                MouseButton::Left,
                MouseButton::Right,
                MouseButton::Middle,
                MouseButton::Back,
                MouseButton::Forward,
            ],
            persistent_holds: Implemented,
            committed_text: Implemented,
            composition: NotImplemented,
            physical_keys: Implemented,
            scroll: Implemented,
            surface_preparation: Implemented,
            host_focus: Implemented,
            system_media: Implemented,
            process_shared_state: true,
            simultaneous_pointer_holds: Some(1),
        }
    }
    fn prepare<'a>(
        &mut self,
        target: &Destination,
        event: &InputEvent,
        held: impl Iterator<Item = (&'a Control, &'a Packet)>,
    ) -> Result<Prepared<Control, Packet>> {
        use InputEvent::*;
        target.cancel.check()?;
        let mut held = held;
        let action = |packet| Prepared::Action {
            controls: vec![],
            packet,
        };
        match event {
            PointerDown {
                point,
                button,
                modifiers,
            } => {
                let (down, up) = crate::gesture::mouse_event_types(*button);
                let mut packet =
                    self.pointer_packet(target, *point, *button, modifiers, down, true)?;
                packet.prepare_window = modifiers.is_empty();
                let mut release =
                    self.pointer_packet(target, *point, *button, modifiers, up, false)?;
                release.cleanup = true;
                Ok(Prepared::Down {
                    control: Control::Pointer,
                    packet,
                    release,
                })
            }
            PointerUp { point, button } => {
                let previous = held
                    .find(|(c, _)| **c == Control::Pointer)
                    .map(|(_, p)| p)
                    .ok_or_else(|| {
                        CuaError::invalid("This participant is not holding a mouse button.")
                    })?;
                if previous.button != Some(*button) {
                    return Err(CuaError::invalid("Mouse-up must match the held button."));
                }
                let mut packet = self.pointer_packet(
                    target,
                    *point,
                    *button,
                    &previous.modifiers,
                    crate::gesture::mouse_event_types(*button).1,
                    false,
                )?;
                packet.cleanup = true;
                Ok(Prepared::Up {
                    control: Control::Pointer,
                    packet: Some(packet),
                })
            }
            PointerMove { point, modifiers } => {
                if let Some((_, previous)) = held.find(|(c, _)| **c == Control::Pointer) {
                    let button = previous.button.unwrap();
                    let kind = match button {
                        MouseButton::Left => 6,
                        MouseButton::Right => 7,
                        _ => 27,
                    };
                    let packet =
                        self.pointer_packet(target, *point, button, modifiers, kind, false)?;
                    let mut release = self.pointer_packet(
                        target,
                        *point,
                        button,
                        &previous.modifiers,
                        crate::gesture::mouse_event_types(button).1,
                        false,
                    )?;
                    release.cleanup = true;
                    Ok(Prepared::MoveHeld {
                        control: Control::Pointer,
                        packet,
                        release,
                    })
                } else {
                    Ok(Prepared::Action {
                        controls: vec![Control::Pointer],
                        packet: self.pointer_packet(
                            target,
                            *point,
                            MouseButton::Left,
                            modifiers,
                            5,
                            false,
                        )?,
                    })
                }
            }
            KeyDown {
                key,
                modifiers,
                repeat,
            } => {
                let code =
                    key_code(&crate::gesture::normalize_key(key.clone())).ok_or_else(|| {
                        CuaError::new(
                            ErrorCode::Unsupported,
                            "This native backend does not map that physical key.",
                        )
                    })?;
                if *repeat {
                    let previous = held
                        .find(|(c, _)| **c == Control::Key(code))
                        .map(|(_, p)| p)
                        .ok_or_else(|| {
                            CuaError::invalid("Key repeat requires this participant's held key.")
                        })?;
                    let Prepared::Down { packet, .. } =
                        self.key_pair(target, code, &[], &previous.modifiers)?
                    else {
                        unreachable!()
                    };
                    if let Payload::Events(events) = &packet.payload {
                        unsafe {
                            CGEventSetIntegerValueField(events[0].0, 8, 1);
                        }
                    }
                    Ok(Prepared::Repeat {
                        control: Control::Key(code),
                        packet,
                    })
                } else {
                    self.key_pair(target, code, &[], modifiers)
                }
            }
            KeyUp { key } => {
                let code =
                    key_code(&crate::gesture::normalize_key(key.clone())).ok_or_else(|| {
                        CuaError::new(
                            ErrorCode::Unsupported,
                            "This native backend does not map that physical key.",
                        )
                    })?;
                Ok(Prepared::Up {
                    control: Control::Key(code),
                    packet: None,
                })
            }
            Scroll {
                point,
                delta_x,
                delta_y,
                modifiers,
            } => {
                let y = delta_y.checked_neg().ok_or_else(|| {
                    CuaError::invalid("Scroll delta cannot be represented by the native backend.")
                })?;
                let x = delta_x.checked_neg().ok_or_else(|| {
                    CuaError::invalid("Scroll delta cannot be represented by the native backend.")
                })?;
                let context = self.context(target)?;
                let global = target.target.bounds.to_global(*point)?;
                let event = Event::owned(unsafe {
                    CGEventCreateScrollWheelEvent(context.source.0, 0, 2, y, x)
                })?;
                unsafe {
                    CGEventSetLocation(
                        event.0,
                        NativePoint {
                            x: global.x,
                            y: global.y,
                        },
                    );
                }
                context.route(target, &event, *point, false, modifiers)?;
                let mut packet = Packet::events(vec![event], &target.target);
                packet.point = Some(*point);
                packet.scroll = Some([*delta_x, *delta_y]);
                packet.modifiers = modifiers.clone();
                Ok(Prepared::Action {
                    controls: vec![Control::Pointer],
                    packet,
                })
            }
            Text(TextInput::Commit(text)) => {
                if text.len() > 8192 {
                    return Err(CuaError::invalid(
                        "Native committed text is limited to 8192 bytes per event.",
                    ));
                }
                let mut pairs = Vec::new();
                let mut controls = Vec::new();
                for unit in text_units(text) {
                    let (code, unicode) = match unit.as_slice() {
                        [10] | [13] => (36, vec![]),
                        [9] => (48, vec![]),
                        _ => (0, unit),
                    };
                    let Prepared::Down {
                        packet, release, ..
                    } = self.key_pair(target, code, &unicode, &[])?
                    else {
                        unreachable!()
                    };
                    if !controls.contains(&Control::Key(code)) {
                        controls.push(Control::Key(code));
                    }
                    if let (Payload::Events(mut down), Payload::Events(mut up)) =
                        (packet.payload, release.payload)
                    {
                        pairs.push((down.remove(0), up.remove(0)));
                    }
                }
                Ok(Prepared::Action {
                    controls,
                    packet: Packet::action(Payload::Text(pairs), &target.target),
                })
            }
            Text(_) => Err(CuaError::new(
                ErrorCode::Unsupported,
                "Native window input supports committed text; composition requires a backend with a text-composition endpoint.",
            )),
            PrepareSurface => Ok(action(Packet::action(Payload::Prepare, &target.target))),
            RequestHostFocus => Ok(action(Packet::action(Payload::Focus, &target.target))),
            Media { key, modifiers } => Ok(action(Packet::action(
                Payload::Media(*key, modifiers.clone()),
                &target.target,
            ))),
        }
    }
    fn post(
        &mut self,
        target: &Destination,
        packet: &Packet,
    ) -> std::result::Result<Delivery, PostFailure<CuaError>> {
        use PostFailure::*;
        if !packet.cleanup {
            target.cancel.check().map_err(NotDispatched)?;
        }
        if packet.identity.id != target.target.id
            || packet.identity.generation != target.target.generation
        {
            return Err(NotDispatched(CuaError::new(
                ErrorCode::StaleTarget,
                "Prepared input belongs to a different target generation.",
            )));
        }
        let classify = |e: CuaError| {
            if e.code == ErrorCode::InputUnknown {
                Uncertain(e)
            } else {
                NotDispatched(e)
            }
        };
        if packet.prepare_window {
            let (pid, window) =
                super::click::process_destination(&target.target).map_err(NotDispatched)?;
            // Even if activation is uncertain, the pointer Down itself has
            // not been sent. Preserve the error but do not invent a mouse Up.
            super::window_input::prepare_then(pid, window, &target.cancel, || {
                target.cancel.check()
            })
            .map_err(NotDispatched)?;
        }
        match &packet.payload {
            Payload::Events(events) => {
                let (pid, _) =
                    super::click::process_destination(&target.target).map_err(NotDispatched)?;
                let context = self.context(target).map_err(NotDispatched)?;
                for event in events {
                    context.post(target, pid, event);
                }
                if let Some([x, y]) = packet.scroll {
                    crate::effects::live::input(
                        &target.participant,
                        &target.target,
                        crate::effects::telemetry::InputEvent {
                            kind: crate::effects::telemetry::EventKind::Scroll,
                            code: 0,
                            modifiers: ((modifier_flags(&packet.modifiers) >> 17) & 15) as u32,
                            position: packet.point,
                            delta: [x as f32, y as f32],
                        },
                    );
                }
            }
            Payload::Text(pairs) => {
                let (pid, _) =
                    super::click::process_destination(&target.target).map_err(NotDispatched)?;
                let cancel = target.cancel.clone();
                let context = self.context(target).map_err(NotDispatched)?;
                for (i, (down, up)) in pairs.iter().enumerate() {
                    // Text is committed as balanced scalar pairs. Even a panic
                    // between the halves cannot strand a physical key.
                    crate::gesture::held_gesture(
                        &cancel,
                        || context.post(target, pid, down),
                        || Ok(()),
                        || context.post(target, pid, up),
                    )
                    .map_err(|e| if i == 0 { classify(e) } else { Uncertain(e) })?;
                }
            }
            Payload::Prepare => {
                let (pid, window) =
                    super::click::process_destination(&target.target).map_err(NotDispatched)?;
                super::window_input::prepare(pid, window, &target.cancel).map_err(classify)?
            }
            Payload::Focus => {
                super::accessibility::request_focus(&target.target, &target.cancel)
                    .map_err(Uncertain)?;
            }
            Payload::Media(key, modifiers) => {
                super::media::press(*key, modifiers, &target.cancel).map_err(classify)?
            }
        }
        Ok(Delivery::DispatchedUnverified)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventGetFlags(event: Ref) -> u64;
    }
    #[test]
    fn native_buttons_survive_window_routing_without_posting() {
        use crate::gesture::MouseButton::*;
        unsafe extern "C" {
            fn CGEventGetType(event: Ref) -> u32;
            fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
        }
        let source = Event::owned(unsafe { CGEventSourceCreate(-1) }).unwrap();
        let delivery = super::super::skylight::Delivery::load().unwrap();
        for (button, expected_number, types) in [
            (Left, 0, (1, 2)),
            (Right, 1, (3, 4)),
            (Middle, 2, (25, 26)),
            (Back, 3, (25, 26)),
            (Forward, 4, (25, 26)),
        ] {
            assert_eq!(crate::gesture::mouse_event_types(button), types);
            for kind in [types.0, types.1] {
                let point = Point { x: 10.0, y: 20.0 };
                let event = Event::mouse_button(source.0, kind, point, button).unwrap();
                unsafe {
                    delivery.prepare(event.0, 77, 123, point, 42, 1);
                }
                event.set_modifiers(&[crate::gesture::Modifier::Meta]);
                unsafe {
                    assert_eq!(CGEventGetType(event.0), kind);
                    assert_eq!(CGEventGetIntegerValueField(event.0, 3), expected_number);
                    assert_eq!(CGEventGetIntegerValueField(event.0, 51), 123);
                    assert_eq!(CGEventGetFlags(event.0), 1 << 20);
                }
            }
        }
    }
    #[test]
    fn pointer_modifier_flags_do_not_leak_into_keyboard_events() {
        // Construct and inspect event buffers only. Nothing is posted, no app
        // is launched, and no capture, focus or shared input state is touched.
        let source = Event::owned(unsafe { CGEventSourceCreate(-1) }).unwrap();
        let key = Event::owned(unsafe { CGEventCreateKeyboardEvent(source.0, 8, true) }).unwrap();
        let original_key_flags = unsafe { CGEventGetFlags(key.0) };
        let point = Point { x: 10.0, y: 20.0 };
        for kind in [5, 1, 2] {
            let event = Event::mouse(source.0, kind, point).unwrap();
            event.set_modifiers(&[crate::gesture::Modifier::Meta]);
            assert_eq!(unsafe { CGEventGetFlags(event.0) }, 1 << 20);
            event.set_modifiers(&[]);
            assert_eq!(unsafe { CGEventGetFlags(event.0) }, 0);
        }
        assert_eq!(unsafe { CGEventGetFlags(key.0) }, original_key_flags);
    }
    fn destination() -> Destination {
        Destination {
            participant: "test".into(),
            cancel: Cancellation::default(),
            group: super::super::skylight::next_group(),
            position: Point { x: 10., y: 20. },
            target: Target {
                id: "macos-window-123".into(),
                generation: 1,
                kind: crate::target::TargetKind::Window,
                title: None,
                application: None,
                process_id: Some(77),
                bounds: crate::target::Bounds {
                    x: 100.,
                    y: 200.,
                    width: 500.,
                    height: 400.,
                },
                pixel_width: 500,
                pixel_height: 400,
                scale_factor: 1.,
                focused: None,
                minimized: None,
            },
        }
    }
    #[test]
    fn typed_backend_retains_flags_drag_button_and_latest_release_coordinates() {
        let mut backend = NativeInput::new();
        let target = destination();
        let Prepared::Down { release, .. } = backend
            .prepare(
                &target,
                &InputEvent::PointerDown {
                    point: target.position,
                    button: MouseButton::Back,
                    modifiers: vec![Modifier::Meta],
                },
                std::iter::empty(),
            )
            .unwrap()
        else {
            panic!("Down expected")
        };
        let end = Point { x: 30., y: 40. };
        let Prepared::MoveHeld {
            packet,
            release: updated,
            ..
        } = backend
            .prepare(
                &target,
                &InputEvent::PointerMove {
                    point: end,
                    modifiers: vec![Modifier::Shift],
                },
                [(&Control::Pointer, &release)].into_iter(),
            )
            .unwrap()
        else {
            panic!("drag expected")
        };
        assert_eq!(updated.point, Some(end));
        assert_eq!(updated.button, Some(MouseButton::Back));
        assert_eq!(updated.modifiers, [Modifier::Meta]);
        assert!(updated.cleanup);
        unsafe extern "C" {
            fn CGEventGetType(event: Ref) -> u32;
            fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
        }
        for (packet, kind, flags) in [(&packet, 27, 1 << 17), (&updated, 26, 1 << 20)] {
            let Payload::Events(events) = &packet.payload else {
                panic!()
            };
            unsafe {
                assert_eq!(CGEventGetType(events[0].0), kind);
                assert_eq!(CGEventGetIntegerValueField(events[0].0, 3), 3);
                assert_eq!(CGEventGetFlags(events[0].0), flags);
            }
        }
    }
    #[test]
    fn typed_key_repeat_and_release_preserve_original_modifiers() {
        let mut backend = NativeInput::new();
        let target = destination();
        let Prepared::Down {
            control, release, ..
        } = backend
            .prepare(
                &target,
                &InputEvent::KeyDown {
                    key: "k".into(),
                    modifiers: vec![Modifier::Meta],
                    repeat: false,
                },
                std::iter::empty(),
            )
            .unwrap()
        else {
            panic!()
        };
        let Prepared::Repeat { packet, .. } = backend
            .prepare(
                &target,
                &InputEvent::KeyDown {
                    key: "K".into(),
                    modifiers: vec![],
                    repeat: true,
                },
                [(&control, &release)].into_iter(),
            )
            .unwrap()
        else {
            panic!()
        };
        unsafe extern "C" {
            fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
        }
        let Payload::Events(events) = &packet.payload else {
            panic!()
        };
        unsafe {
            assert_eq!(CGEventGetFlags(events[0].0), 1 << 20);
            assert_eq!(CGEventGetIntegerValueField(events[0].0, 8), 1);
        }
        let Payload::Events(events) = &release.payload else {
            panic!()
        };
        assert_eq!(unsafe { CGEventGetFlags(events[0].0) }, 1 << 20);
    }
    #[test]
    fn stale_prepared_packet_is_rejected_before_native_post() {
        let mut backend = NativeInput::new();
        let mut target = destination();
        let Prepared::Down { packet, .. } = backend.key_pair(&target, 0, &[], &[]).unwrap() else {
            panic!()
        };
        target.target.generation += 1;
        assert!(matches!(
            backend.post(&target, &packet),
            Err(PostFailure::NotDispatched(CuaError {
                code: ErrorCode::StaleTarget,
                ..
            }))
        ));
    }
    #[test]
    fn committed_text_preallocates_balanced_unicode_and_control_pairs() {
        let mut backend = NativeInput::new();
        let target = destination();
        let Prepared::Action { controls, packet } = backend
            .prepare(
                &target,
                &InputEvent::Text(TextInput::Commit("a😀\n\t".into())),
                std::iter::empty(),
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            controls,
            [Control::Key(0), Control::Key(36), Control::Key(48)]
        );
        let Payload::Text(pairs) = packet.payload else {
            panic!()
        };
        assert_eq!(pairs.len(), 4);
        unsafe extern "C" {
            fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
            fn CGEventGetType(event: Ref) -> u32;
        }
        for ((down, up), code) in pairs.iter().zip([0, 0, 36, 48]) {
            unsafe {
                assert_eq!(CGEventGetType(down.0), 10);
                assert_eq!(CGEventGetType(up.0), 11);
                assert_eq!(CGEventGetIntegerValueField(down.0, 9), code);
                assert_eq!(CGEventGetIntegerValueField(up.0, 9), code);
            }
        }
    }
    #[test]
    fn participants_have_distinct_private_sources_and_release_only_their_resources() {
        let mut backend = NativeInput::new();
        let a = destination();
        let b = destination();
        let input = InputEvent::KeyDown {
            key: "A".into(),
            modifiers: vec![],
            repeat: false,
        };
        drop(backend.prepare(&a, &input, std::iter::empty()).unwrap());
        drop(backend.prepare(&b, &input, std::iter::empty()).unwrap());
        assert_eq!(backend.contexts.len(), 2);
        assert_ne!(
            backend.contexts[&a.group].source.0,
            backend.contexts[&b.group].source.0
        );
        backend.closed(&a);
        assert_eq!(backend.contexts.len(), 1);
        assert!(backend.contexts.contains_key(&b.group));
        let mut replacement = b.clone();
        replacement.group = super::super::skylight::next_group();
        backend.refreshed(&b, &replacement);
        assert!(backend.contexts.is_empty());
        drop(
            backend
                .prepare(&replacement, &input, std::iter::empty())
                .unwrap(),
        );
        assert_eq!(backend.contexts.len(), 1);
        backend.closed(&replacement);
        backend.closed(&replacement);
        assert!(backend.contexts.is_empty());
    }
}
