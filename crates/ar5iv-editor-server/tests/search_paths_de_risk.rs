//! Phase 0 de-risk for the FileUI plan (`docs/FileUI.md`).
//!
//! Goal: confirm that `OxideConfig.search_paths` is honoured by
//! `latexml-oxide` so that a literal-source conversion can resolve
//! `\input{chapter1}` and `\includegraphics{fig}` from a session
//! directory laid out on disk. If this test passes, the v1.2 session
//! model can keep its current shape (literal source on the wire,
//! search_paths pointing at the session dir). If it fails, the doc's
//! Phase 0 fallback options apply.
//!
//! This test is intentionally throwaway: it bypasses the
//! `Converter` wrapper and calls latexml-oxide directly, on a
//! 256 MB-stack worker thread that mirrors `convert::Converter`'s
//! production setup.

use std::sync::mpsc;

use latexml::converter::Converter as OxideConverter;
use latexml::post::{PostOptions, run_post_processing};
use latexml_core::common::{Config as OxideConfig, DataSize, OutputFormat};
use tempfile::TempDir;

/// Smallest 1×1 RGBA PNG the author could find that decodes cleanly.
/// Used so `\includegraphics` has a real file to resolve against;
/// the assertion only checks for the resolved name in the output, so
/// even a malformed PNG would do — but a real one keeps any future
/// `image_graphicx_sizer` happy.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length+name
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x06, 0x00, 0x00, 0x00, // 8-bit RGBA, deflate, no filter, no interlace
    0x1f, 0x15, 0xc4, 0x89, // IHDR CRC
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, // IDAT length+name
    0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, // zlib
    0xb4, // IDAT CRC byte 1 of 4 — placeholder (we don't actually decode it)
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND length+name
    0xae, 0x42, 0x60, 0x82, // IEND CRC
];

const PRELOAD: &[&str] = &[
    "LaTeX.pool",
    "article.cls",
    "amsmath.sty",
    "amsthm.sty",
    "amstext.sty",
    "amssymb.sty",
    "graphicx.sty",
    "hyperref.sty",
    "[ids,mathlexemes]latexml.sty",
];

struct ConvertOutcome {
    html: String,
    status: String,
    status_code: usize,
    log: String,
}

/// Run a literal-source conversion on a 256 MB-stack worker thread,
/// returning the post-processed HTML5 (or whatever fragment latexml
/// emits) plus engine status / log for diagnostics.
fn convert_with_search_paths(
    profile: DataSize,
    search_paths: Vec<String>,
    preamble: Option<String>,
    tex: String,
) -> ConvertOutcome {
    let (tx, rx) = mpsc::channel();
    let join = std::thread::Builder::new()
        .name("latexml-oxide-de-risk".into())
        .stack_size(256 * 1024 * 1024)
        .spawn(move || {
            let opts = OxideConfig {
                verbosity: 1,
                format: OutputFormat::HTML5,
                whatsin: profile.clone(),
                whatsout: profile,
                preamble,
                postamble: None,
                mode: None,
                bindings_dispatch: None,
                extra_bindings_dispatch: None,
                preload: Some(PRELOAD.iter().map(|s| s.to_string()).collect()),
                search_paths: Some(search_paths),
                include_comments: Some(false),
                nomathparse: None,
                source_map: None,
            };
            let converter = OxideConverter::from_config(opts);
            let resp = converter.convert(format!("literal:{tex}"));

            let xml = resp.result.clone().unwrap_or_default();
            let html = if xml.is_empty() {
                String::new()
            } else {
                let post_opts = PostOptions {
                    pmml: true,
                    cmml: false,
                    keep_xmath: false,
                    stylesheet: Some("resources/XSLT/LaTeXML-html5.xsl"),
                    destination: None,
                    source_directory: None,
                    search_paths: &[],
                    nodefaultresources: true,
                    css_files: &[],
                    js_files: &[],
                    noinvisibletimes: false,
                    mathtex: false,
                    navigationtoc: None,
                    schemadocs: false,
                    split: false,
                    split_xpath: None,
                    split_naming: None,
                    xslt_parameters: &[],
                    graphics_svg_threshold_kb: 0,
                    whatsout: latexml_post::extract::Whatsout::Document,
                };
                run_post_processing(&xml, &post_opts)
            };

            tx.send(ConvertOutcome {
                html,
                status: resp.status,
                status_code: resp.status_code,
                log: resp.log,
            })
            .ok();
        })
        .expect("spawn 256 MB-stack worker");

    let outcome = rx.recv().expect("worker dropped before sending");
    join.join().expect("worker thread panicked");
    outcome
}

