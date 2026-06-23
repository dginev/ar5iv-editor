//! End-to-end test: upload `fig.png`, render `\includegraphics{fig}`,
//! and confirm the response HTML rewrites the engine's absolute fs
//! path into a `/api/session/{id}/files/...` URL the browser can
//! actually fetch. Targets Phase 2's path-rewrite step.

use ar5iv_editor::{
    AppState, config::SessionConfig, convert::Converter, examples::ExampleCatalog, router,
    session::SessionRegistry,
};
use ar5iv_editor_protocol::{ConvertRequest, ConvertResponse};
use futures_util::{SinkExt, StreamExt};
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

#[tokio::test]
#[ignore = "loads heavy preloads + post-processing; run with --ignored"]
async fn includegraphics_resolves_and_path_is_rewritten() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let temp = TempDir::new().unwrap();
    let cfg = SessionConfig {
        sessions_dir:            temp.path().to_path_buf(),
        idle_timeout:            Duration::from_secs(600),
        gc_interval:             Duration::from_secs(60),
        quota_session_bytes:     50 * 1024 * 1024,
        quota_session_files:     200,
        quota_upload_bytes:      10 * 1024 * 1024,
        quota_archive_bytes:     25 * 1024 * 1024,
        quota_root_bytes:        2 * 1024 * 1024 * 1024,
        quota_sessions_per_user: 8,
        quota_users_per_ip:      16,
    };
    let state = AppState {
        converter: Arc::new(Converter::new(2, None)),
        sessions:  Arc::new(SessionRegistry::new(cfg)),
        examples:  Arc::new(ExampleCatalog::load().expect("examples manifest")),
        vscode_web_dir: Arc::new(std::path::PathBuf::from("vscode-web")),
        vscode_ext_dir: Arc::new(std::path::PathBuf::from("vscode-extension")),
    };
    let app = router(state);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

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
    let sid = create["id"].as_str().unwrap().to_string();

    // Upload fig.png as multipart.
    let form = Form::new().part("f", Part::bytes(TINY_PNG.to_vec()).file_name("fig.png"));
    let upload = client
        .post(format!("{base}/api/session/{sid}/upload"))
        .header("x-ar5iv-user", &user)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 200);

    // Replace main.tex with a single \includegraphics call.
    let main_put: Value = client
        .put(format!("{base}/api/session/{sid}/files/main.tex"))
        .header("x-ar5iv-user", &user)
        .body(r"\includegraphics[width=2cm]{fig}".to_string())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let v = main_put["version"].as_u64().unwrap();

    // Convert through the session-bound WS.
    let url = format!("ws://{addr}/convert?session_id={sid}&user_id={user}");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let req = ConvertRequest {
        id:          1,
        active_file: "main.tex".into(),
        version:     v,
        preamble:    None,
        profile:     Some("fragment".into()),
        format:      Some("html5".into()),
        preload:     vec!["graphicx.sty".into()],
        source:      None,
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();
    let text = loop {
        match ws.next().await.expect("ws closed").unwrap() {
            Message::Text(t) => break t,
            _ => continue,
        }
    };
    let resp: ConvertResponse = serde_json::from_str(&text).unwrap();
    assert_eq!(resp.status_code, 0, "status={:?} log={}", resp.status, resp.log);

    let html = &resp.result;
    let expected_url = format!("/api/session/{sid}/files/fig.png");
    assert!(
        html.contains(&expected_url),
        "expected `{expected_url}` in HTML; got: {html}"
    );
    // The session's tmpdir prefix (absolute fs path) must NOT leak.
    let leak = temp.path().to_string_lossy().to_string();
    assert!(
        !html.contains(&leak),
        "absolute session path leaked into HTML: {html}"
    );

    server.abort();
}
