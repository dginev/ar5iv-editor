use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::Instant;

use ar5iv_editor_protocol::{
    ConvertRequest, ConvertResponse, Diagnostic, Severity, Timings,
};
use latexml::converter::Converter as OxideConverter;
use latexml::post::{PostOptions, run_post_processing};
use latexml_core::common::{Config as OxideConfig, DataSize, OutputFormat};
use tokio::sync::oneshot;
use tracing::error;

use crate::session::Session;

/// One conversion job: the WS request plus the session it ran inside,
/// plus a oneshot for the response.
type Job = (ConvertRequest, Arc<Session>, oneshot::Sender<ConvertResponse>);

pub struct Converter {
    tx: std_mpsc::Sender<Job>,
}

impl Converter {
    pub fn new(_max_in_flight: usize) -> Self {
        // `_max_in_flight` is ignored: the latexml-oxide engine relies on
        // process-wide globals, TLS state, and `Rc<...>` graphs, so it must
        // run on exactly one dedicated thread. Concurrent requests are
        // serialised through the channel.
        let (tx, rx) = std_mpsc::channel::<Job>();

        // Match `latexml_oxide`'s binary: 256 MB stack to absorb deep math /
        // post-processing recursion that would overflow the OS default 8 MB
        // (and the Tokio blocking-pool default of ~3 MB).
        std::thread::Builder::new()
            .name("latexml-oxide-worker".into())
            .stack_size(256 * 1024 * 1024)
            .spawn(move || worker_main(rx))
            .expect("spawn latexml-oxide worker thread");

        Self { tx }
    }

    pub async fn convert(&self, req: ConvertRequest, session: Arc<Session>) -> ConvertResponse {
        let id = req.id;
        let (resp_tx, resp_rx) = oneshot::channel();
        if self.tx.send((req, session, resp_tx)).is_err() {
            return ConvertResponse::fatal(id, "converter worker has died");
        }
        match resp_rx.await {
            Ok(resp) => resp,
            Err(_) => ConvertResponse::fatal(id, "converter worker dropped the response"),
        }
    }
}

fn worker_main(rx: std_mpsc::Receiver<Job>) {
    // Logger is installed in `main.rs` before tracing-subscriber, so the
    // worker thread doesn't need to do anything here. The previous
    // `init_logger()` call always failed at this point because the global
    // logger was already taken, leaving LOG_BUFFER unwired.
    while let Ok((mut req, mut session, mut reply)) = rx.recv() {
        // Skip-stale-on-pull: drain anything already queued behind us and
        // process only the freshest request. Older ones get a cheap
        // "superseded" reply so the WS handler's await still completes;
        // the frontend filters those out by id and status.
        loop {
            match rx.try_recv() {
                Ok((newer_req, newer_session, newer_reply)) => {
                    let stale_id = req.id;
                    let stale_version = req.version;
                    let _ = reply.send(ConvertResponse {
                        id: stale_id,
                        result: String::new(),
                        status: "superseded".into(),
                        status_code: 0,
                        version: stale_version,
                        log: String::new(),
                        timings: None,
                        diagnostics: Vec::new(),
                        sources: Vec::new(),
                    });
                    req = newer_req;
                    session = newer_session;
                    reply = newer_reply;
                }
                Err(_) => break,
            }
        }
        let id = req.id;
        let resp = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            convert_one(req, &session)
        }))
        .unwrap_or_else(|_| {
            error!("latexml-oxide worker panicked while converting id={id}");
            ConvertResponse::fatal(id, "internal conversion failure (panic)")
        });
        let _ = reply.send(resp);
    }
}

