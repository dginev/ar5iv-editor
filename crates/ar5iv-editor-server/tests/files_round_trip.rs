//! Integration tests for the Phase 1 file/session routes. Mints a
//! user, creates slots, exercises the CRUD operations, and verifies
//! dedup, eviction, path-traversal rejection, ownership checks, and
//! GC behaviour.

use std::sync::Arc;
use std::time::Duration;

use ar5iv_editor::{
    AppState, config::SessionConfig, convert::Converter, examples::ExampleCatalog, router,
    session::{SessionRegistry, Slot, Token},
};
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;

const HEADER_USER: &str = "x-ar5iv-user";

struct TestRig {
    base:     String,
    client:   reqwest::Client,
    _server:  tokio::task::JoinHandle<()>,
    _tempdir: TempDir,
}

impl TestRig {
    async fn boot(cfg: SessionConfig) -> Self {
        let temp = TempDir::new().unwrap();
        let cfg = SessionConfig { sessions_dir: temp.path().to_path_buf(), ..cfg };
        let state = AppState {
            converter: Arc::new(Converter::new(1)),
            sessions:  Arc::new(SessionRegistry::new(cfg)),
            examples:  Arc::new(ExampleCatalog::load().expect("examples manifest")),
        };
        let app = router(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            base: format!("http://{addr}"),
            client: reqwest::Client::new(),
            _server: server,
            _tempdir: temp,
        }
    }

    fn url(&self, path: &str) -> String { format!("{}{path}", self.base) }

    async fn mint_user(&self) -> String {
        let resp = self.client.post(self.url("/api/user")).send().await.unwrap();
        assert_eq!(resp.status(), 200);
        let body: Value = resp.json().await.unwrap();
        body["user_id"].as_str().unwrap().to_string()
    }

    async fn create_session(&self, user: &str, slot: &str) -> Value {
        let resp = self
            .client
            .post(self.url("/api/session"))
            .header(HEADER_USER, user)
            .json(&json!({ "slot": slot }))
            .send()
            .await
            .unwrap();
        let status = resp.status();
        let body_text = resp.text().await.unwrap();
        assert_eq!(status, 200, "create_session body: {body_text}");
        serde_json::from_str(&body_text).unwrap()
    }
}

fn default_session_cfg() -> SessionConfig {
    SessionConfig {
        sessions_dir:            std::path::PathBuf::from("/replaced-in-boot"),
        idle_timeout:            Duration::from_secs(600),
        gc_interval:             Duration::from_secs(60),
        quota_session_bytes:     1024 * 1024,
        quota_session_files:     50,
        quota_upload_bytes:      256 * 1024,
        quota_archive_bytes:     1024 * 1024,
        quota_root_bytes:        100 * 1024 * 1024,
        quota_sessions_per_user: 3,
        quota_users_per_ip:      4,
    }
}

#[tokio::test]
async fn create_lookup_dedup_and_files_crud() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s1 = rig.create_session(&user, "blank").await;
    let id = s1["id"].as_str().unwrap().to_string();

    // The blank slot ships with the welcome `main.tex`.
    let files = s1["files"].as_array().unwrap();
    assert!(files.iter().any(|f| f["path"] == "main.tex"));
    assert_eq!(s1["entry"], "main.tex");

    // Re-creating the same slot returns the same id (dedup).
    let s2 = rig.create_session(&user, "blank").await;
    assert_eq!(s2["id"].as_str().unwrap(), id);

    // PUT a new file, then list, then GET it back.
    let resp = rig
        .client
        .put(rig.url(&format!("/api/session/{id}/files/note.txt")))
        .header(HEADER_USER, &user)
        .body(b"hello note".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let ack: Value = resp.json().await.unwrap();
    assert_eq!(ack["size"], 10);
    let v_after_put = ack["version"].as_u64().unwrap();
    assert!(v_after_put >= 1);

    let listing: Value = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/files")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let paths: Vec<String> = listing["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect();
    assert!(paths.contains(&"note.txt".to_string()));
    assert!(paths.contains(&"main.tex".to_string()));

    let resp = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/files/note.txt")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = resp.bytes().await.unwrap();
    assert_eq!(bytes.as_ref(), b"hello note");
}

