pub mod kunde;
pub mod validation;

pub use kunde::Kunde;
pub use validation::{require_api_ids, validate_kunde, ValidationResult};
