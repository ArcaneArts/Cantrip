//! JavaScript JSON values retain UTF-16 code units, including lone surrogates,
//! and IEEE-754 numbers. Conversion to PostgreSQL text is explicitly lossy;
//! JSON serialization preserves the original code units and ECMAScript order.
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, Visitor},
};
use std::{
    fmt,
    hash::{Hash, Hasher},
    ops::{Index, IndexMut},
    sync::Arc,
};

mod operations;
mod parser;

pub type Object = indexmap::IndexMap<JsString, Value>;

#[derive(Clone, Eq, PartialEq)]
pub struct JsString {
    units: Arc<[u16]>,
    utf8: Option<Arc<str>>,
}
impl JsString {
    pub fn new(units: Vec<u16>) -> Self {
        let utf8 = String::from_utf16(&units).ok().map(Arc::from);
        Self {
            units: units.into(),
            utf8,
        }
    }
    pub fn units(&self) -> &[u16] {
        &self.units
    }
    pub fn as_str(&self) -> Option<&str> {
        self.utf8.as_deref()
    }
    pub fn lossy(&self) -> std::borrow::Cow<'_, str> {
        match self.as_str() {
            Some(value) => value.into(),
            None => String::from_utf16_lossy(&self.units).into(),
        }
    }
    pub fn len(&self) -> usize {
        self.units.len()
    }
    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }
    pub fn trim(&self) -> Self {
        let whitespace =
            |unit: u16| char::from_u32(u32::from(unit)).is_some_and(crate::text::whitespace);
        let start = self
            .units
            .iter()
            .position(|u| !whitespace(*u))
            .unwrap_or(self.units.len());
        let end = self
            .units
            .iter()
            .rposition(|u| !whitespace(*u))
            .map_or(start, |end| end + 1);
        Self::new(self.units[start..end].to_vec())
    }
    pub fn join_quoted(prefix: &str, keys: &[&JsString]) -> Self {
        let mut units: Vec<_> = prefix.encode_utf16().collect();
        for (i, key) in keys.iter().enumerate() {
            if i > 0 {
                units.extend(", ".encode_utf16());
            }
            units.push(34);
            units.extend(key.units.iter().copied());
            units.push(34);
        }
        Self::new(units)
    }
    fn write_json(&self, output: &mut String) {
        output.push('"');
        let mut at = 0;
        while at < self.units.len() {
            let unit = self.units[at];
            at += 1;
            match unit {
                34 => output.push_str("\\\""),
                92 => output.push_str("\\\\"),
                8 => output.push_str("\\b"),
                9 => output.push_str("\\t"),
                10 => output.push_str("\\n"),
                12 => output.push_str("\\f"),
                13 => output.push_str("\\r"),
                0..=31 => output.push_str(&format!("\\u{unit:04x}")),
                0xd800..=0xdbff
                    if self
                        .units
                        .get(at)
                        .is_some_and(|u| (0xdc00..=0xdfff).contains(u)) =>
                {
                    let low = self.units[at];
                    at += 1;
                    let scalar =
                        0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                    output.push(char::from_u32(scalar).unwrap());
                }
                0xd800..=0xdfff => output.push_str(&format!("\\u{unit:04x}")),
                _ => output.push(char::from_u32(u32::from(unit)).unwrap()),
            }
        }
        output.push('"');
    }
}
impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self {
            units: value.encode_utf16().collect::<Vec<_>>().into(),
            utf8: Some(Arc::from(value)),
        }
    }
}
impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}
impl Hash for JsString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match self.as_str() {
            Some(s) => s.hash(state),
            None => self.units.hash(state),
        }
    }
}
impl indexmap::Equivalent<JsString> for str {
    fn equivalent(&self, key: &JsString) -> bool {
        key.as_str() == Some(self)
    }
}
impl indexmap::Equivalent<JsString> for String {
    fn equivalent(&self, key: &JsString) -> bool {
        key.as_str() == Some(self.as_str())
    }
}
impl fmt::Debug for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut s = String::new();
        self.write_json(&mut s);
        f.write_str(&s)
    }
}
impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.lossy())
    }
}
impl Serialize for JsString {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = String::new();
        self.write_json(&mut s);
        serde_json::value::RawValue::from_string(s)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for JsString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Wtf8;
        impl Visitor<'_> for Wtf8 {
            type Value = JsString;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON string")
            }
            fn visit_bytes<E: de::Error>(self, bytes: &[u8]) -> Result<JsString, E> {
                let mut units = Vec::new();
                let mut at = 0;
                while at < bytes.len() {
                    let first = bytes[at];
                    let width = if first < 0x80 {
                        1
                    } else if first < 0xe0 {
                        2
                    } else if first < 0xf0 {
                        3
                    } else {
                        4
                    };
                    let slice = bytes
                        .get(at..at + width)
                        .ok_or_else(|| E::custom("invalid WTF-8 string"))?;
                    let mut scalar = u32::from(
                        first
                            & match width {
                                1 => 0x7f,
                                2 => 0x1f,
                                3 => 0x0f,
                                _ => 7,
                            },
                    );
                    for byte in &slice[1..] {
                        scalar = (scalar << 6) | u32::from(byte & 63);
                    }
                    at += width;
                    if scalar <= 0xffff {
                        units.push(scalar as u16);
                    } else {
                        let value = scalar - 0x10000;
                        units.push((0xd800 + (value >> 10)) as u16);
                        units.push((0xdc00 + (value & 1023)) as u16);
                    }
                }
                Ok(JsString::new(units))
            }
        }
        deserializer.deserialize_bytes(Wtf8)
    }
}

