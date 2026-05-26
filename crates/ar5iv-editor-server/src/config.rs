use std::{net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub max_in_flight: usize,
    pub static_dir: PathBuf,
    /// Root of the per-schema documentation tree generated at image-
    /// build time. Expected layout:
    /// `<schema_docs_dir>/{latexml,scholarly,mathml-core}/index.html`.
    /// In dev (no docs generated yet) the directory may be missing —
    /// `ServeDir` returns 404 for the sub-paths and the index page
    /// links are dead but reachable.
    pub schema_docs_dir: PathBuf,
    /// Vendored VS Code Web "web-standalone" build, served at /vscode-static and
    /// bootstrapped by the /vscode workbench route. Populated by
    /// `vscode-extension/scripts/fetch-vscode-web.mjs`. When the directory is
    /// absent, /vscode falls back to a launcher/status page.
    pub vscode_web_dir: PathBuf,
    /// The ar5iv VS Code extension root, served at /vscode-ext and loaded into
    /// the web workbench as an `additionalBuiltinExtension` (its `browser` main
    /// + bundled `media/`).
    pub vscode_ext_dir: PathBuf,
    pub session: SessionConfig,
}

/// Tunables for the session registry, file routes, and the GC loop.
/// All fields configurable via env vars; sensible defaults for dev.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub sessions_dir:               PathBuf,
    pub idle_timeout:               Duration,
    pub gc_interval:                Duration,
    pub quota_session_bytes:        u64,
    pub quota_session_files:        u32,
    pub quota_upload_bytes:         u64,
    pub quota_archive_bytes:        u64,
    pub quota_root_bytes:           u64,
    pub quota_sessions_per_user:    usize,
    pub quota_users_per_ip:         usize,
}

impl SessionConfig {
    fn load_from_env() -> anyhow::Result<Self> {
        Ok(Self {
            sessions_dir: std::env::var("AR5IV_EDITOR_SESSIONS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir().join("ar5iv-editor-sessions")),
            idle_timeout: env_secs("AR5IV_EDITOR_SESSION_IDLE_SECS", 600)?, // 10 min
            gc_interval:  env_secs("AR5IV_EDITOR_GC_INTERVAL_SECS", 30)?,
            quota_session_bytes: env_u64(
                "AR5IV_EDITOR_QUOTA_SESSION_BYTES",
                50 * 1024 * 1024,
            )?,
            quota_session_files: env_u32("AR5IV_EDITOR_QUOTA_SESSION_FILES", 200)?,
            quota_upload_bytes:  env_u64(
                "AR5IV_EDITOR_QUOTA_UPLOAD_BYTES",
                10 * 1024 * 1024,
            )?,
            quota_archive_bytes: env_u64(
                "AR5IV_EDITOR_QUOTA_ARCHIVE_BYTES",
                25 * 1024 * 1024,
            )?,
            quota_root_bytes: env_u64(
                "AR5IV_EDITOR_QUOTA_ROOT_BYTES",
                2 * 1024 * 1024 * 1024,
            )?,
            quota_sessions_per_user: env_usize("AR5IV_EDITOR_QUOTA_PER_USER", 8)?,
            quota_users_per_ip:      env_usize("AR5IV_EDITOR_QUOTA_PER_IP", 16)?,
        })
    }
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let bind = std::env::var("AR5IV_EDITOR_BIND")
            .ok()
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or_else(|| "127.0.0.1:3000".parse().expect("static default"));
        let max_in_flight = std::env::var("AR5IV_EDITOR_MAX_IN_FLIGHT")
            .ok()
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or_else(num_cpus::get);
        let static_dir = std::env::var("AR5IV_EDITOR_STATIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("frontend/dist"));
        let schema_docs_dir = std::env::var("AR5IV_EDITOR_SCHEMA_DOCS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("schema-docs"));
        let vscode_web_dir = std::env::var("AR5IV_VSCODE_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("vscode-web"));
        let vscode_ext_dir = std::env::var("AR5IV_VSCODE_EXT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("vscode-extension"));
        let session = SessionConfig::load_from_env()?;
        Ok(Self {
            bind,
            max_in_flight,
            static_dir,
            schema_docs_dir,
            vscode_web_dir,
            vscode_ext_dir,
            session,
        })
    }
}

fn env_u64(key: &str, default: u64) -> anyhow::Result<u64> {
    Ok(std::env::var(key).ok().map(|s| s.parse()).transpose()?.unwrap_or(default))
}
fn env_u32(key: &str, default: u32) -> anyhow::Result<u32> {
    Ok(std::env::var(key).ok().map(|s| s.parse()).transpose()?.unwrap_or(default))
}
fn env_usize(key: &str, default: usize) -> anyhow::Result<usize> {
    Ok(std::env::var(key).ok().map(|s| s.parse()).transpose()?.unwrap_or(default))
}
fn env_secs(key: &str, default: u64) -> anyhow::Result<Duration> {
    let s = std::env::var(key).ok().map(|v| v.parse()).transpose()?.unwrap_or(default);
    Ok(Duration::from_secs(s))
}
