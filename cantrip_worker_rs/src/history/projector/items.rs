use super::*;
impl Run {
    pub(super) async fn flush_items(&mut self) -> Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let options = &self.projector.0.options;
        self.projector.active()?;
        let items = self
            .pending
            .iter()
            .map(|p| {
                obj([
                    ("identity", p.draft["identity"].clone()),
                    ("association", p.association.clone()),
                ])
            })
            .collect();
        let mappings = options
            .client
            .resolve(
                obj([
                    ("chatId", options.binding["chatId"].clone()),
                    ("bindingId", options.binding["id"].clone()),
                    ("items", Value::Array(items)),
                ]),
                options.signal.clone(),
            )
            .await?;
        if array(&mappings)?.len() != self.pending.len() {
            bail!("Native history resolution omitted item mappings.");
        }
        for (entry, mapping) in self.pending.iter().zip(array(&mappings)?) {
            self.projector.active()?;
            if key(&mapping["identity"]) != key(&entry.draft["identity"]) {
                bail!("Native history resolution returned an unrelated item mapping.");
            }
            let preserved = cantrip_wire::coercion::truthy(mapping.get("preservedInput"));
            let material = if preserved {
                Materialization {
                    input_parts: None,
                    attachments: Value::Array(Vec::new()),
                }
            } else {
                options
                    .adapters
                    .materialize(
                        entry.item.clone(),
                        entry.turn.clone(),
                        entry.context.clone(),
                        mapping.get("attachments").cloned(),
                    )
                    .await?
            };
            let draft = if preserved {
                entry.draft.clone()
            } else {
                let mut context = entry.context.clone();
                if let Some(parts) = material.input_parts {
                    context["inputParts"] = parts;
                } else {
                    remove(&mut context, "inputParts");
                }
                let rendered = render::item(&entry.item, &context)?;
                let Some(draft) = rendered.get(entry.order["component"].as_u64().unwrap() as usize)
                else {
                    bail!("Native history materialization changed the item identity.");
                };
                draft.clone()
            };
            if key(&draft["identity"]) != key(&mapping["identity"]) {
                bail!("Native history materialization changed the item identity.");
            }
            let digest = draft_fingerprint(&draft, &entry.order, &material.attachments);
            let prior = self.publications.get(&key(&draft["identity"]));
            if prior.is_some_and(|p| p["fingerprint"] == digest) {
                continue;
            }
            let revision =
                Value::Number(prior.map_or(0., |p| p["revision"].as_f64().unwrap()) + 1.);
            let mut prepared = canonical::prepare_item(
                options.service.as_ref(),
                &options.binding,
                &draft,
                mapping,
                &revision,
                &entry.order,
                &material.attachments,
            )?;
            prepared["expectedRevision"] = prior
                .and_then(|p| p.get("canonicalRevision").or(p.get("revision")))
                .cloned()
                .unwrap_or(Value::Number(0.));
            let state = prepared["state"].clone();
            self.batches.append("items", prepared);
            self.publications.insert(
                key(&entry.draft["identity"]),
                obj([
                    ("identity", entry.draft["identity"].clone()),
                    ("revision", revision.clone()),
                    ("fingerprint", digest),
                    ("canonicalRevision", revision),
                    ("canonicalState", state),
                ]),
            );
        }
        self.pending.clear();
        Ok(())
    }
}