fn convert_one(req: ConvertRequest, session: &Session) -> ConvertResponse {
    let id = req.id;
    let version = req.version;
    let mut whatsin = match req.profile.as_deref().unwrap_or("fragment") {
        "math" => DataSize::Math,
        "document" => DataSize::Document,
        _ => DataSize::Fragment,
    };

    // Resolve the active file inside the session dir. A traversal here
    // would be a client bug, not an attacker — the WS upgrade already
    // bound this connection to the session — but the chokepoint
    // applies uniformly anyway.
    let abs_path = match session.resolve(&req.active_file) {
        Ok(p) => p,
        Err(_) => {
            return ConvertResponse::fatal(
                id,
                format!("invalid active_file: {}", req.active_file),
            );
        }
    };
    // We still read the file ourselves so we can return a sensible
    // 410-equivalent if the session got GC'd under us. The engine
    // also reads it via the path we pass to `converter.convert`
    // below — this duplicate read is cheap (page cache) and gives
    // us the bytes for log/length reporting.
    let tex = match std::fs::read_to_string(&abs_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !session.dir.exists() => {
            return ConvertResponse::session_expired(id);
        }
        Err(e) => {
            return ConvertResponse::fatal(
                id,
                format!("read active_file {}: {e}", req.active_file),
            );
        }
    };

    // ltxmojo (the predecessor) sniffed the input for `\documentclass`
    // and switched its `whatsin` from "fragment" to "document" when
    // the source was a complete LaTeX document. Without this every
    // `\usepackage` and other preamble-only command in the file
    // surfaces as "can only appear in the preamble" errors, because
    // the fragment profile wraps the source in a default preamble +
    // `\begin{document}` before the engine sees the file's own
    // `\usepackage` calls.
    //
    // We promote on the server side rather than asking the frontend
    // to set the right profile: the source of truth is the file
    // itself, and we'd rather not depend on the client knowing the
    // convention.
    if matches!(whatsin, DataSize::Fragment) && contains_documentclass(&tex) {
        whatsin = DataSize::Document;
    }

    let opts = OxideConfig {
        // verbosity 1 = "normal" — emits Info!() messages so the per-request
        // LOG_BUFFER has something for the UI's status-toggle to display.
        verbosity: 1,
        format: OutputFormat::HTML5,
        whatsin: whatsin.clone(),
        whatsout: whatsin,
        preamble: req.preamble.clone(),
        postamble: None,
        mode: None,
        bindings_dispatch: None,
        extra_bindings_dispatch: None,
        preload: if req.preload.is_empty() {
            None
        } else {
            Some(req.preload.clone())
        },
        // The headline of Phase 0: search_paths set to the session dir
        // is what makes `\input{chapter1}` and `\includegraphics{fig}`
        // resolve to files the user has uploaded.
        search_paths: Some(vec![session.dir.to_string_lossy().into_owned()]),
        include_comments: Some(false),
        nomathparse: None,
        // Always on for the editor: the whole point of this backend is the
        // live source↔preview sync, which rides the `data-sourcepos`
        // attributes this stamps. The tag→file decoder is read back from the
        // engine below (out-of-band, never inlined into the HTML).
        source_map: Some(true),
    };

    let t_total = Instant::now();
    let t0 = Instant::now();
    let converter = OxideConverter::from_config(opts);
    let dt_build = t0.elapsed();

    let t1 = Instant::now();
    // Pass the absolute file path (not `literal:<contents>`) so the
    // engine sets `\jobname` to the file stem. That lets bibliography
    // post-processing find `<jobname>.bbl` automatically — which is
    // how every real LaTeX paper carries its compiled bibliography.
    // The engine's own file load redoes the read we did above
    // for tex.len() reporting; the OS page cache makes this free.
    let resp = converter.convert(abs_path.to_string_lossy().into_owned());
    let dt_convert = t1.elapsed();

    // Source-map decoder: read this conversion's `tag → file` table straight
    // from the engine's thread-local state. `Core::new` resets it on every
    // `from_config`, so this is exactly *this* request's table — no stale
    // entries from a prior conversion (or a prior user, on this shared
    // worker). Basenames only: the table must not carry absolute
    // session-tmpdir paths off the box (anonymity + no path leak).
    let sources: Vec<String> = latexml_core::state::source_table_snapshot()
        .iter()
        .map(|sym| latexml_core::common::arena::with(*sym, path_basename))
        .collect();

    let xml = match resp.result {
        Some(x) => x,
        None => {
            let diagnostics = parse_diagnostics(&resp.log);
            return ConvertResponse {
                id,
                result: String::new(),
                status: resp.status,
                status_code: resp.status_code as i32,
                version,
                log: resp.log,
                timings: None,
                diagnostics,
                sources,
            };
        }
    };

    // `destination` is a synthetic path inside the session dir.
    // The post-processor never actually writes to it, but the
    // Graphics processor uses the destination's parent as the
    // directory it writes converted PNGs into. Pointing it at the
    // session dir means a `\includegraphics{paper.pdf}` lands its
    // rasterized PNG right next to the original PDF, and the
    // file routes serve it back as `/api/session/{id}/files/x1.png`
    // (or whatever resource name the processor picks).
    let dest_path = session.dir.join("__preview.html");
    let dest_str = dest_path.to_string_lossy().into_owned();
    let session_dir_str = session.dir.to_string_lossy().into_owned();
    let post_opts = PostOptions {
        pmml: true,
        cmml: false,
        keep_xmath: false,
        stylesheet: Some("resources/XSLT/LaTeXML-html5.xsl"),
        destination: Some(&dest_str),
        // Set `source_directory` to the session dir so the Graphics
        // post-processor can find user-uploaded files (e.g.
        // `preprint_inset.pdf`) and rasterize them to PNG. Without
        // this, Graphics' search-path list is empty and it skips
        // conversion silently. The engine then emits the bare
        // `<img src="preprint_inset">` from `\includegraphics{...}`,
        // which the browser can't render.
        //
        // The trade-off: with source_directory set, the engine emits
        // *relative* `<img src=...>` paths instead of absolute ones.
        // `rewrite_session_paths` below handles both — absolute
        // paths under session.dir AND relative paths — by mapping
        // them to `/api/session/{id}/files/<rel>` URLs the browser
        // can fetch.
        source_directory: Some(&session_dir_str),
        nodefaultresources: true,
        css_files: &[],
        js_files: &[],
        noinvisibletimes: false,
        mathtex: false,
        navigationtoc: None,
        split: false,
        split_xpath: None,
        split_naming: None,
        xslt_parameters: &[],
        graphics_svg_threshold_kb: 0,
        schemadocs: false,
        whatsout: latexml_post::extract::Whatsout::Document,
    };
    let t2 = Instant::now();
    let html_raw = run_post_processing(&xml, &post_opts);
    let dt_post = t2.elapsed();

    // Phase 0 finding: the post-processed HTML carries `<img src=...>`
    // with the absolute path `<session_dir>/<rel>`. Two problems:
    // (1) the browser can't fetch a server-side fs path; (2) the path
    // leaks the session dir layout into the page. Rewrite to the
    // file-route URL the browser *can* fetch.
    let html = rewrite_session_paths(&html_raw, &session.dir, &session.id.to_string());
    let diagnostics = parse_diagnostics(&resp.log);

    let dt_total = t_total.elapsed();
    eprintln!(
        "[convert id={}] build={} µs  convert={} ms  post={} ms  total={} ms  tex={} B  out={} B",
        id,
        dt_build.as_micros(),
        dt_convert.as_millis(),
        dt_post.as_millis(),
        dt_total.as_millis(),
        tex.len(),
        html.len(),
    );

    ConvertResponse {
        id,
        result: html,
        status: resp.status,
        status_code: resp.status_code as i32,
        version,
        log: resp.log,
        timings: Some(Timings {
            build_us: dt_build.as_micros() as u64,
            convert_ms: dt_convert.as_millis() as u64,
            post_ms: dt_post.as_millis() as u64,
            total_ms: dt_total.as_millis() as u64,
        }),
        diagnostics,
        sources,
    }
}

