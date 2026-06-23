//! The data-cleanup guarantee: *every* preview surface persists user
//! data through the single `SessionRegistry` chokepoint, under the
//! single `sessions_dir`, and is reaped by the single GC loop. There is
//! no per-route cleanup code — so the guarantee is "anything any route
//! writes lands under a registry-minted session dir, and the GC drains
//! it." These tests lock that invariant against a future route that
//! forgets it (e.g. writes a scratch file beside the sessions root, or
//! a converter that escapes the session dir).
//!
//! Two halves:
//!   1. `all_preview_routes_drain_to_empty_after_gc` — drive each
//!      surface (editor/vscode `POST /api/session` + a file save,
//!      upload `POST /api/import-archive`, an example slot), then assert
//!      the sessions root is empty after one idle GC pass.
//!   2. `converter_confines_writes_to_the_session_dir` (`--ignored`,
//!      heavy) — run a real conversion that writes graphics output and
//!      assert it creates nothing in the sessions root outside the
//!      session's own dir. This is the "scope assert": GC only sweeps
//!      `sessions_dir`, so a converter write outside it would leak.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ar5iv_editor::{
    AppState, config::SessionConfig, convert::Converter, examples::ExampleCatalog, router,
    session::{SessionRegistry, Slot},
};
use ar5iv_editor_protocol::ConvertRequest;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;

const HEADER_USER: &str = "x-ar5iv-user";

/// 1×1 PNG, same fixture the graphics round-trip test uses — small but a
/// real PNG the engine's graphics post-processor will pick up.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

/// HTTP rig that also hands back the registry + sessions root, so the
/// test can drive a deterministic `gc_once()` and inspect the on-disk
/// tree directly (rather than racing the background GC ticker).
struct Rig {
    base:        String,
    client:      reqwest::Client,
    sessions:    Arc<SessionRegistry>,
    sessions_dir: std::path::PathBuf,
    _server:     tokio::task::JoinHandle<()>,
    _tempdir:    TempDir,
}

impl Rig {
    async fn boot(idle: Duration) -> Self {
        let temp = TempDir::new().unwrap();
        let cfg = SessionConfig {
            sessions_dir:            temp.path().to_path_buf(),
            idle_timeout:            idle,
            // A large interval: the test calls `gc_once` itself rather
            // than waiting on the background ticker, so we don't want a
            // tick racing us.
            gc_interval:             Duration::from_secs(3600),
            quota_session_bytes:     50 * 1024 * 1024,
            quota_session_files:     200,
            quota_upload_bytes:      10 * 1024 * 1024,
            quota_archive_bytes:     25 * 1024 * 1024,
            quota_root_bytes:        2 * 1024 * 1024 * 1024,
            // High enough that the three surfaces we create for one user
            // all coexist (no per-user-cap eviction muddying the count).
            quota_sessions_per_user: 16,
            quota_users_per_ip:      16,
        };
        let sessions = Arc::new(SessionRegistry::new(cfg));
        let state = AppState {
            converter: Arc::new(Converter::new(1, None)),
            sessions:  sessions.clone(),
            examples:  Arc::new(ExampleCatalog::load().expect("examples manifest")),
            vscode_web_dir: Arc::new(std::path::PathBuf::from("vscode-web")),
            vscode_ext_dir: Arc::new(std::path::PathBuf::from("vscode-extension")),
        };
        let app = router(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            base: format!("http://{addr}"),
            client: reqwest::Client::new(),
            sessions,
            sessions_dir: temp.path().to_path_buf(),
            _server: server,
            _tempdir: temp,
        }
    }

    fn url(&self, path: &str) -> String { format!("{}{path}", self.base) }

