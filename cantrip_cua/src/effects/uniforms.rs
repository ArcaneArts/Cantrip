//! ABI shared with shaders/contract.metal. Only 16-byte lanes; no pointers/padding.
use super::{CONTRACT_VERSION, Configuration, MAX_CURSORS, MAX_EVENTS, telemetry::Agent};

#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub struct CursorUniform {
    pub identity: [u32; 4],
    pub position: [f32; 4], // logical xy, normalized xy
    pub velocity: [f32; 4], // raw xy, smoothed xy (logical points / second)
    pub color: [f32; 4],
    pub state: [u32; 4], // visible, held mouse mask, modifier mask, recent event count
    pub sequence: [u32; 4], // latest generated input sequence low/high, reserved
    pub click_time: [f32; 4], // press/release relative seconds; ages (-1 age = never)
}
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub struct EventUniform {
    pub identity: [u32; 4],
    pub event: [u32; 4],    // kind, code, event-local modifier mask, has position
    pub sequence: [u32; 4], // low/high, reserved
    pub position: [f32; 4], // logical xy, normalized xy
    pub timing: [f32; 4],   // relative seconds, age seconds, scroll delta xy
}
#[repr(C, align(16))]
#[derive(Clone, Copy)]
pub struct FrameUniform {
    pub header: [u32; 4], // contract version, cursor count, event count, frame counter
    pub time: [f32; 4],   // render seconds, delta seconds, source seconds, capture age
    pub window: [f32; 4], // logical width/height, scale x/y
    pub texture: [f32; 4], // pixel width/height, reciprocal width/height
    pub parameters: [[f32; 4]; 4], // descriptor-order typed parameters, max 16
    pub cursors: [CursorUniform; MAX_CURSORS],
    pub events: [EventUniform; MAX_EVENTS],
}
fn seconds(ns: u64) -> f32 {
    (ns as f64 / 1e9) as f32
}
fn relative(time: u64, epoch: u64) -> f32 {
    ((time as i128 - epoch as i128) as f64 / 1e9) as f32
}
fn time_or_never(time: Option<u64>, epoch: u64) -> f32 {
    time.map_or(-1.0, |t| relative(t, epoch))
}
fn age(time: Option<u64>, now: u64) -> f32 {
    time.map_or(-1.0, |t| seconds(now.saturating_sub(t)))
}
fn position(x: f64, y: f64, size: [f32; 2]) -> [f32; 4] {
    [
        x as f32,
        y as f32,
        x as f32 / size[0].max(1.0),
        y as f32 / size[1].max(1.0),
    ]
}
#[derive(Clone, Copy)]
pub struct FrameTiming {
    pub epoch_ns: u64,
    pub now_ns: u64,
    pub previous_ns: u64,
    pub source_ns: u64,
    pub frame: u32,
}
impl FrameUniform {
    pub fn new(
        timing: FrameTiming,
        logical: [f32; 2],
        pixels: [u32; 2],
        config: &Configuration,
        agents: &[Agent],
    ) -> Self {
        let mut result = Self {
            header: [
                CONTRACT_VERSION,
                agents.len().min(MAX_CURSORS) as u32,
                0,
                timing.frame,
            ],
            time: [
                relative(timing.now_ns, timing.epoch_ns),
                seconds(timing.now_ns.saturating_sub(timing.previous_ns)),
                relative(timing.source_ns, timing.epoch_ns),
                seconds(timing.now_ns.saturating_sub(timing.source_ns)),
            ],
            window: [
                logical[0],
                logical[1],
                pixels[0] as f32 / logical[0].max(1.0),
                pixels[1] as f32 / logical[1].max(1.0),
            ],
            texture: [
                pixels[0] as f32,
                pixels[1] as f32,
                1.0 / pixels[0].max(1) as f32,
                1.0 / pixels[1].max(1) as f32,
            ],
            parameters: [[0.0; 4]; 4],
            cursors: [CursorUniform::default(); MAX_CURSORS],
            events: [EventUniform::default(); MAX_EVENTS],
        };
        for (i, param) in config.descriptor().parameters.iter().take(16).enumerate() {
            result.parameters[i / 4][i % 4] = config.value(param.id);
        }
        let agents = &agents[..agents.len().min(MAX_CURSORS)];
        for (out, agent) in result.cursors.iter_mut().zip(agents) {
            *out = CursorUniform {
                identity: agent.identity,
                position: position(agent.position.x, agent.position.y, logical),
                velocity: [
                    agent.raw_velocity[0] as f32,
                    agent.raw_velocity[1] as f32,
                    agent.smoothed_velocity[0] as f32,
                    agent.smoothed_velocity[1] as f32,
                ],
                color: agent.color,
                state: [
                    u32::from(agent.visible),
                    agent.buttons(),
                    agent.modifiers(),
                    agent.events.len() as u32,
                ],
                sequence: [agent.sequence as u32, (agent.sequence >> 32) as u32, 0, 0],
                click_time: [
                    time_or_never(agent.last_press_ns, timing.epoch_ns),
                    time_or_never(agent.last_release_ns, timing.epoch_ns),
                    age(agent.last_press_ns, timing.now_ns),
                    age(agent.last_release_ns, timing.now_ns),
                ],
            };
        }
        let mut events: Vec<_> = agents
            .iter()
            .flat_map(|a| a.events.iter().map(move |e| (a.identity, e)))
            .collect();
        events.sort_by_key(|(id, e)| (e.at_ns, *id, e.sequence));
        let start = events.len().saturating_sub(MAX_EVENTS);
        result.header[2] = (events.len() - start) as u32;
        for (out, (identity, e)) in result.events.iter_mut().zip(&events[start..]) {
            let p = e
                .input
                .position
                .unwrap_or(crate::target::Point { x: 0.0, y: 0.0 });
            *out = EventUniform {
                identity: *identity,
                event: [
                    e.input.kind as u32,
                    e.input.code,
                    e.input.modifiers,
                    u32::from(e.input.position.is_some()),
                ],
                sequence: [e.sequence as u32, (e.sequence >> 32) as u32, 0, 0],
                position: position(p.x, p.y, logical),
                timing: [
                    relative(e.at_ns, timing.epoch_ns),
                    seconds(timing.now_ns.saturating_sub(e.at_ns)),
                    e.input.delta[0],
                    e.input.delta[1],
                ],
            };
        }
        result
    }
    pub fn bytes(&self) -> &[u8] {
        // Every field is an initialized 16-byte lane or array of such lanes.
        // Layout assertions below and contract tests prevent implicit padding.
        unsafe {
            std::slice::from_raw_parts((self as *const Self).cast(), std::mem::size_of::<Self>())
        }
    }
}
const _: () = assert!(std::mem::size_of::<CursorUniform>() == 7 * 16);
const _: () = assert!(std::mem::size_of::<EventUniform>() == 5 * 16);
const _: () =
    assert!(std::mem::size_of::<FrameUniform>() == (8 + 7 * MAX_CURSORS + 5 * MAX_EVENTS) * 16);
