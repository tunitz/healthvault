#![doc = "Streaming Apple Health export importer: zip -> XML rows -> deduplicated batched writes."]

pub mod error;
pub mod importer;
pub mod model;
pub mod normalize;
pub mod parser;

pub use error::IngestError;
pub use importer::{ImportCoordinator, import_file, import_zip_bytes};
pub use model::IngestReport;
pub use parser::HealthParser;
