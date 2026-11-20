//! Operation-bound customization documents stay private to the endpoints.
use super::{open_endpoint_content, protect_endpoint_content};
use crate::{encryption::Service, http::checked};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value, value::json};

pub(crate) struct Operation<'a> {
    service: &'a Service,
    identity: (JsString, Value),
    id: &'a Value,
    name: &'a Value,
    pub scope: Value,
}

impl<'a> Operation<'a> {
    pub fn new(service: &'a Service, command: &'a Value) -> Result<Self> {
        let scope = checked("customizationContentScopeSchema", &command["scope"])?;
        let identity = service.bound_identity()?;
        ensure!(
            scope["workerId"].as_js_string() == Some(service.worker_id()),
            "Protected customization scope targets another worker."
        );
        ensure!(
            command["serverId"] == identity.1,
            "Protected customization scope targets another server."
        );
        Ok(Self {
            service,
            identity,
            id: &command["operationId"],
            name: &command["type"],
            scope,
        })
    }

    pub fn identity(&self) -> &(JsString, Value) {
        &self.identity
    }

    fn binding(&self, direction: &str) -> Value {
        let scope_id = json!([
            &self.scope["workerId"],
            &self.scope["projectId"],
            &self.scope["chatId"],
            &self.scope["providerId"],
        ])
        .stringify();
        json!({
            "domain":"customization-content", "serverId":self.identity.1,
            "workerId":self.scope["workerId"], "scopeId":scope_id,
            "operationId":self.id, "operation":self.name, "direction":direction, "sequence":0,
        })
    }

    pub fn assert_current(&self) -> Result<()> {
        ensure!(
            self.service.bound_identity()? == self.identity,
            "The worker binding changed during customization."
        );
        Ok(())
    }

    pub fn open(&self, opaque: &Value, schema: &str) -> Result<Value> {
        let content =
            open_endpoint_content(self.service, &self.binding("request"), opaque, schema)?;
        self.assert_current()?;
        Ok(content)
    }

    pub fn seal(&self, result: Result<Value>, schema: &str) -> Result<Value> {
        let content = match result.and_then(|value| checked(schema, &value)) {
            Ok(value) => json!({"status":"succeeded","value":value}),
            Err(error) => {
                let message = JsString::from(error.to_string().as_str());
                let message = message.trim();
                let message = if message.is_empty() {
                    "The customization operation failed.".into()
                } else {
                    JsString::new(message.units()[..message.units().len().min(2_000)].to_vec())
                };
                json!({"status":"failed","error":json!({"message":message})})
            }
        };
        self.assert_current()?;
        let protected = protect_endpoint_content(
            self.service,
            &self.binding("response"),
            &content,
            "customizationContentResultSchema",
        )?;
        self.assert_current()?;
        checked(
            "protectedCustomizationResponseSchema",
            &json!({
                "operationId":self.id,"operation":self.name,"scope":self.scope,
                "result":content["status"],"lifecycle":Value::Null,"protectedResponse":protected,
            }),
        )
    }
}
