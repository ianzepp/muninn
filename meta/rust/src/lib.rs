//! Umbrella facade crate for the Muninn core family.
//!
//! This crate re-exports the core crates behind feature flags so downstream
//! clients can depend on one package or select the lower-level crates directly.

#[cfg(feature = "frames")]
pub use muninn_frames as frames;

#[cfg(feature = "kernel")]
pub use muninn_kernel as kernel;

#[cfg(feature = "llm")]
pub use muninn_llm as llm;

#[cfg(feature = "bridge")]
pub use muninn_bridge as bridge;
