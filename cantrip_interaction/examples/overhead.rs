//! Software-only overhead measurement; no native event posting or desktop access.
//! The direct path is the same recording backend without host ownership bookkeeping.
use cantrip_interaction::{
    host::{Delivery, InputBackend, InputHost, PostFailure, Prepared},
    input::InputEvent,
    ownership::TargetIdentity,
};
use std::{hint::black_box, time::Instant};

#[derive(Default)]
struct Recording {
    events: u64,
}
impl InputBackend for Recording {
    type Target = ();
    type Control = u8;
    type Packet = bool;
    type Error = ();
    fn prepare<'a>(
        &mut self,
        _: &(),
        event: &InputEvent,
        _: impl Iterator<Item = (&'a u8, &'a bool)>,
    ) -> Result<Prepared<u8, bool>, ()> {
        Ok(match event {
            InputEvent::KeyDown { .. } => Prepared::Down {
                control: 0,
                packet: true,
                release: false,
            },
            InputEvent::KeyUp { .. } => Prepared::Up {
                control: 0,
                packet: None,
            },
            _ => return Err(()),
        })
    }
    fn post(&mut self, _: &(), packet: &bool) -> Result<Delivery, PostFailure<()>> {
        black_box(packet);
        self.events += 1;
        Ok(Delivery::DispatchedUnverified)
    }
}
fn main() {
    const PAIRS: u64 = 100_000;
    const RUNS: usize = 21;
    let down = InputEvent::KeyDown {
        key: "A".into(),
        modifiers: vec![],
        repeat: false,
    };
    let up = InputEvent::KeyUp { key: "A".into() };
    let identity = TargetIdentity {
        id: "recording".into(),
        generation: 1,
    };
    let mut direct_samples = Vec::new();
    let mut host_samples = Vec::new();
    let mut lifecycle_samples = Vec::new();
    for run in 0..RUNS + 3 {
        let mut direct = Recording::default();
        let started = Instant::now();
        for _ in 0..PAIRS {
            let Prepared::Down {
                packet, release, ..
            } = direct
                .prepare(&(), black_box(&down), std::iter::empty())
                .unwrap()
            else {
                unreachable!()
            };
            direct.post(&(), black_box(&packet)).unwrap();
            let Prepared::Up { .. } = direct
                .prepare(&(), black_box(&up), std::iter::empty())
                .unwrap()
            else {
                unreachable!()
            };
            direct.post(&(), black_box(&release)).unwrap();
        }
        let direct_ns = started.elapsed().as_nanos() as f64 / (PAIRS * 2) as f64;
        assert_eq!(black_box(direct.events), PAIRS * 2);
        let mut host = InputHost::new(Recording::default(), 16, 17);
        let owner = host.open(identity.clone(), "app".into(), ()).unwrap();
        let started = Instant::now();
        for i in 0..PAIRS {
            host.submit(owner, &identity, i * 2 + 1, black_box(&down))
                .unwrap();
            host.submit(owner, &identity, i * 2 + 2, black_box(&up))
                .unwrap();
        }
        let host_ns = started.elapsed().as_nanos() as f64 / (PAIRS * 2) as f64;
        assert_eq!(host.held_count(owner), Ok(0));
        assert!(host.close(owner).is_empty());
        let started = Instant::now();
        for _ in 0..10_000 {
            let owner = host.open(identity.clone(), "app".into(), ()).unwrap();
            assert!(host.close(owner).is_empty());
        }
        let lifecycle_ns = started.elapsed().as_nanos() as f64 / 10_000.0;
        if run >= 3 {
            direct_samples.push(direct_ns);
            host_samples.push(host_ns);
            lifecycle_samples.push(lifecycle_ns);
        }
    }
    fn stats(mut samples: Vec<f64>) -> String {
        samples.sort_by(f64::total_cmp);
        format!(
            "{{\"medianNs\":{:.3},\"p95Ns\":{:.3}}}",
            samples[samples.len() / 2],
            samples[(samples.len() * 95).div_ceil(100) - 1]
        )
    }
    println!(
        "{{\"softwareOnly\":true,\"architecture\":\"{}\",\"os\":\"{}\",\"runs\":{},\"eventsPerRun\":{},\"warmupRuns\":3,\"directBackendPerEvent\":{},\"sharedHostPerEvent\":{},\"participantOpenClose\":{}}}",
        std::env::consts::ARCH,
        std::env::consts::OS,
        RUNS,
        PAIRS * 2,
        stats(direct_samples),
        stats(host_samples),
        stats(lifecycle_samples)
    );
}
