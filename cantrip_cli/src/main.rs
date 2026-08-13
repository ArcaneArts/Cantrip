use std::env;

use clap::{CommandFactory, Parser};

#[derive(Debug, Parser)]
#[command(
    name = "cantrip",
    version,
    about = "Control Cantrip from a worker-managed environment",
    long_about = None,
    disable_help_subcommand = true
)]
struct Cli {}

fn main() {
    if env::args_os().len() == 1 {
        Cli::command().print_help().expect("write Cantrip CLI help");
        println!();
        return;
    }
    let _ = Cli::parse();
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::Cli;

    #[test]
    fn top_level_help_stays_brief() {
        let mut output = Vec::new();
        Cli::command()
            .write_long_help(&mut output)
            .expect("render help");
        let help = String::from_utf8(output).expect("UTF-8 help");
        assert!(help.contains("Usage: cantrip"));
        assert!(help.contains("-h, --help"));
        assert!(!help.contains("Commands:"));
    }
}