#[tokio::test]
async fn path_traversal_is_rejected_at_resolve_chokepoint() {
    // Axum's router normalises `..` in URL paths before routing
    // (RFC 3986 dot-segment removal), so we never see traversal in our
    // handler — the request 404s at the route level. The actual
    // chokepoint, `Session::resolve`, is unit-tested in `session.rs`;
    // here we verify the multipart upload path's call to `resolve` —
    // which cannot be normalised away because the malicious path is in
    // the multipart body, not the URL.
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s = rig.create_session(&user, "blank").await;
    let id = s["id"].as_str().unwrap();

    for bad in ["../escape.tex", "/etc/passwd.tex", "ok/../../escape.tex", "back\\slash.tex"] {
        let form = Form::new().part("f", Part::bytes(b"x".to_vec()).file_name(bad));
        let resp = rig
            .client
            .post(rig.url(&format!("/api/session/{id}/upload")))
            .header(HEADER_USER, &user)
            .multipart(form)
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            400,
            "expected 400 for upload filename={bad}, got {}",
            resp.status()
        );
    }
}

#[tokio::test]
async fn foreign_user_cannot_access_session() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let alice = rig.mint_user().await;
    let bob = rig.mint_user().await;
    let s = rig.create_session(&alice, "blank").await;
    let id = s["id"].as_str().unwrap();

    let resp = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/files")))
        .header(HEADER_USER, &bob)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
async fn unknown_session_id_returns_410() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    // 43-char base64url-no-pad token, but never registered.
    let resp = rig
        .client
        .get(rig.url("/api/session/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/files"))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 410);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["code"], "session_expired");
}

#[tokio::test]
async fn per_user_cap_evicts_oldest() {
    let mut cfg = default_session_cfg();
    cfg.quota_sessions_per_user = 2;
    let rig = TestRig::boot(cfg).await;
    let user = rig.mint_user().await;

    let a = rig.create_session(&user, "example:equations").await;
    let _b = rig.create_session(&user, "example:tables").await;
    // Third slot should evict `example:equations` (the oldest).
    let _c = rig.create_session(&user, "example:calculus").await;

    let id_a = a["id"].as_str().unwrap();
    let resp = rig
        .client
        .get(rig.url(&format!("/api/session/{id_a}/files")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 410);
}

#[tokio::test]
async fn gc_removes_idle_sessions() {
    let temp = TempDir::new().unwrap();
    let mut cfg = default_session_cfg();
    cfg.sessions_dir = temp.path().to_path_buf();
    cfg.idle_timeout = Duration::from_millis(100);
    cfg.gc_interval  = Duration::from_millis(50);
    let registry = Arc::new(SessionRegistry::new(cfg));
    let _gc = registry.spawn_gc();

    let user = registry.mint_user_id();
    let session = registry
        .lookup_or_create(&user, &Slot::Blank, |dir| async move {
            tokio::fs::write(dir.join("main.tex"), b"x").await.unwrap();
            Ok((1, 1))
        })
        .await
        .unwrap();
    let dir = session.dir.clone();
    let id = session.id.clone();
    drop(session);

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!dir.exists(), "session dir should be removed by GC");
    assert!(registry.get(&id).await.is_err());

    // Avoid an unused-import warning for `Token` on platforms where the
    // compiler considers the alias trivially unused; the type is the
    // canonical token shape and stays exported regardless.
    let _: Option<Token> = None;
}

