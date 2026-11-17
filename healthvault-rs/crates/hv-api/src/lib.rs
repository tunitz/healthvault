#![doc = "Shared command/query layer: auth policy, the frozen 38-tool contract and service handlers."]

pub mod auth;
pub mod dispatch;
pub mod error;
pub mod history;
pub mod service;
pub mod tools;
pub mod workflows;

pub use dispatch::{discovery, dispatch};
pub use error::ApiError;
pub use service::Service;
