//! Authorized component material and its durable anti-rollback boundary.
use super::{Identity, ServiceError};
use cantrip_crypto::{Zeroizing, checked, unwrap_component_key};
use cantrip_wire::{JsString, Value, coercion::truthy, value::json};
use indexmap::IndexMap;
use std::collections::BTreeMap;

type Keys = IndexMap<String, BTreeMap<u64, Zeroizing<Vec<u8>>>>;
pub struct ComponentKey {
    pub key: Zeroizing<Vec<u8>>,
    pub key_revision: u64,
}

pub(super) struct State {
    pub identity: Identity,
    pub worker_id: JsString,
    pub generation: u64,
    pub closing: bool,
    pub flight: Option<super::service::Flight>,
    keys: Keys,
    verified_server: Value,
    phase: &'static str,
    last_synced: Value,
    error: Value,
}
impl State {
    pub fn new(identity: Identity, worker_id: JsString) -> Self {
        Self {
            identity,
            worker_id,
            generation: 0,
            closing: false,
            flight: None,
            keys: IndexMap::new(),
            verified_server: Value::Null,
            phase: "pending-approval",
            last_synced: Value::Null,
            error: Value::Null,
        }
    }
    pub fn status(&self) -> Value {
        let grants=self.keys.iter().map(|(component,revisions)|json!({"component":component,"keyRevision":*revisions.last_key_value().unwrap().0})).collect::<Vec<_>>();
        // Every producer retains schema invariants, including UTF-16 bounds.
        checked("workerEncryptionStatusSchema",&json!({"supported":true,"state":self.phase,"principalId":self.identity.registration()["principalId"],"grants":grants,"lastSyncedAt":self.last_synced,"error":self.error})).expect("native encryption status")
    }
    pub fn owner_id(&self) -> Result<JsString, ServiceError> {
        self.identity
            .bound_owner()
            .as_js_string()
            .filter(|s| !s.is_empty())
            .cloned()
            .ok_or_else(|| {
                ServiceError::new(
                    "principal-unavailable",
                    "Worker encryption has not been bound to an account.",
                )
            })
    }
    pub fn server_identity(&self) -> Result<Value, ServiceError> {
        if self.verified_server.is_null() {
            return Err(ServiceError::new(
                "principal-unavailable",
                "Worker encryption has not verified the logical server identity.",
            ));
        }
        Ok(self.verified_server.clone())
    }
    pub fn component_key(
        &self,
        component: &str,
        revision: Option<u64>,
    ) -> Result<ComponentKey, ServiceError> {
        checked("workerEncryptionComponentScopeSchema", &json!(component))
            .map_err(ServiceError::from)?;
        let revisions = self.keys.get(component);
        let entry = revisions.and_then(|values| match revision {
            Some(revision) => values.get_key_value(&revision),
            None => values.last_key_value(),
        });
        let Some((revision, key)) = entry else {
            return Err(ServiceError::new(
                "missing-scope",
                format!("This worker does not have an active {component} encryption grant."),
            ));
        };
        Ok(ComponentKey {
            key: Zeroizing::new(key.to_vec()),
            key_revision: *revision,
        })
    }
    pub fn reject(&mut self, reason: &JsString, authoritative: bool) {
        if authoritative {
            self.verified_server = Value::Null;
            self.keys.clear();
        }
        self.phase = "error";
        let message = JsString::new(reason.units().iter().take(500).copied().collect());
        self.error = json!(if message.is_empty() {
            JsString::from("Worker encryption refresh failed.")
        } else {
            message
        });
    }
    pub fn lock(&mut self) {
        self.generation += 1;
        self.keys.clear();
        self.phase = "unavailable";
        self.error = json!("Worker encryption keys were cleared from memory.");
    }
    pub fn accept(&mut self, input: &Value, generation: u64) -> Result<Value, ServiceError> {
        if generation != self.generation {
            return Ok(self.status());
        }
        match self.apply(input) {
            Ok(()) => Ok(self.status()),
            Err(error) => {
                self.reject(&error.message, true);
                Err(error)
            }
        }
    }
    fn apply(&mut self, input: &Value) -> Result<(), ServiceError> {
        let result = checked("workerEncryptionBootstrapResultSchema", input).map_err(|_| {
            ServiceError::new(
                "principal-unavailable",
                "The server returned invalid worker encryption authorization.",
            )
        })?;
        let registration = self.identity.registration();
        let principal = &result["principal"];
        let changed = truthy(Some(self.identity.bound_server()))
            && self.identity.bound_server() != &result["serverId"];
        if principal["id"] != registration["principalId"]
            || principal["workerId"] != json!(self.worker_id)
            || principal["publicKey"] != registration["publicKey"]
        {
            return Err(ServiceError::new(
                "identity-mismatch",
                "The server returned a different worker encryption identity.",
            ));
        }
        if !changed
            && truthy(Some(self.identity.bound_owner()))
            && self.identity.bound_owner() != &result["ownerId"]
        {
            return Err(ServiceError::new(
                "identity-mismatch",
                "The worker encryption key belongs to another account.",
            ));
        }
        let mut accepted = if changed {
            json!({})
        } else {
            self.identity.accepted_revisions().clone()
        };
        if principal["state"] != "approved" {
            self.identity
                .persist_binding(&result["ownerId"], &result["serverId"], &accepted)
                .map_err(ServiceError::from)?;
            self.verified_server = result["serverId"].clone();
            self.keys.clear();
            self.phase = if principal["state"] == "pending" {
                "pending-approval"
            } else {
                "unavailable"
            };
            self.last_synced = timestamp();
            self.error = if principal["state"] == "revoked" {
                json!("Worker encryption authorization was revoked.")
            } else {
                Value::Null
            };
            return Ok(());
        }
        let mut groups: IndexMap<String, BTreeMap<u64, &Value>> = IndexMap::new();
        for grant in result["grants"].as_array().unwrap() {
            if grant["wrappedKey"]["purpose"] != "worker-component-key"
                || grant["wrappedKey"]["workerId"] != json!(self.worker_id)
            {
                return Err(ServiceError::new(
                    "identity-mismatch",
                    "A worker encryption grant targets another worker.",
                ));
            }
            groups
                .entry(grant["component"].as_str().unwrap().to_owned())
                .or_default()
                .insert(grant["keyRevision"].as_u64().unwrap(), grant);
        }
        for (component, revisions) in &groups {
            let latest = *revisions.last_key_value().unwrap().0;
            if latest < accepted[component.as_str()].as_u64().unwrap_or(0) {
                return Err(ServiceError::new(
                    "principal-unavailable",
                    format!("The {component} grant revision was rolled back."),
                ));
            }
        }
        let mut replacement: Keys = IndexMap::new();
        for (component, grants) in &groups {
            let mut revisions = BTreeMap::new();
            for (revision, grant) in grants {
                let key = unwrap_component_key(
                    &result["ownerId"],
                    &grant["wrappedKey"],
                    self.identity.key_pair(),
                )
                .map_err(|_| {
                    ServiceError::new(
                        "principal-unavailable",
                        "A worker encryption grant could not be opened.",
                    )
                })?;
                revisions.insert(*revision, key);
            }
            accepted[component.as_str()] = json!(*revisions.last_key_value().unwrap().0);
            replacement.insert(component.clone(), revisions);
        }
        // No key/binding is accepted before the complete replacement validates
        // and the durable identity/high-water publication actually succeeds.
        self.identity
            .persist_binding(&result["ownerId"], &result["serverId"], &accepted)
            .map_err(ServiceError::from)?;
        self.keys = replacement;
        self.verified_server = result["serverId"].clone();
        self.phase = "ready";
        self.error = Value::Null;
        self.last_synced = timestamp();
        Ok(())
    }
}
fn timestamp() -> Value {
    json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
