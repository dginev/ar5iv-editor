use std::sync::Arc;

use anyhow::Context;
use ar5iv_editor::{
    AppState, config::Config, convert::Converter, examples::ExampleCatalog, router,
    session::SessionRegistry,
};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
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

    // Make sure the sessions root exists before any handler tries to
    // create a tmpdir under it. Failure here is fatal — without a
    // sessions root the file routes are broken from the first request.
    tokio::fs::create_dir_all(&cfg.session.sessions_dir)
        .await
        .with_context(|| format!("creating sessions root {}", cfg.session.sessions_dir.display()))?;

    let sessions = Arc::new(SessionRegistry::new(cfg.session.clone()));
    // A previous run may have left dirs behind under the sessions
    // root; the registry is empty at this point so every on-disk dir
    // counts as an orphan and the sweep deletes anything stale by
    // mtime (with a length+alphabet shape filter so we don't touch
    // hand-placed admin files). See `SessionRegistry::sweep_orphans`.
    sessions.sweep_orphans().await;
    let _gc = sessions.spawn_gc();

    let examples = Arc::new(ExampleCatalog::load().context("loading examples manifest")?);

    let state = AppState {
        converter: Arc::new(Converter::new(cfg.max_in_flight)),
        sessions,
        examples,
    };

    // The library default uses `frontend/dist`; if the user pointed elsewhere
    // via env, layer a fresh ServeDir on top. The `Cache-Control: no-cache`
    // header forces the browser to revalidate `main.js` / `style.css` etc.
    // against the server every load — without it Chrome's heuristic cache
    // can pin an old `main.js` long enough that a `cargo run` cycle ships
    // new server behavior while the browser is still running last week's
    // bundle. `no-cache` (revalidate, not "no-store") still allows 304s
    // when nothing changed, so warm reloads stay cheap.
    let static_service = ServeDir::new(&cfg.static_dir);
    // Per-schema doc subtrees, mounted under /schemas/<slug>/. The
    // /schemas bare path is owned by the index handler in `router()`;
    // `nest_service` strips its prefix before passing to ServeDir, so
    // /schemas/scholarly/Ch1/index.html resolves against
    // <schema_docs_dir>/scholarly/Ch1/index.html. If the directory is
    // missing (dev / first-run before generation) ServeDir 404s; the
    // index page still renders with dead links — visible breakage,
    // not a server crash.
    let schemas_root = &cfg.schema_docs_dir;
    let latexml_docs    = ServeDir::new(schemas_root.join("latexml"));
    let scholarly_docs  = ServeDir::new(schemas_root.join("scholarly"));
    let mathml_core_docs = ServeDir::new(schemas_root.join("mathml-core"));
    let app = router(state.clone())
        .nest_service("/schemas/latexml",     latexml_docs)
        .nest_service("/schemas/scholarly",   scholarly_docs)
        .nest_service("/schemas/mathml-core", mathml_core_docs)
        .nest_service("/static", static_service)
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-cache"),
        ));

    let listener = tokio::net::TcpListener::bind(cfg.bind)
        .await
        .with_context(|| format!("binding {}", cfg.bind))?;
    info!(addr = %cfg.bind, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
