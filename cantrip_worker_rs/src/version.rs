use cantrip_wire::{Value, parse_json_text};
use std::sync::OnceLock;
pub fn value() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        parse_json_text(include_str!(concat!(env!("OUT_DIR"), "/version.json")))
            .expect("generated worker build version")
    })
}
