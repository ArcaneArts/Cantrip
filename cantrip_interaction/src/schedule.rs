//! Shared timeline ordering, visual lookahead, and held-event cleanup.
//! The caller supplies its clock and cancellation; there is no agent lifetime here.
use crate::geometry::Point;
use std::time::Duration;

#[derive(Debug)]
pub struct DispatchFailure<E> {
    pub source: E,
    pub input_began: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Transition {
    Down(usize),
    Up(usize),
    /// Custom-cursor presentation only; never a native input event.
    Move(Point),
}
#[derive(Clone, Debug)]
pub struct Frame {
    pub at: Duration,
    pub events: Vec<Transition>,
}
/// Merge lazy visual samples into the original timeline. Only button-up gaps
/// can contain travel; actual events keep their original times and order.
pub fn with_pointer_travel(
    frames: Vec<Frame>,
    pointer_points: &[Option<Point>],
    start: Point,
) -> impl Iterator<Item = Frame> + use<> {
    let clicks: Vec<Point> = frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter_map(|e| {
            if let Transition::Down(i) = e {
                pointer_points[*i]
            } else {
                None
            }
        })
        .collect();
    let mut spans = Vec::with_capacity(clicks.len());
    let mut cursor = start;
    let mut previous = None;
    let mut released_at = Duration::ZERO;
    let mut click = 0;
    for frame in &frames {
        for &event in &frame.events {
            match event {
                Transition::Up(i) if pointer_points[i].is_some() => released_at = frame.at,
                Transition::Down(i) => {
                    if let Some(end) = pointer_points[i] {
                        if let Some(span) = crate::motion::TimedSpline::new(
                            previous,
                            cursor,
                            end,
                            clicks.get(click + 1).copied(),
                            released_at,
                            frame.at,
                        ) {
                            spans.push(span);
                        }
                        previous = Some(cursor);
                        cursor = end;
                        click += 1;
                    }
                }
                _ => {}
            }
        }
    }
    let mut inputs = frames.into_iter().peekable();
    let mut visual = spans.into_iter().flatten().peekable();
    std::iter::from_fn(move || {
        if let Some(&(at, point)) = visual.peek()
            && inputs.peek().is_none_or(|input| at <= input.at)
        {
            visual.next();
            return Some(Frame {
                at,
                events: vec![Transition::Move(point)],
            });
        }
        inputs.next()
    })
}
/// Every Down owns a prepared matching Up. Use the same executor with fake
/// events in unit tests; production posts native events through the callback.
pub fn dispatch<I, E>(
    frames: I,
    count: usize,
    check: impl FnMut() -> Result<(), E>,
    mut post: impl FnMut(Transition),
    prepare: impl FnMut(Transition) -> Result<(), E>,
    wait: impl FnMut(Duration) -> Result<Duration, E>,
) -> Result<(), DispatchFailure<E>>
where
    I: IntoIterator,
    I::Item: std::borrow::Borrow<Frame>,
{
    dispatch_fallible(
        frames,
        count,
        check,
        |event| {
            post(event);
            Ok(())
        },
        prepare,
        wait,
    )
}
/// Fallible backend delivery. Stop at the first failed transition, release all
/// remaining holds once, and retain whether any input may have begun.
pub fn dispatch_fallible<I, E>(
    frames: I,
    count: usize,
    mut check: impl FnMut() -> std::result::Result<(), E>,
    post: impl FnMut(Transition) -> Result<(), E>,
    mut prepare: impl FnMut(Transition) -> std::result::Result<(), E>,
    mut wait: impl FnMut(Duration) -> std::result::Result<Duration, E>,
) -> std::result::Result<(), DispatchFailure<E>>
where
    I: IntoIterator,
    I::Item: std::borrow::Borrow<Frame>,
{
    struct Held<E, F: FnMut(Transition) -> Result<(), E>> {
        keys: Vec<bool>,
        post: F,
    }
    impl<E, F: FnMut(Transition) -> Result<(), E>> Held<E, F> {
        fn release_all(&mut self) -> Result<(), E> {
            let mut result = Ok(());
            for i in (0..self.keys.len()).rev() {
                if self.keys[i] {
                    self.keys[i] = false;
                    if let Err(error) = (self.post)(Transition::Up(i))
                        && result.is_ok()
                    {
                        result = Err(error);
                    }
                }
            }
            result
        }
    }
    impl<E, F: FnMut(Transition) -> Result<(), E>> Drop for Held<E, F> {
        fn drop(&mut self) {
            let _ = self.release_all();
        }
    }
    let mut held = Held {
        keys: vec![false; count],
        post,
    };
    let mut began = false;
    let mut result = Ok(());
    for frame in frames {
        let frame = std::borrow::Borrow::<Frame>::borrow(&frame);
        let elapsed = match wait(frame.at).and_then(|elapsed| check().map(|_| elapsed)) {
            Ok(elapsed) => elapsed,
            Err(error) => {
                result = Err(error);
                break;
            }
        };
        // Obsolete cosmetic samples must not amplify a slow renderer's backlog.
        // Keep every native Down/Up and on-time travel sample, including Stop.
        let late_visual = elapsed.saturating_sub(frame.at) > Duration::from_millis(16);
        // No waits, RPCs, authority lookups or snapshots inside a frame.
        for &event in &frame.events {
            if late_visual && matches!(event, Transition::Move(_)) {
                continue;
            }
            if let Err(error) = check() {
                result = Err(error);
                break;
            }
            // Preparation can fail before Down. Arm its cleanup only after
            // successful preparation, then post without an intervening wait.
            if let Err(error) = prepare(event) {
                result = Err(error);
                break;
            }
            match event {
                Transition::Down(i) => {
                    held.keys[i] = true;
                    began = true;
                }
                Transition::Up(i) => {
                    held.keys[i] = false;
                    began = true;
                }
                Transition::Move(_) => {}
            }
            if let Err(error) = (held.post)(event) {
                result = Err(error);
                break;
            }
        }
        if result.is_err() {
            break;
        }
    }
    let cleanup = held.release_all();
    if result.is_ok() {
        result = cleanup;
    }
    drop(held);
    result.map_err(|source| DispatchFailure {
        source,
        input_began: began,
    })
}
