//! Library half of the ar5iv-editor server. The binary in `main.rs` is a
//! thin wrapper; integration tests build the same router via `router()`.

pub mod archive;
pub mod config;
pub mod convert;
pub mod error;
pub mod examples;
pub mod files;
pub mod lsp_pool;
pub mod quota;
pub mod routes;
pub mod session;
pub mod templates;
pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{any, get, post},
};
use tower_http::trace::TraceLayer;

use crate::convert::Converter;
use crate::examples::ExampleCatalog;
use crate::session::SessionRegistry;

#[derive(Clone)]
pub struct AppState {
    pub converter: Arc<Converter>,
    pub sessions:  Arc<SessionRegistry>,
    pub examples:  Arc<ExampleCatalog>,
    /// Vendored VS Code Web build root, used by the `/vscode` workbench route to
    /// locate the bootstrap HTML. See [`config::Config::vscode_web_dir`].
    pub vscode_web_dir: Arc<PathBuf>,
    /// ar5iv extension root, loaded into the web workbench as a built-in.
    pub vscode_ext_dir: Arc<PathBuf>,
}

pub fn router(state: AppState) -> Router {
    // Axum buffers `Bytes` bodies under a 2 MB default limit, which trips
    // *before* our own quota checks on the archive/upload routes — a
    // 3 MB ZIP would fail with "Failed to buffer the request body: length
    // limit exceeded" long before the 25 MB archive cap. Raise the limit
    // to cover the largest legitimate single request (a multipart folder
    // upload bounded by the session cap, or an archive bounded by the
    // archive cap), plus headroom for multipart framing. The per-route
    // quota checks still enforce the tighter, friendlier limits.
    let body_limit = {
        let cfg = state.sessions.config();
        cfg.quota_session_bytes
            .max(cfg.quota_archive_bytes)
            .saturating_add(4 * 1024 * 1024) as usize
    };
    Router::new()
        .route("/", get(routes::root_redirect))
        .route("/about", get(routes::about))
        .route("/schemas", get(routes::schemas))
        .route("/help", get(routes::help))
        .route("/editor", get(routes::editor))
        .route("/upload", get(routes::upload))
        .route("/validate", get(routes::validate_page))
        .route("/vscode", get(routes::vscode))
        .route("/convert", any(ws::ws_handler))
        .merge(files::router())
        .route("/api/version", get(routes::version))
        // Validation accepts whole rendered documents; book-sized
        // LaTeXML HTML runs well past axum's 2 MB default. The
        // route-level limit overrides the global upload-sized layer
        // below (innermost DefaultBodyLimit wins), keeping the public
        // validation surface tighter than the session-quota bound.
        // Layer order (outer to inner): gzip request decompression
        // first, then the 35 MB cap — so the cap governs the
        // *decompressed* document and a compressed bomb can't sneak
        // past it. Clients may send `Content-Encoding: gzip` to save
        // bandwidth on book-sized uploads.
        .route(
            "/api/validate",
            post(routes::validate)
                // Turbofish: chaining a second `.layer` leaves the
                // intermediate `NewError` parameter unconstrained.
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(35 * 1024 * 1024))
                .layer(tower_http::decompression::RequestDecompressionLayer::new()),
        )
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