#[derive(Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<Value>),
    Object(Object),
}
impl Value {
    pub fn object<K: Into<JsString>>(pairs: impl IntoIterator<Item = (K, Value)>) -> Self {
        Self::Object(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }
    pub fn from_serialize<T: Serialize + ?Sized>(value: &T) -> Self {
        serde_json::from_str(&serde_json::to_string(value).expect("protocol JSON serialization"))
            .expect("protocol JSON value")
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub fn is_number(&self) -> bool {
        matches!(self, Self::Number(_))
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn as_str(&self) -> Option<&str> {
        self.as_js_string().and_then(JsString::as_str)
    }
    pub fn as_js_string(&self) -> Option<&JsString> {
        if let Self::String(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(v) = self {
            Some(*v)
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        if let Self::Array(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_object(&self) -> Option<&Object> {
        if let Self::Object(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Self::Number(v) = self {
            Some(*v)
        } else {
            None
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        self.as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= i64::MIN as f64 && *n < 9223372036854775808.0)
            .map(|n| n as i64)
    }
    pub fn as_u64(&self) -> Option<u64> {
        self.as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n < 18446744073709551616.0)
            .map(|n| n as u64)
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object().and_then(|o| o.get(key))
    }
}
impl Index<&str> for Value {
    type Output = Value;
    fn index(&self, key: &str) -> &Value {
        static NULL: Value = Value::Null;
        self.get(key).unwrap_or(&NULL)
    }
}
impl IndexMut<&str> for Value {
    fn index_mut(&mut self, key: &str) -> &mut Value {
        if self.is_null() {
            *self = Self::Object(Object::new())
        }
        match self {
            Self::Object(object) => object.entry(key.into()).or_default(),
            _ => panic!("JSON value is not an object"),
        }
    }
}
impl PartialEq<&str> for Value {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == Some(*other)
    }
}
impl PartialEq<str> for Value {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == Some(other)
    }
}
impl PartialEq<String> for Value {
    fn eq(&self, other: &String) -> bool {
        self.as_str() == Some(other)
    }
}
impl PartialEq<bool> for Value {
    fn eq(&self, other: &bool) -> bool {
        self.as_bool() == Some(*other)
    }
}
impl PartialEq<i32> for Value {
    fn eq(&self, other: &i32) -> bool {
        self.as_f64() == Some(f64::from(*other))
    }
}
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.stringify())
    }
}
impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde_json::value::RawValue::from_string(self.stringify())
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        parser::parse(raw.get()).map_err(de::Error::custom)
    }
}

// Object values are serialized directly (rather than through serde_json::Value)
// so raw UTF-16 strings remain representable while constructing error objects.
macro_rules! json{
    (null)=>{$crate::wire::Value::Null};
    ({$($key:literal:$value:expr),*$(,)?})=>{{let mut object=$crate::wire::value::Object::new();$(object.insert($key.into(),$crate::wire::Value::from_serialize(&$value));)*$crate::wire::Value::Object(object)}};
    ($value:expr)=>{$crate::wire::Value::from_serialize(&$value)};
}
pub(crate) use json;
