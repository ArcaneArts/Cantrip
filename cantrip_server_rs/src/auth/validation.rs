//! Authentication requests use the same exported protocol as other domains.
//! Keep raw UTF-16 and unbounded JSON trees until validation strips unknowns.
use crate::wire::{self, ValidationError, Value};

pub fn validate(kind: &str, body: Option<&Value>) -> Result<Value, ValidationError> {
    let schema = match kind {
        "register" => "accountRegistrationSchema",
        "login" => "authLoginSchema",
        "reauthenticate" => "authReauthenticationSchema",
        "exchange" => "mobileSignInGrantExchangeSchema",
        _ => return Err(ValidationError::Operation),
    };
    wire::parse(schema, body)
}
