//! Implementation facts, not permission probes or readiness gates. Callers still
//! attempt authorized operations and use the backend's actual delivery result.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Support {
    #[default]
    Unspecified,
    Implemented,
    NotImplemented,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PointerIsolation {
    #[default]
    Unspecified,
    /// Input is routed to a surface; generated movement leaves the host cursor alone.
    SurfaceDirected,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputCapabilities {
    pub pointer: PointerIsolation,
    pub buttons: Vec<crate::input::MouseButton>,
    pub persistent_holds: Support,
    pub committed_text: Support,
    pub composition: Support,
    pub physical_keys: Support,
    pub scroll: Support,
    pub surface_preparation: Support,
    pub host_focus: Support,
    pub system_media: Support,
    /// True when separate native windows may share underlying app input state.
    pub process_shared_state: bool,
    /// None means unspecified, not unlimited. A host's resource limits may be lower.
    pub simultaneous_pointer_holds: Option<usize>,
}
