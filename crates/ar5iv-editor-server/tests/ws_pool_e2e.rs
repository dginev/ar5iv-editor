//! Heavy (`--ignored`) full-stack check of the warm LSP pool lane:
//! HTTP session + file PUT + real `/convert` WebSocket, with the
//! Converter built over a live engine pool — the exact path the
//! `/editor` and `/vscode` web clients ride.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ar5iv_editor::{
    AppState,
    config::SessionConfig,
    convert::Converter,
    examples::ExampleCatalog,
    lsp_pool::{LspPool, LspPoolConfig, resolve_engine},
    router,
    session::SessionRegistry,
};
use ar5iv_editor_protocol::{ConvertRequest, ConvertResponse};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

fn engine() -> PathBuf {
    if let Some(p) = resolve_engine() {
        return p;
    }
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../latexml-oxide/target/release/latexml_oxide");
    assert!(
        sibling.is_file(),
        "no latexml_oxide engine: set AR5IV_LATEXML_BIN or build the sibling checkout"
    );
    sibling
}

#[tokio::test]
#[ignore] // heavy: real engine children + full router
async fn document_profile_rides_the_warm_pool_over_ws() {
    let sessions_root = TempDir::new().unwrap();
    let session_cfg = SessionConfig {
        sessions_dir: sessions_root.path().to_path_buf(),
        idle_timeout: Duration::from_secs(600),
        gc_interval: Duration::from_secs(60),
        quota_session_bytes: 50 * 1024 * 1024,
        quota_session_files: 200,
        quota_upload_bytes: 10 * 1024 * 1024,
        quota_archive_bytes: 25 * 1024 * 1024,
        quota_root_bytes: 2 * 1024 * 1024 * 1024,
        quota_sessions_per_user: 8,
        quota_users_per_ip: 16,
    };
    let pool = Arc::new(LspPool::new(LspPoolConfig {
        engine: engine(),
        capacity: 2,
        timeout_secs: 120,
        max_memory_mb: 6144,
        idle_reap_secs: 600,
    }));
    let state = AppState {
        converter: Arc::new(Converter::new(2, Some(pool))),
        sessions: Arc::new(SessionRegistry::new(session_cfg)),
        examples: Arc::new(ExampleCatalog::load().expect("examples manifest")),
        vscode_web_dir: Arc::new(std::path::PathBuf::from("vscode-web")),
        vscode_ext_dir: Arc::new(std::path::PathBuf::from("vscode-extension")),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(state);
    let _server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");
    let user: String = client
        .post(format!("{base}/api/user"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["user_id"]
        .as_str()
        .unwrap()
        .into();
    let create: Value = client
        .post(format!("{base}/api/session"))
        .header("x-ar5iv-user", &user)
        .json(&json!({ "slot": "blank" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = create["id"].as_str().unwrap().to_string();

    // A full DOCUMENT (own \documentclass) with an \input sibling and a
    // multi-byte body — the pool lane's bread and butter.
    let put_file = |name: &'static str, body: &'static str| {
        let client = client.clone();
        let base = base.clone();
        let user = user.clone();
        let session_id = session_id.clone();
        async move {
            let r = client
                .put(format!("{base}/api/session/{session_id}/files/{name}"))
                .header("x-ar5iv-user", &user)
                .body(body)
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), 200);
            r.json::<Value>().await.unwrap()["version"]
                .as_u64()
                .unwrap()
        }
    };
    put_file("ch.tex", "chapter — version A with $\\pi$.\n").await;
    let version = put_file(
        "main.tex",
        "\\documentclass{article}\n\\begin{document}\nIntro text.\n\\input{ch}\n\\end{document}\n",
    )
    .await;

    let url = format!("ws://{addr}/convert?session_id={session_id}&user_id={user}");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();

    let convert = |id: u64, version: u64| {
        let req = ConvertRequest {
            id,
            active_file: "main.tex".into(),
            version,
            // The frontend ALWAYS sends a pre-split preamble (for the
            // fragment-wrapping case); document mode ignores it. Gating on
            // it was the second silent-cold routing bug.
            preamble: Some("literal:\\documentclass{article}".into()),
            profile: Some("document".into()),
            format: Some("html5".into()),
            // Byte-for-byte what the frontend sends for \documentclass
            // documents (frontend-core PRELOAD_AR5IV_ONLY) — the engine's
            // own --server default. MUST ride the pool; rejecting it was
            // the live routing bug.
            preload: vec!["ar5iv.sty".into()],
            source: None,
        };
        serde_json::to_string(&req).unwrap()
    };

    // Cold conversion.
    let t0 = Instant::now();
    ws.send(Message::Text(convert(1, version)))
        .await
        .unwrap();
    let cold: ConvertResponse = next_response(&mut ws).await;
    let cold_ms = t0.elapsed().as_millis();
    assert_eq!(cold.status_code, 0, "log: {}", cold.log);
    assert!(cold.result.contains("Intro text"), "root rendered");
    assert!(
        cold.result.contains("version A"),
        "\\input sibling rendered"
    );
    assert!(
        cold.sources.iter().any(|s| s == "ch.tex"),
        "sources decoder carries the sibling: {:?}",
        cold.sources
    );

    // Body edit → warm conversion (sibling content changes on disk).
    put_file("ch.tex", "chapter — version B with $\\pi$.\n").await;
    let t1 = Instant::now();
    ws.send(Message::Text(convert(2, version)))
        .await
        .unwrap();
    let warm: ConvertResponse = next_response(&mut ws).await;
    let warm_ms = t1.elapsed().as_millis();
    assert_eq!(warm.status_code, 0);
    assert!(warm.result.contains("version B"), "fresh sibling content");
    eprintln!("ws cold={cold_ms} ms  warm={warm_ms} ms");
    assert!(
        warm_ms * 2 < cold_ms.max(200),
        "warm WS conversion ({warm_ms} ms) must be far below cold ({cold_ms} ms)"
    );
}

async fn next_response(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ConvertResponse {
    loop {
        match ws.next().await.expect("ws open").expect("ws frame") {
            Message::Text(t) => return serde_json::from_str(&t).expect("ConvertResponse"),
            _ => continue,
        }
    }
}
