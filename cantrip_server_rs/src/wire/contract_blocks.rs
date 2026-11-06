//! Compose independent generated graphs without coupling their node indices.
use super::Contracts;

const BASE: &str = include_str!("../../contracts/security.json");
const RUN: &str = include_str!("../../contracts/mcp-run.json");
const SURFACE: &str = include_str!("../../contracts/mcp-surface.json");

pub(super) fn load() -> Contracts {
    let mut contracts: Contracts = serde_json::from_str(BASE).expect("embedded protocol contracts");
    contracts.append(serde_json::from_str(RUN).expect("embedded Run MCP contracts"));
    contracts.append(serde_json::from_str(SURFACE).expect("embedded surface MCP contracts"));
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

    fn source_contracts_survive_growth(block: &str, label: &str) -> Result<()> {
        let base: Contracts = serde_json::from_str(BASE)?;
        let run: Contracts = serde_json::from_str(RUN)?;
        let surface: Contracts = serde_json::from_str(SURFACE)?;
        assert!(run.roots.keys().all(|name| !base.roots.contains_key(name)));
        assert!(
            surface
                .roots
                .keys()
                .all(|name| !base.roots.contains_key(name) && !run.roots.contains_key(name))
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
            graph.compile_patterns();
            graphs.push(graph);
        }
        let mut schemas: Vec<_> = selected.roots.keys().collect();
        schemas.sort();
        let mut count = 0;
        for schema in schemas {
            let output = Command::new("node")
                .args([
                    "scripts/server-rust/security-oracle.mjs",
                    "--vectors",
                    schema,
                ])
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