/// The final path component of a recorded source identity, lowercased for
/// case-insensitive `active_file` matching client-side. Keeps absolute
/// session-tmpdir paths from leaving the box in the WS envelope (the engine
/// records the path it was handed; the editor only needs the file's name).
fn path_basename(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_ascii_lowercase()
}

/// Parse the engine's captured log buffer into structured
/// diagnostics. The format the LatexmlLogger writes is:
///
/// ```text
/// {Severity}:{Category}:{Object} {message-first-line}
/// \tat {source}; line N col M[ - line N col M]
/// \t[detail line(s)]
/// \tIn {rust_file}:{rust_line}:{rust_column}
/// ```
///
/// Continuation lines start with a tab; record boundaries start at
/// column 0 with a known severity prefix. We collect each record's
/// severity / category / first-line / location and surface them on
/// the convert response so the frontend can attach them to editor
/// lines.
pub fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut current: Option<Diagnostic> = None;

    for line in log.lines() {
        if let Some((sev, rest)) = split_severity(line) {
            // Flush any in-flight diagnostic.
            if let Some(d) = current.take() {
                out.push(d);
            }
            // `rest` looks like "{Category}:{Object} {message…}". Split
            // on the first space to separate the header tag from the
            // human-facing message.
            let (header, message) = match rest.find(' ') {
                Some(i) => (rest[..i].to_string(), rest[i + 1..].to_string()),
                None => (rest.to_string(), String::new()),
            };
            current = Some(Diagnostic {
                severity: sev,
                category: header,
                message,
                source: None,
                from_line: None,
                from_col: None,
                to_line: None,
                to_col: None,
            });
            continue;
        }

        // Continuation lines start with a tab.
        if let Some(rest) = line.strip_prefix('\t')
            && let Some(diag) = current.as_mut()
        {
            // The "In file:line:col" line is internal Rust loc — skip.
            if rest.starts_with("In ") {
                continue;
            }
            if let Some(loc) = rest.strip_prefix("at ") {
                fill_location(diag, loc);
                continue;
            }
            // Generic detail line — append to message if not already
            // verbose.
            if !rest.is_empty() {
                if !diag.message.is_empty() {
                    diag.message.push('\n');
                }
                diag.message.push_str(rest);
            }
        }
    }

    if let Some(d) = current.take() {
        out.push(d);
    }
    out
}

