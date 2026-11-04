//! Worker admission phases pause queue/suspension time without removing deadlines.
use std::time::Duration;
use tokio::time::Instant;

#[derive(Clone, Copy)]
enum Phase {
    Waiting,
    Preparing,
    Running,
}

pub(super) struct CommandDeadline {
    duration: Option<Duration>,
    preparation: Duration,
    execution: Duration,
    phase: Phase,
    entered: Instant,
    sequence: Option<u64>,
}

impl CommandDeadline {
    pub(super) fn new(duration: Option<Duration>) -> Self {
        Self {
            duration,
            preparation: duration.unwrap_or_default(),
            execution: duration.unwrap_or_default(),
            phase: Phase::Preparing,
            entered: Instant::now(),
            sequence: None,
        }
    }

    pub(super) fn observe(&mut self, sequence: u64, phase: &str) -> bool {
        if self.sequence.is_some_and(|current| sequence <= current) {
            return false;
        }
        let phase = match phase {
            "waiting" => Phase::Waiting,
            "preparing" => Phase::Preparing,
            "running" => Phase::Running,
            _ => return false,
        };
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.entered);
        match self.phase {
            Phase::Preparing => self.preparation = self.preparation.saturating_sub(elapsed),
            Phase::Running => self.execution = self.execution.saturating_sub(elapsed),
            Phase::Waiting => {}
        }
        self.sequence = Some(sequence);
        self.phase = phase;
        self.entered = now;
        true
    }

    pub(super) fn remaining(&self) -> Option<Duration> {
        self.duration?;
        let remaining = match self.phase {
            Phase::Waiting => return None,
            Phase::Preparing => self.preparation,
            Phase::Running => self.execution,
        };
        Some(remaining.saturating_sub(self.entered.elapsed()))
    }
}