#[tokio::test]
async fn upload_multipart_writes_files() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s = rig.create_session(&user, "blank").await;
    let id = s["id"].as_str().unwrap();

    let form = Form::new()
        .part("file1", Part::bytes(b"document a".to_vec()).file_name("a.tex"))
        .part("file2", Part::bytes(b"document b".to_vec()).file_name("sub/b.tex"));
    let resp = rig
        .client
        .post(rig.url(&format!("/api/session/{id}/upload")))
        .header(HEADER_USER, &user)
        .multipart(form)
        .send()
        .await
        .unwrap();
    let status = resp.status();
    let txt = resp.text().await.unwrap();
    assert_eq!(status, 200, "upload body: {txt}");

    let listing: Value = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/files")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let paths: Vec<String> = listing["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect();
    assert!(paths.contains(&"a.tex".to_string()));
    assert!(paths.contains(&"sub/b.tex".to_string()));
}

#[tokio::test]
async fn example_slot_seeds_from_embedded_manifest() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s = rig.create_session(&user, "example:equations").await;
    let id = s["id"].as_str().unwrap();
    let resp = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/files/main.tex")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(
        body.contains("Lorenz"),
        "expected Lorenz from equations example, got: {}",
        &body[..body.len().min(200)]
    );
}

#[tokio::test]
async fn sweep_orphans_runs_on_create_and_removes_stale_orphans() {
    use ar5iv_editor::session::Slot as ServerSlot;
    use std::time::Duration;

    let temp = TempDir::new().unwrap();
    let mut cfg = default_session_cfg();
    cfg.sessions_dir = temp.path().to_path_buf();
    cfg.idle_timeout = Duration::from_millis(50);
    let registry = Arc::new(SessionRegistry::new(cfg));

    // Plant an "orphan" — a 43-char-shaped subdirectory that is *not*
    // registered. Set its mtime well into the past so the sweep
    // considers it stale.
    let orphan_name = "A".repeat(43);
    let orphan_dir = temp.path().join(&orphan_name);
    std::fs::create_dir_all(&orphan_dir).unwrap();
    std::fs::write(orphan_dir.join("ghost.tex"), b"x").unwrap();
    let past = std::time::SystemTime::now() - Duration::from_secs(60 * 60);
    let _ = filetime::set_file_mtime(
        &orphan_dir,
        filetime::FileTime::from_system_time(past),
    );

    // Plant a hand-placed admin file under the sessions root — should
    // survive the sweep because it doesn't match the token shape.
    let admin_file = temp.path().join("README");
    std::fs::write(&admin_file, b"keep me").unwrap();

    // Trigger the sweep by creating a fresh session.
    let user = registry.mint_user_id();
    let _session = registry
        .lookup_or_create(&user, &ServerSlot::Blank, |dir| async move {
            tokio::fs::write(dir.join("main.tex"), b"hello").await.unwrap();
            Ok((5, 1))
        })
        .await
        .unwrap();

    // Orphan gone; admin file kept; new session's tmpdir present.
    assert!(!orphan_dir.exists(), "orphan should be swept");
    assert!(admin_file.exists(), "admin file kept (length filter)");
    let live_dirs: Vec<_> = std::fs::read_dir(temp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    assert_eq!(live_dirs.len(), 1, "exactly one live session dir");
}

#[tokio::test]
async fn arxiv_example_slot_unpacks_its_tarball() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s = rig.create_session(&user, "example:arxiv").await;
    let id = s["id"].as_str().unwrap();
    // Listing should contain at least the entry file from the tarball.
    let resp = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/files")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap();
    let listing: Value = resp.json().await.unwrap();
    let paths: Vec<String> = listing["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect();
    assert!(
        paths.iter().any(|p| p == "full_article.tex"),
        "tarball should unpack full_article.tex; got: {paths:?}"
    );
    assert!(
        paths.iter().any(|p| p == "preprint_inset.pdf"),
        "tarball should unpack preprint_inset.pdf; got: {paths:?}"
    );
    assert_eq!(s["entry"], "full_article.tex");
}

#[tokio::test]
async fn import_archive_zip_creates_upload_slot() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;

    // Build a tiny ZIP in-memory.
    let mut zip_buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_buf);
        let mut w = zip::ZipWriter::new(cursor);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        w.start_file("main.tex", opts).unwrap();
        std::io::Write::write_all(&mut w, b"\\(x^2\\)").unwrap();
        w.start_file("notes.txt", opts).unwrap();
        std::io::Write::write_all(&mut w, b"hello").unwrap();
        w.finish().unwrap();
    }

    let resp = rig
        .client
        .post(rig.url("/api/import-archive"))
        .header(HEADER_USER, &user)
        .header("content-type", "application/zip")
        .body(zip_buf.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let env1: Value = resp.json().await.unwrap();
    let id1 = env1["id"].as_str().unwrap().to_string();
    let slot1 = env1["slot"].as_str().unwrap().to_string();
    assert!(slot1.starts_with("upload:"));

    // Re-uploading the same archive returns the same id (dedup by hash).
    let resp = rig
        .client
        .post(rig.url("/api/import-archive"))
        .header(HEADER_USER, &user)
        .header("content-type", "application/zip")
        .body(zip_buf)
        .send()
        .await
        .unwrap();
    let env2: Value = resp.json().await.unwrap();
    assert_eq!(env2["id"].as_str().unwrap(), id1);
    assert_eq!(env2["slot"].as_str().unwrap(), slot1);
}

