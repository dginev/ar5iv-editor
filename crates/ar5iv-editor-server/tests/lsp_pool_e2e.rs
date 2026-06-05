//! Heavy (`--ignored`) end-to-end tests for the warm LSP engine pool:
//! a REAL `latexml_oxide --server` child per session.
//!
//! Engine resolution: `AR5IV_LATEXML_BIN` env, then `$PATH`, then the
//! sibling dev checkout (`../latexml-oxide/target/release/latexml_oxide`).
//! Run with:
//!     AR5IV_LATEXML_BIN=.../latexml_oxide cargo test -p ar5iv-editor-server \
//!         --test lsp_pool_e2e -- --ignored

use std::path::PathBuf;
use std::time::Instant;

use ar5iv_editor::lsp_pool::{LspPool, LspPoolConfig, resolve_engine};
use tempfile::TempDir;

fn engine() -> PathBuf {
    if let Some(p) = resolve_engine() {
        return p;
    }
    // Dev convenience: the sibling latexml-oxide checkout.
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../latexml-oxide/target/release/latexml_oxide");
    assert!(
        sibling.is_file(),
        "no latexml_oxide engine: set AR5IV_LATEXML_BIN or build the sibling checkout"
    );
    sibling
}

fn pool(capacity: usize) -> LspPool {
    LspPool::new(LspPoolConfig {
        engine: engine(),
        capacity,
        timeout_secs: 120,
        max_memory_mb: 6144,
        idle_reap_secs: 600,
    })
}

/// A two-file project: the warm path must resolve `\input` siblings from
/// the session dir and pick up their on-disk edits on every conversion.
fn write_project(dir: &TempDir) -> PathBuf {
    let main = dir.path().join("main.tex");
    std::fs::write(
        &main,
        "\\documentclass{article}\n\\begin{document}\nIntro $\\pi+1$.\n\\input{ch}\n\\end{document}\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("ch.tex"), "chapter version A.\n").unwrap();
    main
}

#[tokio::test]
#[ignore] // heavy: spawns real engine children
async fn warm_pool_converts_and_tracks_disk_edits() {
    let pool = pool(2);
    let dir = TempDir::new().unwrap();
    let main = write_project(&dir);
    let tex = std::fs::read_to_string(&main).unwrap();

    let t0 = Instant::now();
    let cold = pool
        .convert(dir.path(), &main, &tex)
        .await
        .expect("cold convert");
    let cold_ms = t0.elapsed().as_millis();
    assert_eq!(cold.status_code, 0, "log: {}", cold.log);
    assert!(cold.html.contains("Intro"), "root content rendered");
    assert!(cold.html.contains("version A"), "\\input sibling rendered");

    // Body edit of the ROOT: must hit the warm cache (fork-only).
    let tex2 = tex.replace("Intro", "Reworked intro");
    let t1 = Instant::now();
    let warm = pool
        .convert(dir.path(), &main, &tex2)
        .await
        .expect("warm convert");
    let warm_ms = t1.elapsed().as_millis();
    assert_eq!(warm.status_code, 0);
    assert!(warm.html.contains("Reworked intro"));
    eprintln!("cold={cold_ms} ms  warm={warm_ms} ms");
    assert!(
        warm_ms * 2 < cold_ms.max(200),
        "warm conversion ({warm_ms} ms) should be far below cold ({cold_ms} ms)"
    );

    // Disk edit of the body sibling: body files are re-read every
    // conversion, so the change appears WITHOUT losing the warm cache.
    std::fs::write(dir.path().join("ch.tex"), "chapter version B.\n").unwrap();
    let t2 = Instant::now();
    let resp = pool
        .convert(dir.path(), &main, &tex2)
        .await
        .expect("sibling-edit convert");
    let sibling_ms = t2.elapsed().as_millis();
    assert!(resp.html.contains("version B"), "fresh sibling content");
    assert!(
        sibling_ms * 2 < cold_ms.max(200),
        "body-sibling save must stay warm ({sibling_ms} ms vs cold {cold_ms} ms)"
    );
}

#[tokio::test]
#[ignore] // heavy
async fn sessions_convert_concurrently_and_capacity_evicts() {
    let pool = std::sync::Arc::new(pool(1)); // capacity 1: forces eviction
    let a = TempDir::new().unwrap();
    let b = TempDir::new().unwrap();
    let main_a = write_project(&a);
    let main_b = write_project(&b);
    let tex_a = std::fs::read_to_string(&main_a).unwrap();
    let tex_b = std::fs::read_to_string(&main_b)
        .unwrap()
        .replace("Intro", "SessionB");

    // Concurrent conversions from two sessions: distinct children, both
    // succeed even at capacity 1 (busy children are never evicted; the
    // pool tops over capacity rather than serialize cross-session work).
    let (ra, rb) = tokio::join!(
        pool.convert(a.path(), &main_a, &tex_a),
        pool.convert(b.path(), &main_b, &tex_b),
    );
    let ra = ra.expect("session A converts");
    let rb = rb.expect("session B converts");
    assert!(ra.html.contains("Intro"));
    assert!(rb.html.contains("SessionB"));

    // Sequential ping-pong across capacity: evictions must be invisible
    // (the evicted session just pays a fresh cold start).
    let r2 = pool
        .convert(a.path(), &main_a, &tex_a)
        .await
        .expect("A again");
    assert_eq!(r2.status_code, 0);
    let r3 = pool
        .convert(b.path(), &main_b, &tex_b)
        .await
        .expect("B again");
    assert_eq!(r3.status_code, 0);
}
