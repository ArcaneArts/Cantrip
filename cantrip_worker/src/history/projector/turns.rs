use super::*;
fn millis(value: &Value) -> Value {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .map_or(Value::Null, |v| Value::Number(v * 1000.))
}
impl Run {
    pub(super) fn turn(&mut self, turn: &Value, reduced: &Value, source: &Value) -> Result<()> {
        if cantrip_protocol::parse(
            "historyProjectorTurnStatusSchema",
            turn["body"].get("status"),
        )
        .is_err()
        {
            return Ok(());
        }
        let evidence: Vec<_> = array(&source["evidence"])?
            .iter()
            .filter(|entry| {
                entry["params"]["turnId"] == turn["id"]
                    || (entry["params"]["turn"].is_object()
                        && entry["params"]["turn"]["id"] == turn["id"])
                    || entry["method"] == "thread/read"
            })
            .cloned()
            .collect();
        let content = obj([
            ("version", Value::Number(2.)),
            ("reducedTurn", reduced.clone()),
            ("evidence", Value::Array(evidence.clone())),
        ]);
        let binding = &self.projector.0.options.binding;
        let attribution =
            canonical::model_attribution(&binding["threadId"], &turn["id"], &reduced["metadata"]);
        let usage = preparation::usage(&binding["threadId"], &turn["id"], &reduced["metadata"])?;
        let mut semantic = content.clone();
        if let Some(usage) = &usage {
            semantic["usage"] = usage.clone();
        }
        if let Some(attribution) = &attribution {
            semantic["modelAttribution"] = attribution.clone();
        }
        semantic["reducedTurn"] = without(reduced, "origin");
        let mut unique = indexmap::IndexSet::new();
        for record in evidence {
            unique.insert(
                obj([
                    ("method", record["method"].clone()),
                    ("params", record["params"].clone()),
                ])
                .stringify_canonical(),
            );
        }
        semantic["evidence"] = Value::Array(unique.into_iter().map(s).collect());
        let digest = fingerprint(&semantic);
        let id = text(&turn["id"])?;
        let prior = self.turn_publications.get(id);
        if prior.is_some_and(|p| p["fingerprint"] == digest) {
            return Ok(());
        }
        let revision = Value::Number(prior.map_or(0., |p| p["revision"].as_f64().unwrap()) + 1.);
        let mut header = obj([
            ("threadId", binding["threadId"].clone()),
            ("turnId", turn["id"].clone()),
            ("revision", revision.clone()),
            ("ordinal", turn["ordinal"].clone()),
            ("status", turn["body"]["status"].clone()),
            ("startedAtMs", millis(&turn["body"]["startedAt"])),
            ("completedAtMs", millis(&turn["body"]["completedAt"])),
        ]);
        if let Some(usage) = usage {
            header["usage"] = usage;
        }
        if let Some(attribution) = attribution {
            header["modelAttribution"] = attribution;
        }
        let prepared = canonical::protect_turn(
            self.projector.0.options.service.as_ref(),
            binding,
            &header,
            &content,
        )?;
        self.batches.append("turns", prepared);
        self.turn_publications.insert(
            id.clone(),
            obj([
                ("turnId", turn["id"].clone()),
                ("revision", revision),
                ("fingerprint", digest),
            ]),
        );
        Ok(())
    }
}
