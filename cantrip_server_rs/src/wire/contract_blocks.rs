//! Compose independent generated graphs without coupling their node indices.
use super::Contracts;

const BASE: &str = include_str!("../../contracts/security.json");
const RUN: &str = include_str!("../../contracts/mcp-run.json");
const SURFACE: &str = include_str!("../../contracts/mcp-surface.json");
const CLI: &str = include_str!("../../contracts/cli.json");
const PROJECT_EXPORTS: &str = include_str!("../../contracts/project-exports.json");
const ATTACHMENTS: &str = include_str!("../../contracts/chat-attachments.json");
const WORKER_MANAGEMENT: &str = include_str!("../../contracts/worker-management.json");
const WORKER_OPERATIONS: &str = include_str!("../../contracts/worker-operations.json");
const PROJECT_ADMINISTRATION: &str = include_str!("../../contracts/project-administration.json");
const CHAT_CONTROL: &str = include_str!("../../contracts/chat-control.json");
const OPERATIONAL_STATUS: &str = include_str!("../../contracts/operational-status.json");
const WORKER_LOGS: &str = include_str!("../../contracts/worker-logs.json");
const PROJECT_INSIGHTS: &str = include_str!("../../contracts/project-insights.json");

const REMOTE_SURFACE_HTTP: &str = include_str!("../../contracts/remote-surface-http.json");
const COMPUTER_USE_HTTP: &str = include_str!("../../contracts/computer-use-http.json");

pub(super) fn load() -> Contracts {
    let mut contracts: Contracts = serde_json::from_str(BASE).expect("embedded protocol contracts");
    contracts.append(serde_json::from_str(RUN).expect("embedded Run MCP contracts"));
    contracts.append(serde_json::from_str(SURFACE).expect("embedded surface MCP contracts"));
    contracts.append(serde_json::from_str(CLI).expect("embedded CLI contracts"));
    contracts
        .append(serde_json::from_str(PROJECT_EXPORTS).expect("embedded project export contracts"));
    contracts.append(serde_json::from_str(ATTACHMENTS).expect("embedded attachment contracts"));
    contracts.append(
        serde_json::from_str(WORKER_MANAGEMENT).expect("embedded worker management contracts"),
    );
    contracts.append(
        serde_json::from_str(WORKER_OPERATIONS).expect("embedded worker operation contracts"),
    );
    contracts.append(
        serde_json::from_str(PROJECT_ADMINISTRATION)
            .expect("embedded project administration contracts"),
    );
    contracts.append(serde_json::from_str(CHAT_CONTROL).expect("embedded Chat control contracts"));
    contracts.append(
        serde_json::from_str(OPERATIONAL_STATUS).expect("embedded operational status contracts"),
    );
    contracts.append(serde_json::from_str(WORKER_LOGS).expect("embedded worker log contracts"));
    contracts.append(
        serde_json::from_str(PROJECT_INSIGHTS).expect("embedded project insight contracts"),
    );
    contracts.append(
        serde_json::from_str(REMOTE_SURFACE_HTTP).expect("embedded remote surface HTTP contracts"),
    );
    contracts.append(
        serde_json::from_str(COMPUTER_USE_HTTP).expect("embedded computer-use HTTP contracts"),
    );
    contracts.compile_patterns();
    contracts
}

impl Contracts {
    fn append(&mut self, mut block: Self) {
        let offset = self.nodes.len();
        for node in &mut block.nodes {
            for reference in node.shape.values_mut() {
                *reference = (reference.as_u64().expect("generated property reference")
                    + offset as u64)
                    .into();
            }
            for reference in [
                &mut node.inner_type,
                &mut node.left,
                &mut node.right,
                &mut node.element,
                &mut node.key_type,
                &mut node.value_type,
                &mut node.catchall,
                &mut node.rest,
                &mut node.input,
                &mut node.output,
            ]
            .into_iter()
            .flatten()
            {
                *reference += offset;
            }
            for reference in node.options.iter_mut().chain(&mut node.items) {
                *reference += offset;
            }
        }
        self.roots.extend(
            block
                .roots
                .into_iter()
                .map(|(name, reference)| (name, reference + offset)),
        );
        self.nodes.extend(block.nodes);
    }

