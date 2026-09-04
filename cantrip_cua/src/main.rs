use cantrip_cua::{
    backend::{FakeBackend, UnavailableBackend},
    runtime::run,
};

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => run(UnavailableBackend, std::io::stdin(), std::io::stdout()),
        ["--backend", "fake"] => run(FakeBackend, std::io::stdin(), std::io::stdout()),
        ["--version"] => {
            println!("cantrip-cua {} protocol 1", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {
            eprintln!("Usage: cantrip-cua [--backend fake | --version]");
            std::process::exit(2);
        }
    };
    if result.is_err() {
        // Never print incoming JSON, identifiers, target titles, or image data.
        eprintln!(
            "{{\"event\":\"cua.process.failed\",\"reason\":\"transport-or-runtime-failure\"}}"
        );
        std::process::exit(1);
    }
}
