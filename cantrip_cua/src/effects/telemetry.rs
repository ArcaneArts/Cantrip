//! Generated CUA input/presentation telemetry. Never evidence of application acceptance.
use crate::{
    cursor::CursorState,
    service::SessionState,
    target::{Bounds, Point, Target},
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};

const MOTION_TAU: f64 = 0.060;
const IDLE_TAU: f64 = 0.080;
const DISCONTINUITY_NS: u64 = 500_000_000;
const EVENT_LIFETIME_NS: u64 = 2_000_000_000;
const EVENTS_PER_AGENT: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum EventKind {
    Press = 1,
    Release = 2,
    KeyDown = 3,
    KeyUp = 4,
    Scroll = 5,
    ControlAction = 6,
}
#[derive(Clone, Copy, Debug)]
pub struct InputEvent {
    pub kind: EventKind,
    /// Mouse button 0-4 or ANSI key code. Not hardware state.
    pub code: u32,
    /// Shift=1, Control=2, Alt=4, Meta=8.
    pub modifiers: u32,
    pub position: Option<Point>,
    pub delta: [f32; 2],
}
#[derive(Clone, Copy, Debug)]
pub struct RecentEvent {
    pub input: InputEvent,
    pub at_ns: u64,
    pub sequence: u64,
}
#[derive(Clone, Debug)]
pub struct Agent {
    pub identity: [u32; 4],
    pub target_id: String,
    pub generation: u64,
    pub position: Point,
    pub color: [f32; 4],
    pub visible: bool,
    pub raw_velocity: [f64; 2],
    pub smoothed_velocity: [f64; 2],
    pub last_press_ns: Option<u64>,
    pub last_release_ns: Option<u64>,
    pub sequence: u64,
    pub events: VecDeque<RecentEvent>,
    motion_ns: u64,
    motion_initialized: bool,
    /// Integration state only changes on movement, never on render sampling.
    filtered: [f64; 2],
    buttons: BTreeMap<u32, u32>,
    keys: BTreeMap<u32, u32>,
    bounds: Bounds,
    scale: f64,
    revision: u64,
}
fn seconds(ns: u64) -> f64 {
    ns as f64 / 1e9
}
impl Agent {
    fn new(state: &SessionState, target: &Target, now: u64) -> Self {
        let identity = state
            .binding
            .thread_id
            .as_deref()
            .unwrap_or(&state.binding.chat_id);
        let digest = Sha256::digest(identity.as_bytes());
        let mut result = Self {
            identity: std::array::from_fn(|i| {
                u32::from_le_bytes(digest[i * 4..i * 4 + 4].try_into().unwrap())
            }),
            target_id: target.id.clone(),
            generation: target.generation,
            position: state.cursor.position,
            color: [0.0; 4],
            visible: false,
            raw_velocity: [0.0; 2],
            smoothed_velocity: [0.0; 2],
            filtered: [0.0; 2],
            last_press_ns: None,
            last_release_ns: None,
            sequence: 0,
            events: VecDeque::new(),
            motion_ns: now,
            motion_initialized: true,
            buttons: BTreeMap::new(),
            keys: BTreeMap::new(),
            bounds: target.bounds,
            scale: target.scale_factor,
            revision: state.cursor.revision,
        };
        result.appearance(&state.cursor);
        result
    }
    fn appearance(&mut self, cursor: &CursorState) {
        self.color = cursor
            .appearance
            .rgba()
            .unwrap_or([0; 4])
            .map(|v| v as f32 / 255.0);
        self.visible = cursor.appearance.visible;
    }
    pub fn buttons(&self) -> u32 {
        self.buttons
            .keys()
            .fold(0, |mask, code| mask | 1_u32.checked_shl(*code).unwrap_or(0))
    }
    pub fn modifiers(&self) -> u32 {
        self.buttons
            .values()
            .chain(self.keys.values())
            .fold(0, |mask, value| mask | value)
    }
    pub fn move_to(&mut self, point: Point, now: u64, discontinuity: bool) {
        if !point.x.is_finite() || !point.y.is_finite() || now < self.motion_ns {
            return;
        }
        if point == self.position && !discontinuity {
            return;
        }
        let elapsed = now.saturating_sub(self.motion_ns);
        if discontinuity || !self.motion_initialized || elapsed == 0 || elapsed > DISCONTINUITY_NS {
            self.raw_velocity = [0.0; 2];
            self.filtered = [0.0; 2];
        } else {
            let dt = seconds(elapsed);
            self.raw_velocity = [
                (point.x - self.position.x) / dt,
                (point.y - self.position.y) / dt,
            ];
            let alpha = 1.0 - (-dt / MOTION_TAU).exp();
            for i in 0..2 {
                self.filtered[i] += alpha * (self.raw_velocity[i] - self.filtered[i]);
            }
        }
        self.position = point;
        self.motion_ns = now;
        self.motion_initialized = true;
        self.smoothed_velocity = self.filtered;
    }
    pub fn input(&mut self, event: InputEvent, now: u64) {
        // Input positions describe generated events. Only presentation updates
        // advance the visible cursor, so queued native events cannot pull the
        // shader ahead of the cursor panel.
        match event.kind {
            EventKind::Press => {
                self.buttons.insert(event.code, event.modifiers);
                self.last_press_ns = Some(now);
            }
            EventKind::Release => {
                self.buttons.remove(&event.code);
                self.last_release_ns = Some(now);
            }
            EventKind::KeyDown => {
                self.keys.insert(event.code, event.modifiers);
            }
            EventKind::KeyUp => {
                self.keys.remove(&event.code);
            }
            EventKind::ControlAction => {
                self.last_press_ns = Some(now);
                self.last_release_ns = Some(now);
            }
            EventKind::Scroll => {}
        }
        self.sequence = self.sequence.saturating_add(1);
        self.events.push_back(RecentEvent {
            input: event,
            at_ns: now,
            sequence: self.sequence,
        });
        while self.events.len() > EVENTS_PER_AGENT {
            self.events.pop_front();
        }
    }
    pub fn sample(&self, now: u64) -> Self {
        self.sample_with_dissipation(now, 1.0)
    }
    /// Effect-only decay; retained motion, raw velocity, and input times are unchanged.
    fn sample_with_dissipation(&self, now: u64, speed: f64) -> Self {
        let mut sample = self.clone();
        sample.visible &= self.bounds.contains_local(self.position);
        let decay = (-seconds(now.saturating_sub(self.motion_ns)) / IDLE_TAU).exp();
        sample.raw_velocity = self.raw_velocity.map(|v| v * decay);
        let warp_decay = (-seconds(now.saturating_sub(self.motion_ns)) * speed / IDLE_TAU).exp();
        sample.smoothed_velocity = self.filtered.map(|v| v * warp_decay);
        sample.events.retain(|e| {
            now.saturating_sub(e.at_ns) <= EVENT_LIFETIME_NS.max((650_000_000.0 / speed) as u64)
        });
        sample
    }
}
#[derive(Default)]
pub struct Telemetry {
    agents: BTreeMap<String, Agent>,
}
impl Telemetry {
    pub fn synchronize(&mut self, states: &[SessionState], now: u64) {
        self.agents.retain(|id, _| {
            states
                .iter()
                .any(|s| &s.binding.session_id == id && s.target.is_some())
        });
        for state in states {
            let Some(target) = &state.target else {
                continue;
            };
            let agent = self
                .agents
                .entry(state.binding.session_id.clone())
                .or_insert_with(|| Agent::new(state, target, now));
            if agent.target_id != target.id || agent.generation != target.generation {
                *agent = Agent::new(state, target, now);
            }
            let resized = agent.bounds.width != target.bounds.width
                || agent.bounds.height != target.bounds.height
                || agent.scale != target.scale_factor;
            if state.cursor.revision != agent.revision || resized {
                agent.move_to(state.cursor.position, now, resized);
                agent.revision = state.cursor.revision;
            }
            agent.appearance(&state.cursor);
            agent.bounds = target.bounds;
            agent.scale = target.scale_factor;
        }
    }
    pub fn geometry(&mut self, target: &Target, now: u64) {
        for agent in self
            .agents
            .values_mut()
            .filter(|a| a.target_id == target.id && a.generation == target.generation)
        {
            if agent.bounds.width != target.bounds.width
                || agent.bounds.height != target.bounds.height
                || agent.scale != target.scale_factor
            {
                agent.move_to(agent.position, now, true);
            }
            agent.bounds = target.bounds;
            agent.scale = target.scale_factor;
        }
    }
    pub fn movement(
        &mut self,
        session: &str,
        target: &Target,
        point: Point,
        now: u64,
        discontinuity: bool,
    ) {
        if let Some(agent) = self.matching(session, target) {
            agent.move_to(point, now, discontinuity);
        }
    }
    pub fn input(&mut self, session: &str, target: &Target, event: InputEvent, now: u64) {
        // Release cleanup can arrive after detach; never recreate an expired owner.
        if let Some(agent) = self.matching(session, target) {
            agent.input(event, now);
        }
    }
    fn matching(&mut self, session: &str, target: &Target) -> Option<&mut Agent> {
        self.agents
            .get_mut(session)
            .filter(|a| a.target_id == target.id && a.generation == target.generation)
    }
    pub fn window(&self, id: &str, generation: u64, now: u64) -> Vec<Agent> {
        self.window_with_dissipation(id, generation, now, 1.0)
    }
    pub fn window_with_dissipation(
        &self,
        id: &str,
        generation: u64,
        now: u64,
        speed: f64,
    ) -> Vec<Agent> {
        let speed = if speed.is_finite() {
            speed.clamp(0.1, 5.0)
        } else {
            1.0
        };
        let mut result: Vec<_> = self
            .agents
            .values()
            .filter(|a| a.target_id == id && a.generation == generation)
            .map(|a| a.sample_with_dissipation(now, speed))
            .collect();
        result.sort_by_key(|a| a.identity);
        result.truncate(super::MAX_CURSORS);
        result
    }
}
