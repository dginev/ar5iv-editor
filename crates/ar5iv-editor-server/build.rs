//! Build script: capture the `latexml-oxide` short SHA and commit
//! date as compile-time constants in the binary.
//!
//! The values are deliberately pinned to the **tip of master** in
//! the latexml-oxide checkout, not whatever branch happens to be
//! checked out locally. We're advertising "this binary was built
//! against latexml-oxide master @<sha>" and the SHA needs to mean
//! the same thing across every developer's working tree.
//!
//! Two sources, in order:
//!
//! 1. Build-args set at the docker build stage (the production
//!    path). `deploy/build-and-push.sh` resolves `master` against
//!    the sibling `latexml-oxide` checkout and passes the result as
//!    `LATEXML_OXIDE_SHA` / `LATEXML_OXIDE_DATE` build-args, which
//!    the Dockerfile re-exports as env vars.
//!
//! 2. A direct `git -C ../../../latexml-oxide ... master` call on
//!    the local filesystem (the `cargo run` / `cargo test` path).
//!    Uses the local `master` ref; the user is responsible for
//!    `git pull`'ing on their checkout if they want freshly-built
//!    constants.
//!
//! Falls back to `"unknown"` so a freshly-cloned tree without a
//! local `master` ref still builds (`cargo run` works; the version
//! marker just shows "unknown").

use std::process::Command;

const REF: &str = "master";

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
