//! Window-effect data only. Source capture, effect output, and cursor pixels are separate.
pub mod live;
pub mod source;
pub mod telemetry;
pub mod uniforms;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock, time::Instant};

pub const CONTRACT_VERSION: u32 = 1;
pub const MAX_CURSORS: usize = crate::service::MAX_SESSIONS;
pub const MAX_EVENTS: usize = 64;

/// One process-local monotonic epoch. Nanoseconds never pass through epoch floats.
pub fn now_ns() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH
        .get_or_init(Instant::now)
        .elapsed()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EffectId {
    #[default]
    Off,
    PassThrough,
    DebugGradient,
    CursorWarp,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    #[serde(default)]
    pub effect: EffectId,
    #[serde(default)]
    pub parameters: BTreeMap<String, f32>,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub default: f32,
    pub min: f32,
    pub max: f32,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub id: EffectId,
    pub label: &'static str,
    pub contract_version: u32,
    pub fragment: &'static str,
    pub continuous: bool,
    pub history: bool,
    pub parameters: &'static [Parameter],
}
const DEBUG_PARAMETERS: &[Parameter] = &[
    Parameter {
        id: "strength",
        label: "Inversion strength",
        kind: "float",
        default: 1.0,
        min: 0.0,
        max: 1.0,
    },
    Parameter {
        id: "radius",
        label: "Cursor diagnostic radius",
        kind: "float",
        default: 80.0,
        min: 16.0,
        max: 320.0,
    },
    Parameter {
        id: "showTelemetry",
        label: "Show input diagnostics",
        kind: "boolean",
        default: 1.0,
        min: 0.0,
        max: 1.0,
    },
];
// Order is the fragment parameter ABI: strength, radius, motion, ripple.
const WARP_PARAMETERS: &[Parameter] = &[
    Parameter {
        id: "strength",
        label: "Warp strength",
        kind: "float",
        default: 1.0,
        min: 0.0,
        max: 2.0,
    },
    Parameter {
        id: "radius",
        label: "Warp radius",
        kind: "float",
        default: 110.0,
        min: 32.0,
        max: 320.0,
    },
    Parameter {
        id: "motion",
        label: "Motion response",
        kind: "float",
        default: 1.0,
        min: 0.0,
        max: 2.0,
    },
    Parameter {
        id: "ripple",
        label: "Click ripple",
        kind: "float",
        default: 1.0,
        min: 0.0,
        max: 2.0,
    },
];
pub const DESCRIPTORS: &[Descriptor] = &[
    Descriptor {
        id: EffectId::Off,
        label: "Off",
        contract_version: CONTRACT_VERSION,
        fragment: "",
        continuous: false,
        history: false,
        parameters: &[],
    },
    Descriptor {
        id: EffectId::PassThrough,
        label: "Pass-through",
        contract_version: CONTRACT_VERSION,
        fragment: "cantrip_passthrough",
        continuous: false,
        history: false,
        parameters: &[],
    },
    Descriptor {
        id: EffectId::DebugGradient,
        label: "Debug gradient inversion",
        contract_version: CONTRACT_VERSION,
        fragment: "cantrip_debug_gradient",
        continuous: true,
        history: false,
        parameters: DEBUG_PARAMETERS,
    },
    Descriptor {
        id: EffectId::CursorWarp,
        label: "Cursor warp",
        contract_version: CONTRACT_VERSION,
        fragment: "cantrip_cursor_warp",
        continuous: true,
        history: false,
        parameters: WARP_PARAMETERS,
    },
];
impl Configuration {
    pub fn descriptor(&self) -> &'static Descriptor {
        DESCRIPTORS.iter().find(|d| d.id == self.effect).unwrap()
    }
    pub fn validate(&self) -> crate::error::Result<()> {
        for (key, value) in &self.parameters {
            let Some(parameter) = self.descriptor().parameters.iter().find(|p| p.id == key) else {
                return Err(crate::error::CuaError::invalid(
                    "Unknown window-effect parameter.",
                ));
            };
            if !value.is_finite()
                || *value < parameter.min
                || *value > parameter.max
                || (parameter.kind == "boolean" && *value != 0.0 && *value != 1.0)
            {
                return Err(crate::error::CuaError::invalid(
                    "Window-effect parameter is outside its supported range.",
                ));
            }
        }
        Ok(())
    }
    pub fn value(&self, id: &str) -> f32 {
        self.parameters.get(id).copied().unwrap_or_else(|| {
            self.descriptor()
                .parameters
                .iter()
                .find(|p| p.id == id)
                .map_or(0.0, |p| p.default)
        })
    }
}
