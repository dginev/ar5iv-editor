//! End-to-end test: boot the server, mint a user, create a session,
//! PUT `main.tex`, open a WebSocket bound to that session, send a
//! convert frame, assert MathML in the result. Exercises the v1.2 WS
//! plumbing (session-bound upgrade, disk-sourced active_file).

use ar5iv_editor::{
    AppState, config::SessionConfig, convert::Converter, examples::ExampleCatalog, router,
    session::SessionRegistry,
};
use ar5iv_editor_protocol::{ConvertRequest, ConvertResponse};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn ws_convert_round_trips_through_engine() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let sessions_root = TempDir::new().unwrap();
    let session_cfg = SessionConfig {
        sessions_dir:            sessions_root.path().to_path_buf(),
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
        sessions:  Arc::new(SessionRegistry::new(session_cfg)),
        examples:  Arc::new(ExampleCatalog::load().expect("examples manifest")),
        vscode_web_dir: Arc::new(std::path::PathBuf::from("vscode-web")),
        vscode_ext_dir: Arc::new(std::path::PathBuf::from("vscode-extension")),
    };
    let app = router(state);

    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    // Mint a user.
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

    // Create a session and PUT a fresh `main.tex` carrying just the
    // math fragment we want to render.
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

    let put = client
        .put(format!("{base}/api/session/{session_id}/files/main.tex"))
        .header("x-ar5iv-user", &user)
        .body("\\(x^2 + y^2 = z^2\\)".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let put_body: Value = put.json().await.unwrap();
    let version = put_body["version"].as_u64().unwrap();

    let url = format!("ws://{addr}/convert?session_id={session_id}&user_id={user}");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();

    let req = ConvertRequest {
        id:          42,
        active_file: "main.tex".into(),
        version,
        preamble:    None,
        profile:     Some("fragment".into()),
        format:      Some("html5".into()),
        preload:     vec![],
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap().into()))
        .await
        .unwrap();

    let text = loop {
        match ws.next().await.expect("ws closed").unwrap() {
            Message::Text(t) => break t,
            _ => continue,
        }
    };
    let resp: ConvertResponse = serde_json::from_str(text.as_str()).unwrap();
    assert_eq!(resp.id, 42);
    assert_eq!(resp.version, version);
    assert_eq!(
        resp.status_code, 0,
        "conversion failed: status={:?} log={:?}",
        resp.status, resp.log
    );
    assert!(
        resp.result.contains("<math") || resp.result.contains("MathJax"),
        "expected MathML in response, got: {}",
        resp.result
    );

    server.abort();
}

#[tokio::test]
async fn ws_resolves_input_against_session_dir() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let sessions_root = TempDir::new().unwrap();
    let session_cfg = SessionConfig {
        sessions_dir:            sessions_root.path().to_path_buf(),
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
        sessions:  Arc::new(SessionRegistry::new(session_cfg)),
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

    // Drop a chapter1.tex into the session dir via PUT.
    client
        .put(format!("{base}/api/session/{sid}/files/chapter1.tex"))
        .header("x-ar5iv-user", &user)
        .body(r"Chapter one: \(x^2 + y^2 = z^2\).".to_string())
        .send()
        .await
        .unwrap();
    // Then make `main.tex` reference it.
    let main_put: Value = client
        .put(format!("{base}/api/session/{sid}/files/main.tex"))
        .header("x-ar5iv-user", &user)
        .body(r"\input{chapter1}".to_string())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let v = main_put["version"].as_u64().unwrap();

    let url = format!("ws://{addr}/convert?session_id={sid}&user_id={user}");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();

    let req = ConvertRequest {
        id:          1,
        active_file: "main.tex".into(),
        version:     v,
        preamble:    None,
        profile:     Some("fragment".into()),
        format:      Some("html5".into()),
        preload:     vec![],
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap().into()))
        .await
        .unwrap();
    let text = loop {
        match ws.next().await.expect("ws closed").unwrap() {
            Message::Text(t) => break t,
            _ => continue,
        }
    };
    let resp: ConvertResponse = serde_json::from_str(&text).unwrap();
    assert_eq!(resp.status_code, 0, "{}\n{}", resp.status, resp.log);
    assert!(
        resp.result.contains("<math"),
        "expected MathML resolved through search_paths, got: {}",
        resp.result
    );
    assert!(
        resp.result.contains("Chapter one"),
        "expected chapter1's prose to appear: {}",
        resp.result
    );

    server.abort();
}
