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
        vscode_web_dir: Arc::new(cfg.vscode_web_dir.clone()),
        vscode_ext_dir: Arc::new(cfg.vscode_ext_dir.clone()),
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
    // VS Code for the Web: the vendored standalone build (served at
    // /vscode-static and bootstrapped by the /vscode route) plus the ar5iv
    // extension root (served at /vscode-ext, loaded as a built-in). Both 404
    // gracefully when not present — /vscode then shows the launcher page.
    let vscode_web_service = ServeDir::new(&cfg.vscode_web_dir);
    let vscode_ext_service = ServeDir::new(&cfg.vscode_ext_dir);
    let app = router(state.clone())
        .nest_service("/schemas/latexml",     latexml_docs)
        .nest_service("/schemas/scholarly",   scholarly_docs)
        .nest_service("/schemas/mathml-core", mathml_core_docs)
        .nest_service("/static", static_service)
        .nest_service("/vscode-static", vscode_web_service)
        .nest_service("/vscode-ext", vscode_ext_service)
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-cache"),
        ))
        // Cross-origin isolation for VS Code for the Web. Its extension-host
        // worker needs `crossOriginIsolated`, so VS Code reloads requests with
        // `?vscode-coi=…`; we answer with COOP/COEP and tag every resource with
        // `Cross-Origin-Resource-Policy: cross-origin` so it stays embeddable.
        // Mirrors `@vscode/test-web`. Harmless for the other routes (COOP/COEP
        // are only emitted when the query opts in).
        .layer(axum::middleware::from_fn(cross_origin_isolation));

    let listener = tokio::net::TcpListener::bind(cfg.bind)
        .await
        .with_context(|| format!("binding {}", cfg.bind))?;
    info!(addr = %cfg.bind, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Cross-origin isolation headers for VS Code for the Web (see the `/vscode`
/// route). VS Code appends `?vscode-coi=1|2|3` (or empty) to requests that must
/// be isolated; we answer with the matching `Cross-Origin-Opener-Policy` /
/// `Cross-Origin-Embedder-Policy`, and always set
/// `Cross-Origin-Resource-Policy: cross-origin` so resources stay embeddable
/// under COEP. Mirrors `@vscode/test-web`'s `app.js`.
async fn cross_origin_isolation(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{HeaderValue, Method, StatusCode, header};
    let coi = request.uri().query().and_then(coi_flag);
    // The workbench document must be cross-origin isolated from its first load
    // (the extension-host worker needs `crossOriginIsolated`); VS Code does not
    // append `?vscode-coi` to the top navigation, so force it here. Resource
    // requests opt in via the query (set by VS Code's service worker).
    let is_workbench_doc = request.uri().path() == "/vscode";
    let is_preflight = request.method() == Method::OPTIONS;
    // CORS: VS Code Web runs webviews and the extension host on per-webview
    // subdomains (`v--<hash>.<host>`), which reach the main origin cross-origin
    // — both for static modules (the host worker) and the ar5iv API (sessions,
    // file PUTs, conversion). Reflect the Origin with credentials for our own
    // subdomains + the vscode cdn/webview origins, and answer preflights;
    // otherwise the host worker can't load and conversions can't run.
    let request_host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let allow_origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| cors_origin_allowed(origin, request_host.as_deref()))
        .map(str::to_string);
    let requested_headers = request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    // Short-circuit CORS preflight so the API's non-GET routes (which don't
    // handle OPTIONS) don't 405 it.
    if is_preflight && allow_origin.is_some() {
        let mut response = axum::http::Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(axum::body::Body::empty())
            .expect("empty preflight response");
        apply_cors(response.headers_mut(), allow_origin.as_deref(), requested_headers.as_deref());
        return response;
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    apply_cors(headers, allow_origin.as_deref(), requested_headers.as_deref());
    let (coop, coep) = match coi.as_deref() {
        Some("1") => (true, false),
        Some("2") => (false, true),
        Some("3") | Some("") => (true, true),
        _ => (is_workbench_doc, is_workbench_doc),
    };
    if coop {
        headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    }
    if coep {
        headers.insert("cross-origin-embedder-policy", HeaderValue::from_static("require-corp"));
    }
    response
}

/// Apply the shared CORS + resource-policy headers: always `CORP: cross-origin`
/// (so resources stay embeddable under COEP), and — when the Origin is allowed —
/// reflect it with credentials and the methods/headers the ar5iv API uses.
fn apply_cors(
    headers: &mut axum::http::HeaderMap,
    allow_origin: Option<&str>,
    requested_headers: Option<&str>,
) {
    use axum::http::{HeaderValue, header};
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("cross-origin"));
    let Some(origin) = allow_origin else { return };
    let Ok(origin_value) = HeaderValue::from_str(origin) else { return };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin_value);
    headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"));
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    let allow_headers = requested_headers
        .and_then(|value| HeaderValue::from_str(value).ok())
        .unwrap_or_else(|| HeaderValue::from_static("content-type, x-ar5iv-user"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, allow_headers);
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

/// True when `origin` should be CORS-reflected: a single-label subdomain of the
/// request `host` (the per-webview `v--<hash>.<host>` origins), or a VS Code
/// CDN/webview origin. Mirrors `@vscode/test-web`'s CORS origin check.
fn cors_origin_allowed(origin: &str, host: Option<&str>) -> bool {
    let after_scheme = match origin.split_once("://") {
        Some((_, rest)) => rest,
        None => return false,
    };
    if after_scheme.ends_with(".vscode-cdn.net") || after_scheme.ends_with(".vscode-webview.net") {
        return true;
    }
    match host {
        Some(host) => match after_scheme.strip_suffix(host).and_then(|label| label.strip_suffix('.')) {
            Some(label) => !label.is_empty() && !label.contains('.'),
            None => false,
        },
        None => false,
    }
}

/// The value of the `vscode-coi` query parameter, or `None` when absent. A bare
/// `vscode-coi` (no `=`) yields `Some("")` (both COOP+COEP), matching VS Code.
fn coi_flag(query: &str) -> Option<String> {
    for part in query.split('&') {
        if part == "vscode-coi" {
            return Some(String::new());
        }
        if let Some(value) = part.strip_prefix("vscode-coi=") {
            return Some(value.to_string());
        }
    }
    None
}
