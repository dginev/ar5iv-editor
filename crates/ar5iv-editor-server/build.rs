//! Build script: capture the `latexml-oxide` short SHA and commit
//! date as compile-time constants in the binary.
//!
//! The values are deliberately pinned to the **tip of main** in
//! the latexml-oxide checkout, not whatever branch happens to be
//! checked out locally. We're advertising "this binary was built
//! against latexml-oxide main @<sha>" and the SHA needs to mean
//! the same thing across every developer's working tree.
//!
//! Two sources, in order:
//!
//! 1. Build-args set at the docker build stage (the production
//!    path). `deploy/build-and-push.sh` resolves `main` against
//!    the sibling `latexml-oxide` checkout and passes the result as
//!    `LATEXML_OXIDE_SHA` / `LATEXML_OXIDE_DATE` build-args, which
//!    the Dockerfile re-exports as env vars.
//!
//! 2. A direct `git -C ../../../latexml-oxide ... main` call on
//!    the local filesystem (the `cargo run` / `cargo test` path).
//!    Uses the local `main` ref; the user is responsible for
//!    `git pull`'ing on their checkout if they want freshly-built
//!    constants.
//!
//! Falls back to `"unknown"` so a freshly-cloned tree without a
//! local `main` ref still builds (`cargo run` works; the version
//! marker just shows "unknown").

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const REF: &str = "main";

fn main() {
    println!("cargo:rerun-if-env-changed=LATEXML_OXIDE_SHA");
    println!("cargo:rerun-if-env-changed=LATEXML_OXIDE_DATE");

    // The path-dep entry in Cargo.toml is `../../../latexml-oxide/...`.
    // Watch master's tip so a `git pull` invalidates this crate's
    // build (and hence re-runs build.rs).
    println!("cargo:rerun-if-changed=../../../latexml-oxide/.git/refs/heads/{REF}");

    let sha = std::env::var("LATEXML_OXIDE_SHA")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            run_git(&["-C", "../../../latexml-oxide", "rev-parse", "--short", REF])
        });
    let date = std::env::var("LATEXML_OXIDE_DATE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            run_git(&["-C", "../../../latexml-oxide", "log", "-1", "--format=%cs", REF])
        });

    // The validator schema source is a submodule at the repo root
    // (`../../validator`), so — unlike latexml-oxide above — HEAD *is*
    // the pinned commit and needs no branch indirection.
    println!("cargo:rerun-if-env-changed=VALIDATOR_SHA");
    println!("cargo:rerun-if-changed=../../.git/modules/validator/HEAD");
    let validator_sha = std::env::var("VALIDATOR_SHA")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            run_git(&["-C", "../../validator", "rev-parse", "--short", "HEAD"])
        });

    println!("cargo:rustc-env=LATEXML_OXIDE_SHA={}", sha);
    println!("cargo:rustc-env=LATEXML_OXIDE_DATE={}", date);
    println!("cargo:rustc-env=VALIDATOR_SHA={}", validator_sha);

    // The `examples/` tree is embedded into the binary via `include_dir!`
    // in examples.rs. include_dir's own change-tracking (`track_path`) is a
    // no-op without its `nightly` feature, which we don't enable — so cargo
    // would NOT recompile this crate when an example changes, silently
    // re-embedding a stale tree. Fold the tree's contents into a digest and
    // export it as a rustc-env that examples.rs anchors via `env!`: a changed
    // digest changes this crate's compile inputs and forces a fresh embed.
    // The recursive `rerun-if-changed` below re-runs this script when any
    // example file (or the set of files) changes.
    println!("cargo:rustc-env=AR5IV_EXAMPLES_DIGEST={}", examples_digest());
}

/// FNV-1a 64-bit digest of every file under `../../examples`, plus its
/// relative path, in a deterministic order. Also emits `rerun-if-changed`
/// for each tracked file and directory. Dependency-free so build.rs keeps
/// zero build-dependencies; collisions are irrelevant — we only need the
/// value to *change* when the tree changes.
fn examples_digest() -> String {
    let root = Path::new("../../examples");
    if !root.exists() {
        // A tree without examples/ (unusual, but defensive) still builds.
        return "absent".into();
    }
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(root, &mut files);
    files.sort();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut fold = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for f in &files {
        let rel = f.strip_prefix(root).unwrap_or(f);
        fold(rel.to_string_lossy().as_bytes());
        fold(b"\0");
        if let Ok(bytes) = fs::read(f) {
            fold(&bytes);
        }
        fold(b"\0");
    }
    format!("{hash:016x}")
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    // Track the directory entry so adding/removing a file re-runs build.rs.
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
            out.push(path);
        }
    }
}

fn run_git(args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