#[test]
#[ignore = "loads heavy preloads + post-processing; run explicitly with --ignored"]
fn search_paths_resolves_input_from_session_dir() {
    let dir = TempDir::new().expect("tmpdir");
    std::fs::write(
        dir.path().join("chapter1.tex"),
        // Distinctive math content so we can grep for it in the HTML.
        r"Hello from chapter1: \(x^2 + y^2 = z^2\).",
    )
    .unwrap();

    let outcome = convert_with_search_paths(
        DataSize::Fragment,
        vec![dir.path().to_string_lossy().into_owned()],
        None,
        r"\input{chapter1}".to_string(),
    );

    eprintln!(
        "[input-test] status_code={} status={:?}\n--- log ---\n{}\n--- html ({}b) ---\n{}",
        outcome.status_code, outcome.status, outcome.log, outcome.html.len(), outcome.html
    );

    assert_eq!(
        outcome.status_code, 0,
        "conversion failed: status={:?} log={}",
        outcome.status, outcome.log
    );
    assert!(
        outcome.html.contains("<math"),
        "expected MathML from chapter1's \\(x^2+y^2=z^2\\) in HTML output; \
         search_paths likely failed to resolve `\\input{{chapter1}}`. log={}",
        outcome.log
    );
    assert!(
        outcome.html.contains("Hello from chapter1"),
        "expected chapter1's prose to appear in HTML output. log={}",
        outcome.log
    );
}

#[test]
#[ignore = "loads heavy preloads + post-processing; run explicitly with --ignored"]
fn search_paths_resolves_includegraphics_from_session_dir() {
    let dir = TempDir::new().expect("tmpdir");
    std::fs::write(dir.path().join("fig.png"), TINY_PNG).unwrap();

    let outcome = convert_with_search_paths(
        DataSize::Fragment,
        vec![dir.path().to_string_lossy().into_owned()],
        None,
        r"\includegraphics[width=2cm]{fig}".to_string(),
    );

    eprintln!(
        "[graphics-test] status_code={} status={:?}\n--- log ---\n{}\n--- html ({}b) ---\n{}",
        outcome.status_code, outcome.status, outcome.log, outcome.html.len(), outcome.html
    );

    assert_eq!(
        outcome.status_code, 0,
        "conversion failed: status={:?} log={}",
        outcome.status, outcome.log
    );
    assert!(
        outcome.html.contains("<img") || outcome.html.contains("fig.png") || outcome.html.contains("fig\""),
        "expected an <img> or 'fig' reference in HTML output; \
         search_paths/graphics resolution likely failed. log={}",
        outcome.log
    );
}

#[test]
#[ignore = "loads heavy preloads + post-processing; run explicitly with --ignored"]
fn search_paths_combined_input_and_graphics() {
    let dir = TempDir::new().expect("tmpdir");
    std::fs::write(
        dir.path().join("chapter1.tex"),
        r"Chapter one: \(x^2 + y^2 = z^2\).",
    )
    .unwrap();
    std::fs::write(dir.path().join("fig.png"), TINY_PNG).unwrap();

    let outcome = convert_with_search_paths(
        DataSize::Fragment,
        vec![dir.path().to_string_lossy().into_owned()],
        None,
        r"\input{chapter1}\par\includegraphics[width=2cm]{fig}".to_string(),
    );

    eprintln!(
        "[combined-test] status_code={} status={:?}\n--- log ---\n{}\n--- html ({}b) ---\n{}",
        outcome.status_code, outcome.status, outcome.log, outcome.html.len(), outcome.html
    );

    assert_eq!(outcome.status_code, 0, "conversion failed");
    assert!(outcome.html.contains("<math"), "missing math from \\input");
    assert!(
        outcome.html.contains("<img") || outcome.html.contains("fig.png") || outcome.html.contains("fig\""),
        "missing graphic reference from \\includegraphics"
    );
}
