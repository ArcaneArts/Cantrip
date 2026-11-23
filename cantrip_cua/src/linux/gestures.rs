use super::input::Session;
use crate::{
    cancellation::Cancellation,
    error::Result,
    gesture::InputCommand,
    input::InputReceipt,
    target::{Point, Target},
};

pub(super) fn perform(
    session: &mut Session,
    target: Target,
    command: &InputCommand,
    position: Point,
    cancel: &Cancellation,
    progress: &mut dyn FnMut(Point),
) -> Result<(Target, InputReceipt)> {
    let result = crate::surface_gestures::perform(
        |event| session.send(event, cancel),
        target,
        command,
        position,
        cancel,
        progress,
    );
    if result.is_err() {
        let _ = session.close();
    }
    result
}
