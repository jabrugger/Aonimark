//! Markpad's Rust backend. `app::run` builds the Tauri app; `commands`,
//! and `window_runtime` hold what the frontend can `invoke`.

mod app;
mod asset_protocol;
mod commands;
mod error;
mod fs_safety;
mod window_runtime;

pub use app::run;
