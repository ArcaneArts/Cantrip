//! Presentation data has no authority to post input. Adapters choose identities
//! and map their targets; neither needs to be an agent or an OS window.
use crate::{cursor::CursorState, geometry::Bounds};

pub trait CursorTarget {
    fn id(&self) -> &str;
    fn generation(&self) -> u64;
    fn bounds(&self) -> Bounds;
    fn scale_factor(&self) -> f64;
}

pub trait CursorSource {
    type Target: CursorTarget;
    fn participant_id(&self) -> &str;
    fn appearance_identity(&self) -> &str;
    fn target(&self) -> Option<&Self::Target>;
    fn cursor(&self) -> &CursorState;
}

#[derive(Clone, Debug)]
pub struct CursorPresentation<T> {
    pub participant_id: String,
    pub appearance_identity: String,
    pub target: Option<T>,
    pub cursor: CursorState,
}
impl<T: CursorTarget> CursorSource for CursorPresentation<T> {
    type Target = T;
    fn participant_id(&self) -> &str {
        &self.participant_id
    }
    fn appearance_identity(&self) -> &str {
        &self.appearance_identity
    }
    fn target(&self) -> Option<&T> {
        self.target.as_ref()
    }
    fn cursor(&self) -> &CursorState {
        &self.cursor
    }
}
impl<T: CursorTarget + Clone> CursorPresentation<T> {
    pub fn from_source(source: &impl CursorSource<Target = T>) -> Self {
        Self {
            participant_id: source.participant_id().into(),
            appearance_identity: source.appearance_identity().into(),
            target: source.target().cloned(),
            cursor: source.cursor().clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresentationDelivery {
    /// Renderer may coalesce obsolete presentation updates.
    Latest,
    /// Finish presenting this step before returning to the input scheduler.
    BeforeInput,
}
/// Presentation failure must not be used as evidence of input delivery or as a
/// prerequisite for input. A backend owns the native drawing lifecycle.
pub trait CursorRenderer<T: CursorTarget> {
    fn present(&mut self, participants: Vec<CursorPresentation<T>>, delivery: PresentationDelivery);
}
