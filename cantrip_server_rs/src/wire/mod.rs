//! Compatibility facade for the shared native protocol implementation.
pub use cantrip_protocol::{JsString, ValidationError, Value, parse, parse_json_text, value};
pub(crate) use cantrip_protocol::{
    coercion, date_iso_milliseconds, date_milliseconds, live, parse_property, property,
    workspace_discovery,
};
pub(crate) use cantrip_wire::date::{
    utc_fields as date_utc_fields, utc_milliseconds as date_utc_milliseconds,
};