fn split_severity(line: &str) -> Option<(Severity, &str)> {
    for (prefix, sev) in [
        ("Fatal:", Severity::Fatal),
        ("Error:", Severity::Error),
        ("Warn:", Severity::Warning),
        ("Info:", Severity::Info),
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some((sev, rest));
        }
    }
    None
}

/// Parse the `at <source>; line N col M [- line N col M]` payload.
fn fill_location(diag: &mut Diagnostic, loc: &str) {
    // Split off the source via the first `; ` — earlier semicolons
    // could appear in pathological filenames, but the engine's
    // `Locator::Display` always uses exactly that separator.
    let (source, rest) = match loc.find(';') {
        Some(i) => (loc[..i].trim().to_string(), &loc[i + 1..]),
        None => (loc.trim().to_string(), ""),
    };
    diag.source = Some(source);

    // Parse "line N[ col M]" segments. The locator can render either
    // a single position or a range "line A col B - line C col D".
    let mut segments = rest.split('-').map(str::trim);
    if let Some(from) = segments.next() {
        let (l, c) = parse_line_col(from);
        diag.from_line = l;
        diag.from_col = c;
    }
    if let Some(to) = segments.next() {
        let (l, c) = parse_line_col(to);
        diag.to_line = l;
        diag.to_col = c;
    }
}

fn parse_line_col(seg: &str) -> (Option<u32>, Option<u32>) {
    // "line N col M"  or  "line N"
    let mut line = None;
    let mut col = None;
    let mut tokens = seg.split_ascii_whitespace().peekable();
    while let Some(tok) = tokens.next() {
        match tok {
            "line" => line = tokens.next().and_then(|n| n.parse().ok()),
            "col"  => col = tokens.next().and_then(|n| n.parse().ok()),
            _ => {}
        }
    }
    (line, col)
}

/// Lightweight check for `\documentclass{...}` in a TeX source. Skips
/// commented-out lines (a `%` before `\documentclass` on the same
/// line). Used by `convert_one` to auto-promote `whatsin: Fragment`
/// to `whatsin: Document` when the file is a complete LaTeX doc.
fn contains_documentclass(tex: &str) -> bool {
    for line in tex.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('%') {
            continue;
        }
        // Same-line `%` before `\documentclass` means the directive
        // is commented out. Cheap split-and-check.
        if let Some(idx) = trimmed.find("\\documentclass") {
            let prefix = &trimmed[..idx];
            // A `%` in the prefix that isn't escaped (`\%`) comments out
            // the rest of the line — skip.
            if has_unescaped_percent(prefix) {
                continue;
            }
            return true;
        }
    }
    false
}

