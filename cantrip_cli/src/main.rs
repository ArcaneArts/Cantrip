use std::fs;
use std::io::{self, IsTerminal, Read};
use std::path::PathBuf;
use std::process::ExitCode;

use cantrip_cli::client;
use cantrip_cli::output;
use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};
use serde_json::{Map, Value, json};

#[derive(Debug, Parser)]
#[command(
    name = "cantrip",
    version,
    about = "Control Cantrip from a worker-managed environment",
    long_about = "Control Cantrip-managed worktrees and remote surfaces from a worker-managed environment.\n\nUse normal shell commands for ordinary repository files and Git operations.",
    disable_help_subcommand = true,
    disable_version_flag = true
)]
struct Cli {
    /// Print version information.
    #[arg(
        short = 'v',
        long = "version",
        action = clap::ArgAction::Version
    )]
    // `Version` exits before constructing `Cli`; `Option` keeps Clap from
    // inferring that this otherwise-unread field is a required argument.
    version: Option<bool>,

    /// Print stable JSON for scripts and agents.
    #[arg(long, global = true)]
    json: bool,

    /// Select project context explicitly when the bound lane and cwd differ.
    #[arg(long, global = true, value_enum, default_value_t = ContextSelection::Auto)]
    context: ContextSelection,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Clone, Debug, Eq, PartialEq, ValueEnum)]
enum ContextSelection {
    Auto,
    Cwd,
    Lane,
}

impl ContextSelection {
    fn wire_name(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cwd => "cwd",
            Self::Lane => "lane",
        }
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Show the worker connection and inferred project context.
    Status,
    /// Read effective Cantrip policies for the current project.
    Policy {
        #[command(subcommand)]
        command: PolicyCommand,
    },
    /// Manage Cantrip-owned Git worktrees.
    Worktree {
        #[command(subcommand)]
        command: WorktreeCommand,
    },
    /// Find Cantrip-managed projects, worktrees, and surfaces.
    Target {
        #[command(subcommand)]
        command: TargetCommand,
    },
    /// Operate an Explorer surface. Use normal shell tools for local files.
    Explorer {
        #[command(subcommand)]
        command: ExplorerCommand,
    },
    /// Read or control a Cantrip Terminal surface.
    Terminal {
        #[command(subcommand)]
        command: TerminalCommand,
    },
    /// Discover services or navigate a Cantrip Browser surface.
    Browser {
        #[command(subcommand)]
        command: BrowserCommand,
    },
    /// Inspect Codex-compatible project Run configurations.
    Run {
        #[command(subcommand)]
        command: RunCommand,
    },
}

#[derive(Debug, Subcommand)]
enum RunCommand {
    /// List actions available on the current project worker.
    List,
    /// Show one action selected by its exact name or ID.
    Show { action: String },
    /// Start an action as a worker-managed Run.
    Start {
        action: String,
        /// Do not ask a connected desktop client to focus the Run terminal.
        #[arg(long)]
        no_focus: bool,
    },
    /// Show the latest Run or one exact Run ID.
    Status { run_id: Option<String> },
    /// Read the bounded in-memory tail of a Run terminal.
    Logs {
        run_id: String,
        #[arg(long, default_value_t = 10_000)]
        tail: usize,
    },
    /// Stop a worker-managed Run and its process tree.
    Stop { run_id: String },
    /// Materialize or reopen a Run in a connected Cantrip client.
    Open { run_id: String },
    /// Validate project Run configuration files for the current worker.
    Validate,
    /// Inspect or explicitly retry secondary-worktree setup.
    Setup {
        #[command(subcommand)]
        command: RunSetupCommand,
    },
    /// Inspect the canonical Run configuration location.
    Config {
        #[command(subcommand)]
        command: RunConfigCommand,
    },
}

