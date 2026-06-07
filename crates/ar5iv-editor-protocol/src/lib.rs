//! Wire protocol shared by the ar5iv-editor server and its TypeScript frontend.
//!
//! WebSocket frames are JSON text frames over `/convert?session_id=…`. Each
//! request carries a monotonic `id`; the server echoes that `id` on the
//! corresponding response so the client can correlate (and discard) results.
//! See `docs/FileUI.md` for the full design.

use serde::{Deserialize, Serialize};

/// Build-time information about the latexml-oxide path-dep that's
/// linked into this binary. Surfaced via `GET /api/version` so the
/// frontend can render a "powered by latexml-oxide @<sha>" link in
/// the preview header.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionInfo {
    pub latexml_oxide: LatexmlOxideVersion,
    /// Pin of the `validator` submodule (the Nu validator fork that
    /// supplies the scholarly schema and the vnu validation service)
    /// this build shipped with.
    pub validator: SchemaSourceVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaSourceVersion {
    /// Short SHA of the pinned submodule commit.
    pub sha: String,
    /// Repo URL pointing at the pinned source.
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatexmlOxideVersion {
    /// Short SHA of the commit ar5iv-editor was built against.
    pub sha:  String,
    /// Commit date in YYYY-MM-DD form.
    pub date: String,
    /// Repo URL pointing at the exact tree the binary was built
    /// from. Useful as a click target on the preview-header link.
    pub url:  String,
}

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
    /// Parsed engine messages with location info, so the frontend can
    /// annotate the editor lines in the right buffer (or surface
    /// unanchored ones in a header badge). Empty for clean runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    /// Source-map decoder ring for `--source-map` runs: the file basename for
    /// each integer source `tag` (the array index *is* the tag) carried by the
    /// `data-sourcepos` attributes in `result`. Source-Map-v3 `sources`-style.
    /// Kept out of the HTML so the served preview stays anonymisable; it rides
    /// this envelope so the editor can resolve `active_file` → tag and scroll
    /// the preview to the edited source line. Empty when source-map is off.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
    Fatal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: Severity,
    /// Short label rendered before the message, e.g. `Undefined:\foo`.
    pub category: String,
    pub message:  String,
    /// The source filename the engine attributed the message to. For
    /// literal-source conversions this is `"Anonymous String"`, which
    /// the frontend remaps to the request's `active_file`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source:   Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_col:  Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_line:   Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_col:    Option<u32>,
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
            diagnostics: Vec::new(),
            sources: Vec::new(),
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
            diagnostics: Vec::new(),
            sources: Vec::new(),
        }
    }
}