    fn compile_patterns(&mut self) {
        for node in &mut self.nodes {
            for check in &mut node.checks {
                if let Some(pattern) = &check.pattern {
                    check.compiled = Some(
                        regress::Regex::with_flags(pattern, check.flags.as_str())
                            .expect("compiled protocol regex"),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{ValidationError, Value, parsed_value};
    use anyhow::{Context, Result};
    use std::{path::Path, process::Command};

    #[test]
    fn run_source_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(RUN, "Run")
    }

    #[test]
    fn surface_source_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(SURFACE, "surface")
    }

    #[test]
    fn cli_source_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(CLI, "CLI")
    }
    #[test]
    fn project_export_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(PROJECT_EXPORTS, "project export")
    }
    #[test]
    fn attachment_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(ATTACHMENTS, "attachment")
    }
    #[test]
    fn worker_management_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(WORKER_MANAGEMENT, "worker management")
    }
    #[test]
    fn worker_operation_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(WORKER_OPERATIONS, "worker operations")
    }

    #[test]
    fn project_administration_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(PROJECT_ADMINISTRATION, "project administration")
    }

    #[test]
    fn chat_control_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(CHAT_CONTROL, "chat control")
    }

    #[test]
    fn operational_status_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(OPERATIONAL_STATUS, "operational status")
    }

    #[test]
    fn worker_log_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(WORKER_LOGS, "worker logs")
    }

    #[test]
    fn project_insight_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(PROJECT_INSIGHTS, "project insights")
    }

    #[test]
    fn remote_surface_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(REMOTE_SURFACE_HTTP, "remote surface HTTP")
    }

    #[test]
    fn computer_use_contracts_survive_unrelated_base_graph_growth() -> Result<()> {
        source_contracts_survive_growth(COMPUTER_USE_HTTP, "computer-use HTTP")
    }

    fn source_contracts_survive_growth(block: &str, label: &str) -> Result<()> {
        let base: Contracts = serde_json::from_str(BASE)?;
        let run: Contracts = serde_json::from_str(RUN)?;
        let surface: Contracts = serde_json::from_str(SURFACE)?;
        let cli: Contracts = serde_json::from_str(CLI)?;
        let exports: Contracts = serde_json::from_str(PROJECT_EXPORTS)?;
        let attachments: Contracts = serde_json::from_str(ATTACHMENTS)?;
        let management: Contracts = serde_json::from_str(WORKER_MANAGEMENT)?;
        let operations: Contracts = serde_json::from_str(WORKER_OPERATIONS)?;
        let administration: Contracts = serde_json::from_str(PROJECT_ADMINISTRATION)?;
        let chat_control: Contracts = serde_json::from_str(CHAT_CONTROL)?;
        let operational_status: Contracts = serde_json::from_str(OPERATIONAL_STATUS)?;
        let worker_logs: Contracts = serde_json::from_str(WORKER_LOGS)?;
        let project_insights: Contracts = serde_json::from_str(PROJECT_INSIGHTS)?;
        let remote_surfaces: Contracts = serde_json::from_str(REMOTE_SURFACE_HTTP)?;
        let computer_use: Contracts = serde_json::from_str(COMPUTER_USE_HTTP)?;
        for name in computer_use.roots.keys() {
            for graph in [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
                &operations,
                &administration,
                &chat_control,
                &operational_status,
                &worker_logs,
                &project_insights,
                &remote_surfaces,
            ] {
                assert!(!graph.roots.contains_key(name));
            }
        }
        assert!(remote_surfaces.roots.keys().all(|name| {
            [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
                &operations,
                &administration,
                &chat_control,
                &operational_status,
                &worker_logs,
                &project_insights,
            ]
            .iter()
            .all(|graph| !graph.roots.contains_key(name))
        }));
        assert!(project_insights.roots.keys().all(|name| {
            [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
                &operations,
                &administration,
                &chat_control,
                &operational_status,
                &worker_logs,
            ]
            .iter()
            .all(|graph| !graph.roots.contains_key(name))
        }));
        assert!(worker_logs.roots.keys().all(|name| {
            [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
                &operations,
                &administration,
                &chat_control,
                &operational_status,
            ]
            .iter()
            .all(|graph| !graph.roots.contains_key(name))
        }));
        assert!(operational_status.roots.keys().all(|name| {
            [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
                &operations,
                &administration,
                &chat_control,
            ]
            .iter()
            .all(|graph| !graph.roots.contains_key(name))
        }));
        assert!(chat_control.roots.keys().all(|name| {
            [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
                &operations,
                &administration,
            ]
            .iter()
            .all(|graph| !graph.roots.contains_key(name))
        }));
        assert!(administration.roots.keys().all(|name| {
            [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
                &operations,
            ]
            .iter()
            .all(|graph| !graph.roots.contains_key(name))
        }));
        assert!(operations.roots.keys().all(|name| {
            [
                &base,
                &run,
                &surface,
                &cli,
                &exports,
                &attachments,
                &management,
            ]
            .iter()
            .all(|graph| !graph.roots.contains_key(name))
        }));
        assert!(
            management
                .roots
                .keys()
                .all(|name| !base.roots.contains_key(name)
                    && !run.roots.contains_key(name)
                    && !surface.roots.contains_key(name)
                    && !cli.roots.contains_key(name)
                    && !exports.roots.contains_key(name)
                    && !attachments.roots.contains_key(name))
        );
        assert!(
            attachments
                .roots
                .keys()
                .all(|name| !base.roots.contains_key(name)
                    && !run.roots.contains_key(name)
                    && !surface.roots.contains_key(name)
                    && !cli.roots.contains_key(name)
                    && !exports.roots.contains_key(name))
        );
        assert!(run.roots.keys().all(|name| !base.roots.contains_key(name)));
        assert!(
            surface
                .roots
                .keys()
                .all(|name| !base.roots.contains_key(name) && !run.roots.contains_key(name))
        );
        assert!(cli.roots.keys().all(|name| !base.roots.contains_key(name)
            && !run.roots.contains_key(name)
            && !surface.roots.contains_key(name)));
        assert!(
            exports
                .roots
                .keys()
                .all(|name| !base.roots.contains_key(name)
                    && !run.roots.contains_key(name)
                    && !surface.roots.contains_key(name)
                    && !cli.roots.contains_key(name))
        );
        let selected: Contracts = serde_json::from_str(block)?;
        let mut graphs = Vec::new();
        for extra_nodes in [0, 7, 41] {
            let mut graph: Contracts = serde_json::from_str(BASE)?;
            for _ in 0..extra_nodes {
                graph
                    .nodes
                    .push(serde_json::from_str(r#"{"type":"unknown"}"#)?);
            }
            graph.append(serde_json::from_str(RUN)?);
            graph.append(serde_json::from_str(SURFACE)?);
            graph.append(serde_json::from_str(CLI)?);
            graph.append(serde_json::from_str(PROJECT_EXPORTS)?);
            graph.append(serde_json::from_str(ATTACHMENTS)?);
            graph.append(serde_json::from_str(WORKER_MANAGEMENT)?);
            graph.append(serde_json::from_str(WORKER_OPERATIONS)?);
            graph.append(serde_json::from_str(PROJECT_ADMINISTRATION)?);
            graph.append(serde_json::from_str(CHAT_CONTROL)?);
            graph.append(serde_json::from_str(OPERATIONAL_STATUS)?);
            graph.append(serde_json::from_str(WORKER_LOGS)?);
            graph.append(serde_json::from_str(PROJECT_INSIGHTS)?);
            graph.append(serde_json::from_str(REMOTE_SURFACE_HTTP)?);
            graph.append(serde_json::from_str(COMPUTER_USE_HTTP)?);
            graph.compile_patterns();
            graphs.push(graph);
        }
        let mut schemas: Vec<_> = selected.roots.keys().collect();
        schemas.sort();
        let mut count = 0;
        for schema in schemas {
            let mut command = Command::new("node");
            if label == "computer-use HTTP" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/computer-use-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "remote surface HTTP" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/remote-surface-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "project insights" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/project-insight-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "worker logs" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/worker-log-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "operational status" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/operational-status-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "chat control" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/chat-control-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "project administration" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/project-administration-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "worker operations" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/worker-operation-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "worker management" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/worker-management-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "attachment" {
                command.args([
                    "--import",
                    "tsx",
                    "scripts/server-rust/chat-attachment-contract-oracle.mjs",
                    schema,
                ]);
            } else if label == "project export" {
                command.args([
                    "scripts/server-rust/project-export-contract-oracle.mjs",
                    schema,
                ]);
            } else {
                command.args([
                    "scripts/server-rust/security-oracle.mjs",
                    "--vectors",
                    schema,
                ]);
            }
            let output = command
                .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
                .output()?;
            anyhow::ensure!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let vectors: Value = serde_json::from_slice(&output.stdout)?;
            for (index, case) in vectors["cases"]
                .as_array()
                .context("Run oracle cases")?
                .iter()
                .enumerate()
            {
                for (offset, graph) in graphs.iter().enumerate() {
                    let result = graph
                        .run(graph.roots[schema], case.get("input"), &[])
                        .and_then(parsed_value);
                    let actual = match result {
                        Ok(value) => Value::object([("ok", value)]),
                        Err(ValidationError::Invalid(issues)) => {
                            Value::object([("issues", Value::Array(issues))])
                        }
                        Err(ValidationError::Operation) => {
                            Value::object([("thrown", Value::String("TypeError".into()))])
                        }
                    };
                    assert_eq!(
                        actual, case["outcome"],
                        "{schema} case {index}, growth variant {offset}"
                    );
                    if let Some(message) = case.get("errorMessage") {
                        assert_eq!(
                            Value::String(actual["issues"].stringify_pretty().into()),
                            *message,
                            "{schema} error {index}, growth variant {offset}"
                        );
                    }
                    count += 1;
                }
            }
        }
        println!(
            "{count} {label} Source comparisons across three independent base graph sizes matched"
        );
        Ok(())
    }
}
