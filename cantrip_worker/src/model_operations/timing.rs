use super::{Emit, Value, json};
use crate::inference::admission::Phase;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

struct State {
    ticket: Option<Phase>,
    at: Instant,
    command: [f64; 4],
    provider: [f64; 4],
    sequence: usize,
    admitted: bool,
    observed: bool,
    closed: bool,
}

impl State {
    fn phase(&self) -> (usize, &'static str) {
        match self.ticket {
            Some(Phase::Waiting) => (0, "waiting"),
            Some(Phase::Running | Phase::Cancelling) => (2, "running"),
            Some(Phase::Suspended) => (3, "waiting"),
            _ => (1, "preparing"),
        }
    }
    fn account(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.at).as_secs_f64() * 1000.0;
        let (phase, _) = self.phase();
        self.command[phase] += elapsed;
        if self.ticket.is_some() {
            self.provider[phase] += elapsed;
        }
        self.at = now;
    }
}

pub(super) struct Timing {
    state: Mutex<State>,
    provider_id: Value,
    ack: bool,
    emit: Emit,
}

impl Timing {
    pub fn new(provider_id: Value, ack: bool, emit: Emit) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                ticket: None,
                at: Instant::now(),
                command: [0.0; 4],
                provider: [0.0; 4],
                sequence: 0,
                admitted: false,
                observed: false,
                closed: false,
            }),
            provider_id,
            ack,
            emit,
        })
    }

    pub fn observe(&self, phase: Phase) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        state.observed = true;
        state.account();
        let previous = state.phase();
        state.ticket = (phase != Phase::Released).then_some(phase);
        if previous != state.phase() {
            self.report(&mut state, false, false);
        }
    }

    pub fn admitted(&self) {
        let mut state = self.state.lock().unwrap();
        if self.ack && !state.admitted && !state.closed {
            state.admitted = true;
            self.report(&mut state, false, true);
        }
    }

    pub fn finish(&self) {
        let mut state = self.state.lock().unwrap();
        if state.observed {
            self.report(&mut state, true, false);
        }
        state.closed = true;
    }

    fn report(&self, state: &mut State, final_event: bool, admitted: bool) {
        state.account();
        let complete = final_event && state.ticket.is_none();
        let timing = |durations: [f64; 4]| {
            json!({
                "queueWaitMs":durations[0].floor(), "preparationMs":durations[1].floor(),
                "executionMs":durations[2].floor(),"suspendedMs":durations[3].floor(),"complete":complete,
            })
        };
        let mut event = json!({
            "type":"inference.command-state","sequence":state.sequence,"state":state.phase().1,
            "timing":timing(state.command),
            "providerTimings":vec![json!({"providerId":self.provider_id,"timing":timing(state.provider)})],
        });
        if admitted {
            event["admitted"] = json!(true);
        }
        state.sequence += 1;
        let _ = (self.emit)(event);
    }
}