#[tokio::test]
async fn export_zip_round_trips_via_import_archive() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s = rig.create_session(&user, "blank").await;
    let id = s["id"].as_str().unwrap();

    // Add a second file so the export has substance.
    rig.client
        .put(rig.url(&format!("/api/session/{id}/files/notes.txt")))
        .header(HEADER_USER, &user)
        .body(b"hello".to_vec())
        .send()
        .await
        .unwrap();

    // Export.
    let zip_resp = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/export-zip")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap();
    assert_eq!(zip_resp.status(), 200);
    assert_eq!(zip_resp.headers().get("content-type").unwrap(), "application/zip");
    let zip_bytes = zip_resp.bytes().await.unwrap().to_vec();
    assert!(zip_bytes.starts_with(b"PK\x03\x04"));

    // Re-import → new project with the same files.
    let imp = rig
        .client
        .post(rig.url("/api/import-archive"))
        .header(HEADER_USER, &user)
        .header("content-type", "application/zip")
        .body(zip_bytes)
        .send()
        .await
        .unwrap();
    let imp_env: Value = imp.json().await.unwrap();
    let imp_paths: Vec<String> = imp_env["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect();
    assert!(imp_paths.contains(&"main.tex".to_string()));
    assert!(imp_paths.contains(&"notes.txt".to_string()));
}

#[tokio::test]
async fn upload_archive_overlays_into_current_session() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s = rig.create_session(&user, "blank").await;
    let id = s["id"].as_str().unwrap();

    // Build a ZIP carrying a single file that doesn't collide with main.tex.
    let mut zip_buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_buf);
        let mut w = zip::ZipWriter::new(cursor);
        w.start_file("chapter1.tex", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut w, b"chapter one").unwrap();
        w.finish().unwrap();
    }

    let resp = rig
        .client
        .post(rig.url(&format!("/api/session/{id}/upload-archive")))
        .header(HEADER_USER, &user)
        .header("content-type", "application/zip")
        .body(zip_buf)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Confirm both files are now present.
    let listing: Value = rig
        .client
        .get(rig.url(&format!("/api/session/{id}/files")))
        .header(HEADER_USER, &user)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let paths: Vec<String> = listing["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect();
    assert!(paths.contains(&"main.tex".to_string()));
    assert!(paths.contains(&"chapter1.tex".to_string()));
}

#[tokio::test]
async fn upload_extension_allowlist_rejects_unknown_types() {
    let rig = TestRig::boot(default_session_cfg()).await;
    let user = rig.mint_user().await;
    let s = rig.create_session(&user, "blank").await;
    let id = s["id"].as_str().unwrap();

    let form = Form::new()
        .part("f", Part::bytes(b"MZ".to_vec()).file_name("evil.exe"));
    let resp = rig
        .client
        .post(rig.url(&format!("/api/session/{id}/upload")))
        .header(HEADER_USER, &user)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 413);
}