#[derive(Debug, Subcommand)]
enum RunConfigCommand {
    /// Show the canonical repository-relative configuration path and Git state.
    Path,
    /// Create a minimal canonical environment configuration.
    Init {
        /// Replace an existing canonical configuration after revision checking.
        #[arg(long)]
        overwrite: bool,
        /// Environment name written to the generated configuration.
        #[arg(long)]
        name: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum RunSetupCommand {
    /// Show durable setup state and bounded worker-owned output.
    Status,
    /// Explicitly queue setup for the current secondary worktree.
    Retry,
}

#[derive(Debug, Subcommand)]
enum PolicyCommand {
    /// List effective policies without their full bodies.
    List,
    /// Read the current full body of an effective policy.
    Read { policy_key: String },
}

#[derive(Debug, Subcommand)]
enum WorktreeCommand {
    /// List the project's worktrees.
    List,
    /// Create a worktree; defaults to a new branch from the current revision.
    Create(WorktreeCreateArgs),
    /// Continue the current chat in an existing worktree.
    Switch { worktree: String },
    /// Show Git status for the current or named worktree.
    Status { worktree: Option<String> },
    /// Release the current secondary worktree and continue on Primary.
    Release,
    /// Remove a clean, unused, agent-created worktree. Its branch is retained.
    Remove { worktree: String },
}

#[derive(Debug, Args)]
struct WorktreeCreateArgs {
    /// Human-readable worktree name.
    name: String,
    /// Explicit name for the new branch; otherwise Cantrip derives one.
    #[arg(long, conflicts_with_all = ["existing", "detach"])]
    branch: Option<String>,
    /// Check out an existing branch.
    #[arg(long, value_name = "BRANCH", conflicts_with_all = ["branch", "detach", "from"])]
    existing: Option<String>,
    /// Create a detached worktree at this revision.
    #[arg(long, value_name = "REVISION", conflicts_with_all = ["branch", "existing", "from"])]
    detach: Option<String>,
    /// Start a new branch from this revision instead of the current revision.
    #[arg(long, value_name = "REVISION")]
    from: Option<String>,
    /// Continue the current chat in the new worktree after creation.
    #[arg(long)]
    switch: bool,
}

#[derive(Clone, Debug, ValueEnum)]
enum TargetKind {
    Project,
    Worker,
    Replica,
    Worktree,
    Chat,
    Terminal,
    Explorer,
    Code,
    Browser,
    RemoteDesktop,
    RemoteSurface,
}

impl TargetKind {
    fn wire_name(&self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Worker => "worker",
            Self::Replica => "replica",
            Self::Worktree => "worktree",
            Self::Chat => "chat",
            Self::Terminal => "terminal",
            Self::Explorer => "explorer",
            Self::Code => "code",
            Self::Browser => "browser",
            Self::RemoteDesktop => "remote-desktop",
            Self::RemoteSurface => "remote-surface",
        }
    }
}

#[derive(Debug, Subcommand)]
enum TargetCommand {
    /// List authorized targets, optionally restricted by kind.
    List {
        #[arg(long)]
        kind: Option<TargetKind>,
    },
    /// Inspect a named target, or the current worktree when omitted.
    Show { target: Option<String> },
}

#[derive(Debug, Args)]
struct SurfaceTarget {
    /// Surface title, full ID, or unique ID prefix.
    #[arg(long)]
    target: Option<String>,
}

#[derive(Debug, Subcommand)]
enum ExplorerCommand {
    /// List a directory on an Explorer surface.
    List {
        #[command(flatten)]
        surface: SurfaceTarget,
        #[arg(default_value = ".")]
        path: String,
    },
    /// Read a text file from an Explorer surface.
    Read {
        #[command(flatten)]
        surface: SurfaceTarget,
        path: String,
    },
    /// Replace a text file using stdin or --file, with concurrency protection.
    Write {
        #[command(flatten)]
        surface: SurfaceTarget,
        path: String,
        /// Read replacement content from a local file instead of stdin.
        #[arg(long, value_name = "FILE")]
        file: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
enum TerminalCommand {
    /// Print recent terminal scrollback.
    Read {
        #[command(flatten)]
        surface: SurfaceTarget,
    },
    /// Send a command followed by Enter; with no text, read stdin.
    Send {
        #[command(flatten)]
        surface: SurfaceTarget,
        /// Send bytes exactly and do not append Enter.
        #[arg(long)]
        raw: bool,
        #[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
    },
    /// Restart the service owned by a Terminal surface.
    Restart {
        #[command(flatten)]
        surface: SurfaceTarget,
    },
}

#[derive(Debug, Subcommand)]
enum BrowserCommand {
    /// Discover browser services on the selected surface's worker.
    Services {
        #[command(flatten)]
        surface: SurfaceTarget,
    },
    /// Open an HTTP(S) URL, creating a Browser tab when none exists.
    Open {
        #[command(flatten)]
        surface: SurfaceTarget,
        url: String,
    },
}

struct Invocation {
    command: &'static str,
    arguments: Value,
}

fn target_arguments(target: Option<String>) -> Map<String, Value> {
    let mut arguments = Map::new();
    if let Some(target) = target {
        arguments.insert("target".to_string(), Value::String(target));
    }
    arguments
}

fn read_stdin(label: &str) -> Result<String, String> {
    if io::stdin().is_terminal() {
        return Err(format!("{label} needs piped stdin or --file"));
    }
    let mut content = String::new();
    io::stdin()
        .read_to_string(&mut content)
        .map_err(|error| format!("could not read stdin: {error}"))?;
    Ok(content)
}

fn invocation(command: Command) -> Result<Invocation, String> {
    Ok(match command {
        Command::Status => Invocation {
            command: "status",
            arguments: json!({}),
        },
        Command::Policy { command } => match command {
            PolicyCommand::List => Invocation {
                command: "policy.list",
                arguments: json!({}),
            },
            PolicyCommand::Read { policy_key } => Invocation {
                command: "policy.read",
                arguments: json!({ "key": policy_key }),
            },
        },
        Command::Worktree { command } => match command {
            WorktreeCommand::List => Invocation {
                command: "worktree.list",
                arguments: json!({}),
            },
            WorktreeCommand::Create(args) => {
                let (intent, branch, base_revision) = if let Some(revision) = args.detach {
                    ("detached", None, Some(revision))
                } else if let Some(existing) = args.existing {
                    ("existingBranch", Some(existing), None)
                } else {
                    ("newBranch", args.branch, args.from)
                };
                Invocation {
                    command: "worktree.create",
                    arguments: json!({
                        "name": args.name,
                        "intent": intent,
                        "branch": branch,
                        "baseRevision": base_revision,
                        "switch": args.switch,
                    }),
                }
            }
            WorktreeCommand::Switch { worktree } => Invocation {
                command: "worktree.switch",
                arguments: json!({ "worktree": worktree }),
            },
            WorktreeCommand::Status { worktree } => Invocation {
                command: "worktree.status",
                arguments: json!({ "worktree": worktree }),
            },
            WorktreeCommand::Release => Invocation {
                command: "worktree.release",
                arguments: json!({}),
            },
            WorktreeCommand::Remove { worktree } => Invocation {
                command: "worktree.remove",
                arguments: json!({ "worktree": worktree }),
            },
        },
        Command::Target { command } => match command {
            TargetCommand::List { kind } => Invocation {
                command: "target.list",
                arguments: json!({ "kind": kind.map(|value| value.wire_name()) }),
            },
            TargetCommand::Show { target } => Invocation {
                command: "target.show",
                arguments: json!({ "target": target }),
            },
        },
        Command::Explorer { command } => match command {
            ExplorerCommand::List { surface, path } => {
                let mut arguments = target_arguments(surface.target);
                arguments.insert("path".to_string(), Value::String(path));
                Invocation {
                    command: "explorer.list",
                    arguments: Value::Object(arguments),
                }
            }
            ExplorerCommand::Read { surface, path } => {
                let mut arguments = target_arguments(surface.target);
                arguments.insert("path".to_string(), Value::String(path));
                Invocation {
                    command: "explorer.read",
                    arguments: Value::Object(arguments),
                }
            }
            ExplorerCommand::Write {
                surface,
                path,
                file,
            } => {
                let content = if let Some(file) = file {
                    fs::read_to_string(&file)
                        .map_err(|error| format!("could not read {}: {error}", file.display()))?
                } else {
                    read_stdin("explorer write")?
                };
                let mut arguments = target_arguments(surface.target);
                arguments.insert("path".to_string(), Value::String(path));
                arguments.insert("content".to_string(), Value::String(content));
                Invocation {
                    command: "explorer.write",
                    arguments: Value::Object(arguments),
                }
            }
        },
        Command::Terminal { command } => match command {
            TerminalCommand::Read { surface } => Invocation {
                command: "terminal.read",
                arguments: Value::Object(target_arguments(surface.target)),
            },
            TerminalCommand::Send { surface, raw, text } => {
                let mut data = if text.is_empty() {
                    read_stdin("terminal send")?
                } else {
                    text.join(" ")
                };
                if !raw {
                    data.push('\r');
                }
                let mut arguments = target_arguments(surface.target);
                arguments.insert("data".to_string(), Value::String(data));
                Invocation {
                    command: "terminal.send",
                    arguments: Value::Object(arguments),
                }
            }
            TerminalCommand::Restart { surface } => Invocation {
                command: "terminal.restart",
                arguments: Value::Object(target_arguments(surface.target)),
            },
        },
        Command::Browser { command } => match command {
            BrowserCommand::Services { surface } => Invocation {
                command: "browser.services",
                arguments: Value::Object(target_arguments(surface.target)),
            },
            BrowserCommand::Open { surface, url } => {
                let mut arguments = target_arguments(surface.target);
                arguments.insert("url".to_string(), Value::String(url));
                Invocation {
                    command: "browser.open",
                    arguments: Value::Object(arguments),
                }
            }
        },
        Command::Run { command } => match command {
            RunCommand::List => Invocation {
                command: "run.list",
                arguments: json!({}),
            },
            RunCommand::Show { action } => Invocation {
                command: "run.show",
                arguments: json!({ "action": action }),
            },
            RunCommand::Start { action, no_focus } => Invocation {
                command: "run.start",
                arguments: json!({ "action": action, "focus": !no_focus }),
            },
            RunCommand::Status { run_id } => Invocation {
                command: "run.status",
                arguments: json!({ "runId": run_id }),
            },
            RunCommand::Logs { run_id, tail } => {
                if !(1..=100_000).contains(&tail) {
                    return Err("--tail must be from 1 to 100000 characters.".to_string());
                }
                Invocation {
                    command: "run.logs",
                    arguments: json!({ "runId": run_id, "tail": tail }),
                }
            }
            RunCommand::Stop { run_id } => Invocation {
                command: "run.stop",
                arguments: json!({ "runId": run_id }),
            },
            RunCommand::Open { run_id } => Invocation {
                command: "run.open",
                arguments: json!({ "runId": run_id, "focus": true }),
            },
            RunCommand::Validate => Invocation {
                command: "run.validate",
                arguments: json!({}),
            },
            RunCommand::Setup { command } => match command {
                RunSetupCommand::Status => Invocation {
                    command: "run.setup-status",
                    arguments: json!({}),
                },
                RunSetupCommand::Retry => Invocation {
                    command: "run.setup-retry",
                    arguments: json!({}),
                },
            },
            RunCommand::Config { command } => match command {
                RunConfigCommand::Path => Invocation {
                    command: "run.config-path",
                    arguments: json!({}),
                },
                RunConfigCommand::Init { overwrite, name } => Invocation {
                    command: "run.config-init",
                    arguments: json!({ "overwrite": overwrite, "name": name }),
                },
            },
        },
    })
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let Some(command) = cli.command else {
        Cli::command().print_help().expect("write Cantrip CLI help");
        println!();
        return ExitCode::SUCCESS;
    };
    let invocation = match invocation(command) {
        Ok(invocation) => invocation,
        Err(message) => {
            eprintln!("cantrip: {message}");
            return ExitCode::from(2);
        }
    };
    match client::execute(
        invocation.command,
        invocation.arguments,
        cli.context.wire_name(),
    ) {
        Ok(result) => {
            let validation_failed = invocation.command == "run.validate"
                && result
                    .data
                    .as_ref()
                    .and_then(|value| value.get("valid"))
                    .and_then(Value::as_bool)
                    == Some(false);
            output::render(invocation.command, &result, cli.json);
            if validation_failed {
                ExitCode::from(2)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(error) => {
            eprintln!("cantrip: {error}");
            ExitCode::from(error.exit_code)
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser, error::ErrorKind};

    use super::{Cli, Command, ContextSelection, invocation};

    #[test]
    fn top_level_help_stays_brief_and_layered() {
        let mut output = Vec::new();
        Cli::command()
            .write_long_help(&mut output)
            .expect("render help");
        let help = String::from_utf8(output).expect("UTF-8 help");
        assert!(help.contains("Usage: cantrip [OPTIONS] [COMMAND]"));
        assert!(help.contains("worktree"));
        assert!(help.contains("policy"));
        assert!(help.contains("explorer"));
        assert!(help.contains("run"));
        assert!(help.contains("-v, --version"));
        assert!(help.contains("--context <CONTEXT>"));
        assert!(!help.contains("-V, --version"));
        assert!(!help.contains("--existing"));
        assert!(!help.contains("Surface title, full ID"));
    }

    #[test]
    fn worktree_help_documents_only_worktree_commands() {
        let mut root = Cli::command();
        let worktree = root
            .find_subcommand_mut("worktree")
            .expect("worktree command");
        let help = worktree.render_long_help().to_string();
        assert!(help.contains("create"));
        assert!(help.contains("release"));
        assert!(!help.contains("browser services"));
    }

    #[test]
    fn lowercase_v_is_the_only_short_version_flag() {
        let version = Cli::try_parse_from(["cantrip", "-v"]).expect_err("display version");
        assert_eq!(version.kind(), ErrorKind::DisplayVersion);
        assert!(version.to_string().contains(env!("CARGO_PKG_VERSION")));

        let uppercase = Cli::try_parse_from(["cantrip", "-V"]).expect_err("reject -V");
        assert_eq!(uppercase.kind(), ErrorKind::UnknownArgument);
    }

    #[test]
    fn version_flag_is_not_required_by_real_commands() {
        let root = Cli::try_parse_from(["cantrip"]).expect("parse root command");
        assert!(root.command.is_none());
        assert_eq!(root.version, None);

        for arguments in [
            &["cantrip", "status"][..],
            &["cantrip", "status", "--json"][..],
            &["cantrip", "policy", "list"][..],
            &["cantrip", "policy", "read", "manual-change-protocol"][..],
            &["cantrip", "worktree", "list"][..],
            &["cantrip", "target", "list"][..],
            &["cantrip", "explorer", "list"][..],
            &["cantrip", "terminal", "read"][..],
            &["cantrip", "browser", "services"][..],
            &["cantrip", "run", "list"][..],
            &["cantrip", "run", "show", "Run app"][..],
            &["cantrip", "run", "start", "Run app", "--no-focus"][..],
            &["cantrip", "run", "status"][..],
            &[
                "cantrip",
                "run",
                "logs",
                "00000000-0000-0000-0000-000000000001",
            ][..],
            &[
                "cantrip",
                "run",
                "stop",
                "00000000-0000-0000-0000-000000000001",
            ][..],
            &[
                "cantrip",
                "run",
                "open",
                "00000000-0000-0000-0000-000000000001",
            ][..],
            &["cantrip", "run", "validate"][..],
            &["cantrip", "run", "config", "path"][..],
            &["cantrip", "run", "config", "init"][..],
        ] {
            Cli::try_parse_from(arguments).unwrap_or_else(|error| {
                panic!("failed to parse {arguments:?} without -v: {error}")
            });
        }
    }

    #[test]
    fn context_selection_is_global_and_explicit() {
        let before = Cli::try_parse_from(["cantrip", "--context", "cwd", "run", "config", "init"])
            .expect("parse context before command");
        let after = Cli::try_parse_from(["cantrip", "run", "config", "init", "--context", "lane"])
            .expect("parse context after command");
        assert_eq!(before.context, ContextSelection::Cwd);
        assert_eq!(after.context, ContextSelection::Lane);
    }

    #[test]
    fn run_commands_use_stable_wire_names() {
        for (arguments, expected) in [
            (&["cantrip", "run", "list"][..], "run.list"),
            (
                &["cantrip", "run", "show", "Run Spectral Lab"][..],
                "run.show",
            ),
            (&["cantrip", "run", "validate"][..], "run.validate"),
            (
                &["cantrip", "run", "setup", "status"][..],
                "run.setup-status",
            ),
            (&["cantrip", "run", "setup", "retry"][..], "run.setup-retry"),
            (&["cantrip", "run", "config", "path"][..], "run.config-path"),
            (&["cantrip", "run", "config", "init"][..], "run.config-init"),
            (
                &["cantrip", "run", "start", "Run Spectral Lab"][..],
                "run.start",
            ),
            (&["cantrip", "run", "status"][..], "run.status"),
            (
                &[
                    "cantrip",
                    "run",
                    "logs",
                    "00000000-0000-0000-0000-000000000001",
                ][..],
                "run.logs",
            ),
            (
                &[
                    "cantrip",
                    "run",
                    "stop",
                    "00000000-0000-0000-0000-000000000001",
                ][..],
                "run.stop",
            ),
            (
                &[
                    "cantrip",
                    "run",
                    "open",
                    "00000000-0000-0000-0000-000000000001",
                ][..],
                "run.open",
            ),
        ] {
            let cli = Cli::try_parse_from(arguments).expect("parse run command");
            let invocation =
                invocation(cli.command.expect("run command")).expect("build run invocation");
            assert_eq!(invocation.command, expected);
        }

        let initialized = Cli::try_parse_from([
            "cantrip",
            "run",
            "config",
            "init",
            "--overwrite",
            "--name",
            "Spectral Lab",
        ])
        .expect("parse config init");
        let invocation = invocation(initialized.command.expect("run config init"))
            .expect("build config init invocation");
        assert_eq!(invocation.command, "run.config-init");
        assert_eq!(invocation.arguments["overwrite"], true);
        assert_eq!(invocation.arguments["name"], "Spectral Lab");
    }

    #[test]
    fn policy_commands_use_the_stable_wire_names() {
        let list = Cli::try_parse_from(["cantrip", "policy", "list"]).expect("parse policy list");
        let read = Cli::try_parse_from([
            "cantrip",
            "--json",
            "policy",
            "read",
            "manual-change-protocol",
        ])
        .expect("parse policy read");

        let Some(Command::Policy { command: list }) = list.command else {
            panic!("expected policy list command");
        };
        let Some(Command::Policy { command: read }) = read.command else {
            panic!("expected policy read command");
        };
        let list =
            invocation(Command::Policy { command: list }).expect("build policy list invocation");
        let read =
            invocation(Command::Policy { command: read }).expect("build policy read invocation");
        assert_eq!(list.command, "policy.list");
        assert_eq!(read.command, "policy.read");
        assert_eq!(read.arguments["key"], "manual-change-protocol");
    }
}
