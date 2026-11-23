//! Existing Codex checkpoint resource protection. The worker chooses the
//! component and supplies the authenticated owner, server, and principal.
use super::{aad, authenticate, open_field, revision, seal_field};
use crate::checked;
use anyhow::{Result, bail};
use cantrip_wire::{Value, parse_json_text, payload_digest, value::json};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NativeResourceComponent {
    Chat,
    Task,
}

impl NativeResourceComponent {
    pub fn name(self) -> &'static str {
        match self {
            Self::Chat => "chat-content",
            Self::Task => "task-content",
        }
    }

    pub fn envelope(self, value: &Value) -> Result<Value> {
        let valid = value.as_object().is_some_and(|fields| match self {
            Self::Chat => fields.len() == 2 && value["formatVersion"] == 1,
            Self::Task => {
                fields.len() == 3
                    && value["formatVersion"] == 2
                    && value["component"] == self.name()
            }
        });
        if !valid {
            bail!("Native resource protection belongs to another component or format.");
        }
        checked("encryptedPayloadEnvelopeSchema", &value["envelope"])
    }
}

#[derive(Clone, Copy)]
enum Domain {
    Resources,
    SuspensionSource,
}

impl Domain {
    fn associated(
        self,
        context: &Value,
        component: NativeResourceComponent,
        binding: &Value,
    ) -> Result<Value> {
        let (label, table) = match self {
            Self::Resources => ("cantrip-native-turn-resources", "native_turn_resources"),
            Self::SuspensionSource => (
                "cantrip-native-suspension-source",
                "native_turn_suspension_sources",
            ),
        };
        let row = payload_digest(&json!([
            json!(label),
            json!(1),
            context["serverId"].clone(),
            context["principalId"].clone(),
            binding["threadId"].clone(),
            binding["turnId"].clone(),
            binding["checkpointId"].clone(),
        ]));
        aad(
            context,
            &json!(component.name()),
            &json!(table),
            &json!(row),
            &json!("payload"),
        )
    }

    fn seal(
        self,
        key: &[u8],
        context: &Value,
        component: NativeResourceComponent,
        binding: &Value,
        value: &Value,
    ) -> Result<Value> {
        let associated = self.associated(context, component, binding)?;
        let bytes = Zeroizing::new(value.stringify().into_bytes());
        let envelope = seal_field(key, &associated, &bytes)?;
        Ok(match component {
            NativeResourceComponent::Chat => json!({"formatVersion":1,"envelope":envelope}),
            NativeResourceComponent::Task => {
                json!({"formatVersion":2,"component":component.name(),"envelope":envelope})
            }
        })
    }

    fn open(
        self,
        key: &[u8],
        context: &Value,
        component: NativeResourceComponent,
        binding: &Value,
        value: &Value,
    ) -> Result<Value> {
        let associated = self.associated(context, component, binding)?;
        let envelope = component.envelope(value)?;
        revision(&envelope, context)?;
        let plaintext = open_field(key, &associated, &envelope)?;
        authenticate(|| {
            let text = std::str::from_utf8(&plaintext)?;
            parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(text))
                .map_err(|_| crate::decryption_error())
        })
    }
}

pub fn seal_native_resources(
    key: &[u8],
    context: &Value,
    component: NativeResourceComponent,
    binding: &Value,
    value: &Value,
) -> Result<Value> {
    Domain::Resources.seal(key, context, component, binding, value)
}

pub fn open_native_resources(
    key: &[u8],
    context: &Value,
    component: NativeResourceComponent,
    binding: &Value,
    value: &Value,
) -> Result<Value> {
    Domain::Resources.open(key, context, component, binding, value)
}

pub fn seal_native_suspension_source(
    key: &[u8],
    context: &Value,
    component: NativeResourceComponent,
    binding: &Value,
    value: &Value,
) -> Result<Value> {
    Domain::SuspensionSource.seal(key, context, component, binding, value)
}

pub fn open_native_suspension_source(
    key: &[u8],
    context: &Value,
    component: NativeResourceComponent,
    binding: &Value,
    value: &Value,
) -> Result<Value> {
    Domain::SuspensionSource.open(key, context, component, binding, value)
}
