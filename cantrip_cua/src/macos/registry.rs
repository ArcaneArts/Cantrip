use crate::{
    error::{CuaError, ErrorCode, Result},
    target::{MAX_SEQUENCE, Target},
};
use std::collections::{HashMap, HashSet};

const MAX_REGISTRY_ENTRIES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub process_id: Option<u32>,
    pub application_id: Option<String>,
}
pub(super) struct Candidate {
    pub target: Target,
    pub identity: Identity,
}
pub(super) struct Inventory {
    pub candidates: Vec<Candidate>,
    pub present: HashMap<String, Identity>,
    pub truncated: bool,
}
#[derive(Default)]
pub(super) struct Registry {
    sequence: u64,
    entries: HashMap<String, (Identity, u64)>,
}
impl Registry {
    pub(super) fn tracked(&self) -> HashSet<String> {
        self.entries.keys().cloned().collect()
    }
    pub(super) fn update(&mut self, inventory: Inventory) -> Result<(Vec<Target>, bool)> {
        // Only disappearance or a changed native owner retires an incarnation.
        // Geometry, title, occlusion and Retina scale are mutable metadata.
        self.entries
            .retain(|id, (identity, _)| inventory.present.get(id) == Some(identity));
        let new_count = inventory
            .candidates
            .iter()
            .filter(|candidate| !self.entries.contains_key(&candidate.target.id))
            .count();
        if self.entries.len() + new_count > MAX_REGISTRY_ENTRIES {
            return Err(CuaError::new(
                ErrorCode::Capacity,
                "Native target registry has reached its 4096 live target limit.",
            ));
        }
        let mut targets = Vec::with_capacity(inventory.candidates.len());
        for mut candidate in inventory.candidates {
            let generation = if let Some((_, generation)) = self.entries.get(&candidate.target.id) {
                *generation
            } else {
                self.sequence = self
                    .sequence
                    .checked_add(1)
                    .filter(|&value| value <= MAX_SEQUENCE)
                    .ok_or_else(|| {
                        CuaError::new(
                            ErrorCode::Capacity,
                            "Native target generation limit reached.",
                        )
                    })?;
                self.entries.insert(
                    candidate.target.id.clone(),
                    (candidate.identity, self.sequence),
                );
                self.sequence
            };
            candidate.target.generation = generation;
            targets.push(candidate.target);
        }
        Ok((targets, inventory.truncated))
    }
    pub(super) fn identity(&self, target: &Target) -> Result<Identity> {
        self.entries
            .get(&target.id)
            .filter(|(_, generation)| *generation == target.generation)
            .map(|(identity, _)| identity.clone())
            .ok_or_else(|| {
                CuaError::new(
                    ErrorCode::StaleTarget,
                    "The selected native target is no longer the same incarnation.",
                )
            })
    }
    pub(super) fn remove(&mut self, id: &str) {
        self.entries.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{CaptureBackend, FakeBackend};
    use crate::cancellation::Cancellation;
    fn inventory(target: Target, pid: u32) -> Inventory {
        let identity = Identity {
            process_id: Some(pid),
            application_id: Some("fixture".into()),
        };
        Inventory {
            present: [(target.id.clone(), identity.clone())].into(),
            candidates: vec![Candidate { target, identity }],
            truncated: false,
        }
    }
    #[test]
    fn metadata_changes_preserve_generation_but_owner_change_or_disappearance_does_not() {
        let mut registry = Registry::default();
        let source = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .remove(0);
        let first = registry
            .update(inventory(source.clone(), 1))
            .unwrap()
            .0
            .remove(0);
        let mut changed = source.clone();
        changed.bounds.width = 900.0;
        changed.title = Some("New".into());
        changed.scale_factor = 1.0;
        let second = registry.update(inventory(changed, 1)).unwrap().0.remove(0);
        assert_eq!(first.generation, second.generation);
        let third = registry
            .update(inventory(source.clone(), 2))
            .unwrap()
            .0
            .remove(0);
        assert_ne!(first.generation, third.generation);
        assert!(registry.identity(&first).is_err());
        registry
            .update(Inventory {
                candidates: vec![],
                present: HashMap::new(),
                truncated: false,
            })
            .unwrap();
        let fourth = registry.update(inventory(source, 2)).unwrap().0.remove(0);
        assert_ne!(third.generation, fourth.generation);
    }
    #[test]
    fn a_selected_target_omitted_from_public_budget_keeps_its_generation() {
        let mut registry = Registry::default();
        let source = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .remove(0);
        let first = registry
            .update(inventory(source.clone(), 1))
            .unwrap()
            .0
            .remove(0);
        let mut limited = inventory(source, 1);
        limited.candidates.clear();
        limited.truncated = true;
        assert!(registry.update(limited).unwrap().1);
        assert!(registry.identity(&first).is_ok());
    }

    #[test]
    fn reaching_registry_capacity_does_not_evict_an_existing_selected_target() {
        let mut registry = Registry::default();
        let source = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .remove(0);
        let first = registry
            .update(inventory(source.clone(), 1))
            .unwrap()
            .0
            .remove(0);
        let identity = registry.identity(&first).unwrap();
        for index in 1..MAX_REGISTRY_ENTRIES {
            registry.entries.insert(
                format!("other-{index}"),
                (identity.clone(), index as u64 + 1),
            );
        }
        let mut extra = source;
        extra.id = "additional-target".into();
        let mut proposed = inventory(extra, 1);
        proposed.present.extend(
            registry
                .entries
                .iter()
                .map(|(id, (identity, _))| (id.clone(), identity.clone())),
        );
        assert_eq!(
            registry.update(proposed).unwrap_err().code,
            ErrorCode::Capacity
        );
        assert_eq!(registry.entries.len(), MAX_REGISTRY_ENTRIES);
        assert!(registry.identity(&first).is_ok());
    }

    #[test]
    fn reused_display_identifier_with_different_uuid_gets_a_new_generation() {
        let mut registry = Registry::default();
        let source = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .remove(0);
        let mut old = inventory(source.clone(), 1);
        old.candidates[0].identity.application_id = Some("display-uuid-one".into());
        old.present
            .insert(source.id.clone(), old.candidates[0].identity.clone());
        let first = registry.update(old).unwrap().0.remove(0);
        let mut replacement = inventory(source.clone(), 1);
        replacement.candidates[0].identity.application_id = Some("display-uuid-two".into());
        replacement
            .present
            .insert(source.id, replacement.candidates[0].identity.clone());
        let second = registry.update(replacement).unwrap().0.remove(0);
        assert_ne!(first.generation, second.generation);
        assert!(registry.identity(&first).is_err());
    }

    #[test]
    fn display_without_optional_uuid_preserves_metadata_updates_and_retires_on_disappearance() {
        let mut registry = Registry::default();
        let source = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .into_iter()
            .find(|target| target.kind == crate::target::TargetKind::Monitor)
            .unwrap();
        let display_inventory = |target: Target| {
            let identity = Identity {
                process_id: None,
                application_id: None,
            };
            Inventory {
                present: [(target.id.clone(), identity.clone())].into(),
                candidates: vec![Candidate { target, identity }],
                truncated: false,
            }
        };
        let first = registry
            .update(display_inventory(source.clone()))
            .unwrap()
            .0
            .remove(0);
        let mut changed = source.clone();
        changed.bounds.x = -3000.0;
        changed.title = Some("Changed display metadata".into());
        changed.scale_factor = 2.0;
        let second = registry
            .update(display_inventory(changed))
            .unwrap()
            .0
            .remove(0);
        assert_eq!(first.generation, second.generation);
        assert_eq!(registry.identity(&first).unwrap().application_id, None);
        registry
            .update(Inventory {
                candidates: vec![],
                present: HashMap::new(),
                truncated: false,
            })
            .unwrap();
        assert!(registry.identity(&first).is_err());
        let returned = registry
            .update(display_inventory(source))
            .unwrap()
            .0
            .remove(0);
        assert_ne!(first.generation, returned.generation);
    }
}
