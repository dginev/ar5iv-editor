//! Library half of the ar5iv-editor server. The binary in `main.rs` is a
//! thin wrapper; integration tests build the same router via `router()`.

pub mod archive;
pub mod config;
pub mod convert;
pub mod error;
pub mod examples;
pub mod files;
pub mod quota;
pub mod routes;
pub mod session;
pub mod templates;
pub mod ws;

use std::sync::Arc;

use axum::{
    Router,
    routing::{any, get},
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
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(routes::root_redirect))
        .route("/about", get(routes::about))
        .route("/help", get(routes::help))
        .route("/editor", get(routes::editor))
        .route("/convert", any(ws::ws_handler))
        .merge(files::router())
        .route("/api/version", get(routes::version))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
