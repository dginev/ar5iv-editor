use std::sync::Arc;

use anyhow::Context;
use ar5iv_editor::{AppState, config::Config, convert::Converter, router};
use tower_http::services::ServeDir;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Install latexml-oxide's logger FIRST, before tracing-subscriber, so it
    // owns the global `log` slot. That logger is the one that captures into
    // the per-request LOG_BUFFER consumed by `bind_log` / `flush_log`; if
    // anything else (e.g. tracing-log) takes the slot first, every per-
    // request log toggle in the UI would show empty content.
    if let Err(e) = latexml_core::util::logger::init(log::LevelFilter::Info) {
        eprintln!("warning: latexml-oxide logger init failed: {e}");
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,ar5iv_editor=debug".into()),
        )
        .init();

    let cfg = Config::load()?;
    info!(?cfg, "starting ar5iv-editor");

    let state = AppState {
        converter: Arc::new(Converter::new(cfg.max_in_flight)),
    };

    // The library default uses `frontend/dist`; if the user pointed elsewhere
    // via env, layer a fresh ServeDir on top.
    let app = router(state.clone()).nest_service("/static", ServeDir::new(&cfg.static_dir));

    let listener = tokio::net::TcpListener::bind(cfg.bind)
        .await
        .with_context(|| format!("binding {}", cfg.bind))?;
    info!(addr = %cfg.bind, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