fn has_unescaped_percent(s: &str) -> bool {
    let mut prev_was_backslash = false;
    for c in s.chars() {
        if c == '%' && !prev_was_backslash {
            return true;
        }
        prev_was_backslash = c == '\\' && !prev_was_backslash;
    }
    false
}

/// Rewrite `src="..."` and `href="..."` attributes in the post-
/// processed HTML so the browser can fetch session-local files via
/// our file route. Two rewrite cases:
///
///  1. Absolute path under `session_dir`. Maps
///     `src="<session_dir>/foo.png"` → `src="/api/session/<id>/files/foo.png"`.
///     This handles graphics emitted *without* `source_directory`
///     set on the post-processor (defence-in-depth; v0.2.0
///     historically went down this path).
///
///  2. Relative path that doesn't start with `/`, `http`, `data:`,
///     or `#`. These come from the post-processor when
///     `source_directory` is set (the modern path), e.g.
///     `src="x1.png"` for a rasterized PDF. Maps
///     `src="x1.png"` → `src="/api/session/<id>/files/x1.png"`.
///     Skips data URIs (the LaTeXML logo is base64-inlined),
///     fragment-only refs (`#sec1`), absolute URLs.
///
/// Only `src` and `href` get rewritten — other attributes might
/// legitimately carry strings that look like paths but aren't.
fn rewrite_session_paths(html: &str, session_dir: &std::path::Path, session_id: &str) -> String {
    let prefix = match session_dir.to_str() {
        Some(s) => s,
        None => return html.to_string(),
    };

    let prefix_url = format!("/api/session/{session_id}/files/");
    let attr_re = regex::Regex::new(
        r#"\s(src|href)="([^"]*)""#,
    )
    .unwrap();

    attr_re
        .replace_all(html, |caps: &regex::Captures| {
            let attr = &caps[1];
            let val = &caps[2];

            // Case 1: absolute path under session_dir.
            if let Some(rest) = val.strip_prefix(prefix) {
                let rel = rest.trim_start_matches('/');
                return format!(r#" {attr}="{prefix_url}{rel}""#);
            }

            // Skip protocol-y, fragment, data, anchor-only,
            // root-absolute non-API URLs. Anything left is a
            // relative path the browser would resolve against
            // `/editor` — we want it pointed at the file route.
            if val.is_empty()
                || val.starts_with("data:")
                || val.starts_with('#')
                || val.starts_with('/')
                || val.starts_with("http://")
                || val.starts_with("https://")
                || val.starts_with("mailto:")
                || val.starts_with("ftp://")
                || val.starts_with("file:")
            {
                return caps[0].to_string();
            }

            // Only rewrite `src` (graphics) by default. `href`
            // relative refs are usually intra-document anchors
            // emitted by the XSLT, which the browser can resolve
            // against `/editor` correctly.
            if attr != "src" {
                return caps[0].to_string();
            }

            format!(r#" {attr}="{prefix_url}{val}""#)
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, AtomicU64};

    use crate::session::{SessionId, Slot, Token, UserId};

    fn make_test_session(dir: PathBuf) -> Arc<Session> {
        Arc::new(Session {
            id:            SessionId::new(),
            user_id:       UserId::new(),
            slot:          Slot::Blank,
            dir,
            disk_token:    Token::new(),
            last_activity: AtomicU64::new(0),
            bytes_used:    AtomicU64::new(0),
            file_count:    AtomicU32::new(0),
            version:       AtomicU64::new(0),
            last_html:     Mutex::new(None),
            main_entry:    Mutex::new(None),
        })
    }

    #[test]
    fn parses_a_synthetic_undefined_macro_log() {
        // Synthetic — no engine boot. The shape mirrors what
        // `LatexmlLogger` writes per record. We cover both the
        // single-position locator and the range form.
        let log = "\
Error:Undefined:\\foo Undefined control sequence \\foo\n\
\tat Anonymous String; line 1 col 12\n\
\tdetail line one\n\
\tIn gullet.rs:201:13\n\
Warn:Recovery:something Patched up after the error\n\
\tat Anonymous String; line 4 col 7 - line 4 col 21\n\
\tIn gullet.rs:309:5\n";
        let diags = parse_diagnostics(log);
        assert_eq!(diags.len(), 2, "got: {diags:#?}");
        assert!(matches!(diags[0].severity, Severity::Error));
        assert_eq!(diags[0].category, "Undefined:\\foo");
        assert_eq!(diags[0].source.as_deref(), Some("Anonymous String"));
        assert_eq!(diags[0].from_line, Some(1));
        assert_eq!(diags[0].from_col, Some(12));
        assert_eq!(diags[0].to_line, None);
        assert!(matches!(diags[1].severity, Severity::Warning));
        assert_eq!(diags[1].from_line, Some(4));
        assert_eq!(diags[1].from_col, Some(7));
        assert_eq!(diags[1].to_line, Some(4));
        assert_eq!(diags[1].to_col, Some(21));
    }

    #[tokio::test]
    async fn parses_two_undefined_macros_from_real_engine_run() {
        // The latexml-oxide logger has to own the global `log` slot
        // for `bind_log` / `flush_log` to capture anything; in
        // production this happens in `main.rs`. Initialise it
        // best-effort here (the production binary may already have
        // claimed the slot under cargo test's shared logger; in that
        // case `init` returns Err and we just continue).
        let _ = latexml_core::util::logger::init(log::LevelFilter::Info);

        // Fixture as given by the user. Two undefined macros
        // separated by blank lines so the line-numbering can be
        // visually verified: `\foo` on line 1, `\also` on line 4.
        let dir = tempfile::tempdir().unwrap();
        let session = make_test_session(dir.path().to_path_buf());
        std::fs::write(
            dir.path().join("main.tex"),
            "This is undefined \\foo done.\n\n\n This \\also undefined.",
        )
        .unwrap();

        let c = Converter::new(1);
        let resp = c
            .convert(
                ConvertRequest {
                    id: 99,
                    active_file: "main.tex".into(),
                    version: 1,
                    preamble: None,
                    profile: Some("fragment".into()),
                    format: Some("html5".into()),
                    preload: vec![],
                },
                session,
            )
            .await;
        eprintln!(
            "[diag-test] status={:?} status_code={} diagnostics={:#?}\n--- log ---\n{}",
            resp.status, resp.status_code, resp.diagnostics, resp.log,
        );

        // The engine emits the undefined-macro errors with category
        // `undefined:\foo` / `undefined:\also` (lowercase `undefined`,
        // see `state.rs:1084`). For this particular code path the
        // locator returns `Locator::default()` — TeX line/col are
        // currently unset upstream. So we assert on:
        //   (1) both errors are surfaced to the wire,
        //   (2) the parser correctly attributes them to the right
        //       macro names,
        //   (3) the (potentially unanchored) source string is what
        //       the engine actually emits.
        // When latexml-oxide grows locator coverage for this path,
        // the same diagnostics will start carrying `from_line` and
        // the frontend's gutter-marker code will pick them up
        // automatically.
        let undef: Vec<_> = resp
            .diagnostics
            .iter()
            .filter(|d| d.category.starts_with("undefined:"))
            .collect();
        assert!(
            undef.len() >= 2,
            "expected >= 2 undefined diagnostics, got {undef:#?}"
        );
        let foo = undef
            .iter()
            .find(|d| d.category.contains("\\foo"))
            .expect("undefined:\\foo not seen");
        assert!(matches!(foo.severity, Severity::Error));
        let also = undef
            .iter()
            .find(|d| d.category.contains("\\also"))
            .expect("undefined:\\also not seen");
        assert!(matches!(also.severity, Severity::Error));
    }

    #[test]
    fn documentclass_detector_handles_common_cases() {
        // Bare body — no \documentclass.
        assert!(!contains_documentclass(r"Hello \(x^2\)."));
        // Standard preamble.
        assert!(contains_documentclass(
            "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}"
        ));
        // Indented (blank lines / tabs before).
        assert!(contains_documentclass(
            "\n\n  \\documentclass[12pt]{article}\n"
        ));
        // Commented-out line should NOT count.
        assert!(!contains_documentclass(
            "% \\documentclass{article}\nbody only"
        ));
        // Same-line % before \documentclass — also commented out.
        assert!(!contains_documentclass(
            "stuff % then \\documentclass{article}\n"
        ));
        // Escaped \% before \documentclass — the directive is real.
        assert!(contains_documentclass(
            "stuff \\% then \\documentclass{article}\n"
        ));
    }

    #[test]
    fn rewrite_substitutes_session_paths() {
        let html = r#"<img src="/tmp/sess123/fig.png"> and <a href="/tmp/sess123/sub/a.tex">a</a>"#;
        let out = rewrite_session_paths(html, std::path::Path::new("/tmp/sess123"), "SID");
        assert!(out.contains("/api/session/SID/files/fig.png"));
        assert!(out.contains("/api/session/SID/files/sub/a.tex"));
        assert!(!out.contains("/tmp/sess123"));
    }

    #[test]
    fn rewrite_leaves_unrelated_paths_alone() {
        let html = r#"<img src="data:image/png;base64,iVBOR"> <img src="/elsewhere/x.png">"#;
        let out = rewrite_session_paths(html, std::path::Path::new("/tmp/sess123"), "SID");
        assert_eq!(out, html);
    }

    #[tokio::test]
    async fn round_trips_a_math_fragment() {
        let dir = tempfile::tempdir().unwrap();
        let session = make_test_session(dir.path().to_path_buf());
        std::fs::write(dir.path().join("main.tex"), r"\(x^2 + y^2 = z^2\)").unwrap();

        let c = Converter::new(1);
        let resp = c
            .convert(
                ConvertRequest {
                    id: 7,
                    active_file: "main.tex".into(),
                    version: 1,
                    preamble: None,
                    profile: Some("fragment".into()),
                    format: Some("html5".into()),
                    preload: vec![],
                },
                session,
            )
            .await;
        assert_eq!(resp.id, 7);
        assert_eq!(resp.version, 1);
        assert_eq!(
            resp.status_code, 0,
            "conversion failed (status={:?}, log={:?})",
            resp.status, resp.log
        );
        assert!(
            resp.result.contains("<math"),
            "expected MathML in result, got: {}",
            resp.result
        );
    }

    /// Run a few real conversions back-to-back and print wall-clock
    /// numbers per phase. Use:
    ///
    ///     cargo test -p ar5iv-editor-server --lib convert::tests::measure_pipeline -- --nocapture --ignored
    #[tokio::test]
    #[ignore]
    async fn measure_pipeline() {
        let preload: Vec<String> = [
            "LaTeX.pool",
            "article.cls",
            "amsmath.sty",
            "amsthm.sty",
            "amstext.sty",
            "amssymb.sty",
            "eucal.sty",
            "[dvipsnames]xcolor.sty",
            "url.sty",
            "hyperref.sty",
            "[ids,mathlexemes]latexml.sty",
        ]
        .into_iter()
        .map(String::from)
        .collect();

        let inputs = [
            ("Pythagoras", r"\(a^2 + b^2 = c^2\)"),
            ("Quadratic", r"\[ x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a} \]"),
            (
                "Maxwell",
                r"\[\begin{aligned}
                    \nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
                    \nabla \cdot \mathbf{B} &= 0
                  \end{aligned}\]",
            ),
        ];

        let dir = tempfile::tempdir().unwrap();
        let session = make_test_session(dir.path().to_path_buf());

        let t_boot = Instant::now();
        let c = Converter::new(1);
        eprintln!("[boot] worker spawn = {} µs", t_boot.elapsed().as_micros());

        for (i, (label, tex)) in inputs.iter().enumerate() {
            let path = format!("doc{i}.tex");
            std::fs::write(dir.path().join(&path), tex).unwrap();
            let t = Instant::now();
            let resp = c
                .convert(
                    ConvertRequest {
                        id: i as u64,
                        active_file: path,
                        version: i as u64,
                        preamble: None,
                        profile: Some("fragment".into()),
                        format: Some("html5".into()),
                        preload: preload.clone(),
                    },
                    session.clone(),
                )
                .await;
            let dt = t.elapsed();
            eprintln!(
                "[{:>2}] {:>10} status={} total={:>5} ms  tex={} B  out={} B",
                i,
                label,
                resp.status_code,
                dt.as_millis(),
                tex.len(),
                resp.result.len()
            );
        }

        let _ = Token::new(); // keep `Token` referenced
    }
}
