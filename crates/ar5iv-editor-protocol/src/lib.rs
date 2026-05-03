//! Wire protocol shared by the ar5iv-editor server and its TypeScript frontend.
//!
//! WebSocket frames are JSON text frames over `/convert?session_id=…`. Each
//! request carries a monotonic `id`; the server echoes that `id` on the
//! corresponding response so the client can correlate (and discard) results.
//! See `docs/FileUI.md` for the full design.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertRequest {
    pub id: u64,
    /// The file to convert, relative to the session directory. The
    /// engine reads this from disk; the client is responsible for
    /// having PUT the active buffer to that path before sending the
    /// convert frame.
    pub active_file: String,
    /// The session's `version` counter at the moment of the convert
    /// request. The server echoes it back; the client uses it to
    /// discard responses that race a still-pending write. Optional on
    /// the wire so the client can omit it before any write has
    /// landed; treat absent as `0`.
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub preamble: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub preload: Vec<String>,
}

/// Server-side timing breakdown for one conversion. `build_us` is in
/// microseconds (sub-millisecond on warm runs); the rest are milliseconds.
/// Absent on `superseded` / fatal responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timings {
    pub build_us: u64,
    pub convert_ms: u64,
    pub post_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertResponse {
    pub id: u64,
    pub result: String,
    pub status: String,
    pub status_code: i32,
    /// Echo of the request's `version`. Always present; defaults to 0
    /// for synthetic responses (`fatal`, `superseded`) where no engine
    /// run actually occurred.
    #[serde(default)]
    pub version: u64,
    pub log: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings: Option<Timings>,
}

impl ConvertResponse {
    pub fn fatal(id: u64, message: impl Into<String>) -> Self {
        let msg = message.into();
        Self {
            id,
            result: String::new(),
            status: msg.clone(),
            status_code: 3,
            version: 0,
            log: msg,
            timings: None,
        }
    }

    /// `status_code: 4` — the session backing this WebSocket has been
    /// GC'd or never existed. The frontend treats this as "reopen the
    /// current slot."
    pub fn session_expired(id: u64) -> Self {
        Self {
            id,
            result: String::new(),
            status: "session_expired".into(),
            status_code: 4,
            version: 0,
            log: String::new(),
            timings: None,
        }
    }
}
