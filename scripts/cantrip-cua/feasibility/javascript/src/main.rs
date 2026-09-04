//! Cycle-one feasibility evidence, not the production CUA evaluator.
use rquickjs::{Context, Function, Runtime};
use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

const MEMORY_LIMIT: usize = 8 * 1024 * 1024;
type Probe = (&'static str, fn() -> Result<(), String>);

struct ProbeContext {
    context: Context,
    runtime: Runtime,
}

impl ProbeContext {
    fn new() -> Result<Self, String> {
        let runtime = Runtime::new().map_err(|_| "create runtime")?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(256 * 1024);
        let context = Context::full(&runtime).map_err(|_| "create context")?;
        context
            .with(|ctx| {
                let host = Function::new(ctx.clone(), |x: i32, y: i32| x.saturating_add(y))?;
                ctx.globals().set("hostAdd", host)
            })
            .map_err(|_| "register bounded host function")?;
        Ok(Self { context, runtime })
    }

    fn check(&self, source: &str) -> Result<(), String> {
        let result = self
            .context
            .with(|ctx| ctx.eval::<bool, _>(source))
            .map_err(|_| "probe evaluation failed")?;
        if result {
            Ok(())
        } else {
            Err("probe assertion failed".into())
        }
    }
}

fn persistent_globals_and_host_function() -> Result<(), String> {
    let engine = ProbeContext::new()?;
    engine.check("globalThis.counter = 41; hostAdd(counter, 1) === 42")?;
    engine.check("++counter === 42")?;
    engine.check("counter === 42 && hostAdd(-5, 10) === 5")
}

fn no_ambient_host_io() -> Result<(), String> {
    let engine = ProbeContext::new()?;
    engine.check(
        "['process', 'require', 'fetch', 'std', 'io', 'os', 'Deno', 'Bun',\
          'WebSocket', 'XMLHttpRequest', 'Worker', 'setTimeout', 'setInterval',\
          'loadScript'].every(name => typeof globalThis[name] === 'undefined')",
    )?;
    engine.check("Function('return typeof process')() === 'undefined'")?;
    engine.check("hostAdd.constructor('return typeof require')() === 'undefined'")?;
    engine.context.with(|ctx| {
        for module in ["std", "os", "node:fs", "file:///etc/passwd"] {
            let source = format!("import('{module}')");
            let promise = ctx
                .eval::<rquickjs::Promise, _>(source)
                .map_err(|_| "create import promise")?;
            if promise.finish::<()>().is_ok() {
                return Err("unexpected module import success".into());
            }
            // Consume the pending exception without printing its contents.
            let _ = ctx.catch();
        }
        Ok(())
    })
}

fn interrupts_infinite_loop() -> Result<(), String> {
    let engine = ProbeContext::new()?;
    let deadline = Instant::now() + Duration::from_millis(25);
    let interrupted = Rc::new(Cell::new(false));
    let observed = interrupted.clone();
    engine.runtime.set_interrupt_handler(Some(Box::new(move || {
        let elapsed = Instant::now() >= deadline;
        observed.set(elapsed);
        elapsed
    })));
    let start = Instant::now();
    let result = engine.context.with(|ctx| ctx.eval::<(), _>("for (;;) {}"));
    let elapsed = start.elapsed();
    engine.runtime.set_interrupt_handler(None);
    engine.context.with(|ctx| {
        let _ = ctx.catch();
    });
    if result.is_ok() || !interrupted.get() || elapsed > Duration::from_secs(2) {
        return Err("infinite loop did not interrupt within tolerance".into());
    }
    engine.check("hostAdd(1, 1) === 2")
}

fn enforces_memory_limit() -> Result<(), String> {
    let engine = ProbeContext::new()?;
    engine.check("new ArrayBuffer(1024).byteLength === 1024")?;
    let rejected = engine.context.with(|ctx| {
        let result = ctx.eval::<(), _>("globalThis.large = new ArrayBuffer(64 * 1024 * 1024)");
        let _ = ctx.catch();
        result.is_err()
    });
    if !rejected {
        return Err("oversized allocation succeeded".into());
    }
    if engine.runtime.memory_usage().malloc_size > MEMORY_LIMIT as i64 {
        return Err("reported heap allocation exceeded its limit".into());
    }
    engine.check("new ArrayBuffer(1024).byteLength === 1024")
}

fn reset_discards_globals_and_jobs() -> Result<(), String> {
    let mut engine = ProbeContext::new()?;
    engine.check(
        "globalThis.secret = 'session-only';\
         Promise.resolve().then(() => globalThis.pending = true);\
         typeof secret === 'string'",
    )?;
    if !engine.runtime.is_job_pending() {
        return Err("expected queued promise job".into());
    }
    // Dropping the entire runtime also drops queued jobs and all context handles.
    drop(engine);
    engine = ProbeContext::new()?;
    if engine.runtime.is_job_pending() {
        return Err("reset retained a promise job".into());
    }
    engine.check(
        "typeof secret === 'undefined' && typeof pending === 'undefined' && hostAdd(20, 22) === 42",
    )
}

fn main() {
    let probes: &[Probe] = &[
        (
            "persistent-globals-and-host",
            persistent_globals_and_host_function,
        ),
        ("no-ambient-host-io", no_ambient_host_io),
        ("interrupt-timeout", interrupts_infinite_loop),
        ("memory-limit", enforces_memory_limit),
        ("context-reset", reset_discards_globals_and_jobs),
    ];
    for (name, probe) in probes {
        let start = Instant::now();
        if let Err(error) = probe() {
            eprintln!("FAIL {name}: {error}");
            std::process::exit(1);
        }
        println!("PASS {name} elapsed_us={}", start.elapsed().as_micros());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globals_persist_and_host_function_works() {
        persistent_globals_and_host_function().unwrap();
    }

    #[test]
    fn ambient_io_and_module_imports_are_unavailable() {
        no_ambient_host_io().unwrap();
    }

    #[test]
    fn busy_loop_is_interrupted_and_context_remains_usable() {
        interrupts_infinite_loop().unwrap();
    }

    #[test]
    fn allocation_limit_rejects_large_buffer() {
        enforces_memory_limit().unwrap();
    }

    #[test]
    fn reset_discards_session_values_and_pending_jobs() {
        reset_discards_globals_and_jobs().unwrap();
    }
}