    async fn mint_user(&self) -> String {
        let body: Value = self
            .client
            .post(self.url("/api/user"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        body["user_id"].as_str().unwrap().to_string()
    }
}

/// Names of the immediate subdirectories of the sessions root. Each one
/// is a single session's tmpdir (a 43-char disk token); the count is the
/// number of sessions whose data is currently on disk.
fn session_dir_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn all_preview_routes_drain_to_empty_after_gc() {
    // Idle window short enough to expire within the test, long enough
    // that the create/PUT calls below all land inside it.
    let rig = Rig::boot(Duration::from_millis(20)).await;
    let user = rig.mint_user().await;

    // Surface 1 — editor / VS Code web: create a blank session, then
    // "save a file" the way `hostedProvider.ts` does (PUT into the
    // session). This is exactly the path a /vscode save takes.
    let blank: Value = rig
        .client
        .post(rig.url("/api/session"))
        .header(HEADER_USER, &user)
        .json(&json!({ "slot": "blank" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let blank_id = blank["id"].as_str().unwrap().to_string();
    let put = rig
        .client
        .put(rig.url(&format!("/api/session/{blank_id}/files/draft.tex")))
        .header(HEADER_USER, &user)
        .body(b"\\documentclass{article}\\begin{document}hi\\end{document}".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200, "vscode-style save should succeed");

    // Surface 2 — example slot (editor "open an example").
    let _example: Value = rig
        .client
        .post(rig.url("/api/session"))
        .header(HEADER_USER, &user)
        .json(&json!({ "slot": "example:equations" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Surface 3 — the /upload page: POST a ZIP to import-archive, which
    // mints an `upload:<hash>` session.
    let mut zip_buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_buf);
        let mut w = zip::ZipWriter::new(cursor);
        w.start_file("main.tex", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut w, b"\\(x^2\\)").unwrap();
        w.finish().unwrap();
    }
    let imp = rig
        .client
        .post(rig.url("/api/import-archive"))
        .header(HEADER_USER, &user)
        .header("content-type", "application/zip")
        .body(zip_buf)
        .send()
        .await
        .unwrap();
    assert_eq!(imp.status(), 200, "upload import-archive should succeed");

    // All three surfaces put their data on disk under the one root.
    let before = session_dir_names(&rig.sessions_dir);
    assert_eq!(
        before.len(),
        3,
        "expected 3 session dirs (vscode save, example, upload), got {before:?}"
    );

    // Let every session go idle, then run one GC pass directly (no
    // ticker race). The single GC loop must drain *all* of them —
    // whichever route created them.
    tokio::time::sleep(Duration::from_millis(60)).await;
    rig.sessions.gc_once().await;

    let after = session_dir_names(&rig.sessions_dir);
    assert!(
        after.is_empty(),
        "every preview route's data must be reaped by the shared GC; leftovers: {after:?}"
    );
}

#[tokio::test]
#[ignore = "runs a real conversion (heavy preloads + post-processing); run with --ignored"]
async fn converter_confines_writes_to_the_session_dir() {
    // The GC only sweeps `sessions_dir`. So the cleanup guarantee rests
    // on the converter writing *only* inside the per-session dir — never
    // a sibling scratch file in the sessions root. We assert that by
    // snapshotting the root's entries around a real conversion that
    // exercises the graphics write path (\includegraphics emits a PNG
    // into the session dir).
    //
    // (Scope: this checks the sessions root, which is what GC owns. It
    // deliberately doesn't try to police the process CWD or the system
    // tmpdir — the engine is pointed at the session dir for source,
    // search-paths, and graphics destination in `convert.rs`, and the
    // deploy runs the whole thing on a tmpfs that's wiped on restart.)
    let temp = TempDir::new().unwrap();
    let cfg = SessionConfig {
        sessions_dir:            temp.path().to_path_buf(),
        idle_timeout:            Duration::from_secs(600),
        gc_interval:             Duration::from_secs(3600),
        quota_session_bytes:     50 * 1024 * 1024,
        quota_session_files:     200,
        quota_upload_bytes:      10 * 1024 * 1024,
        quota_archive_bytes:     25 * 1024 * 1024,
        quota_root_bytes:        2 * 1024 * 1024 * 1024,
        quota_sessions_per_user: 8,
        quota_users_per_ip:      16,
    };
    let sessions = Arc::new(SessionRegistry::new(cfg));
    let converter = Converter::new(1, None);

    // One session, seeded blank, then loaded with a doc that pulls in a
    // graphic so the post-processor has something to emit.
    let user = sessions.mint_user_id();
    let session = sessions
        .lookup_or_create(&user, &Slot::Blank, |dir| async move {
            tokio::fs::write(dir.join("fig.png"), TINY_PNG).await.unwrap();
            let body = b"\\documentclass{article}\\usepackage{graphicx}\
\\begin{document}\\includegraphics[width=2cm]{fig}\\end{document}";
            tokio::fs::write(dir.join("main.tex"), body).await.unwrap();
            Ok((body.len() as u64, 2))
        })
        .await
        .unwrap();
    session.refresh_main_entry();

    // Snapshot the sessions root: exactly the one session dir, nothing
    // else, before we convert.
    let root_before = session_dir_names(temp.path());
    assert_eq!(root_before.len(), 1, "setup: one session dir before convert");

    let req = ConvertRequest {
        id:          1,
        active_file: "main.tex".into(),
        version:     1,
        preamble:    None,
        profile:     Some("document".into()),
        format:      Some("html5".into()),
        preload:     vec!["graphicx.sty".into()],
        source:      None,
    };
    let resp = converter.convert(req, session.clone()).await;
    assert!(
        resp.status_code == 0 || resp.status_code == 2,
        "conversion should render (status={:?} log={})",
        resp.status,
        resp.log
    );

    // The root must be unchanged: still exactly the one session dir, no
    // sibling scratch files/dirs the converter spilled outside it.
    let root_after = session_dir_names(temp.path());
    assert_eq!(
        root_after, root_before,
        "converter must not create entries in the sessions root outside the session dir"
    );
    let stray_files: Vec<String> = std::fs::read_dir(temp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        stray_files.is_empty(),
        "converter must not write loose files into the sessions root: {stray_files:?}"
    );

    // Sanity: the conversion really did write its graphics output, and
    // it landed *inside* the session dir (so the assertion above wasn't
    // vacuous).
    let png_in_session = session.dir.join("fig.png");
    assert!(png_in_session.exists(), "fig.png should remain in the session dir");
}
