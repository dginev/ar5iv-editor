use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::Instant;

use ar5iv_editor_protocol::{ConvertRequest, ConvertResponse, Timings};
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
    let whatsin = match req.profile.as_deref().unwrap_or("fragment") {
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
    let tex = match std::fs::read_to_string(&abs_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !session.dir.exists() => {
            // The session was GC'd under us. Tell the client to reopen
            // the slot rather than waste a fatal.
            return ConvertResponse::session_expired(id);
        }
        Err(e) => {
            return ConvertResponse::fatal(
                id,
                format!("read active_file {}: {e}", req.active_file),
            );
        }
    };

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
    };

    let t_total = Instant::now();
    let t0 = Instant::now();
    let converter = OxideConverter::from_config(opts);
    let dt_build = t0.elapsed();

    let t1 = Instant::now();
    let resp = converter.convert(format!("literal:{}", tex));
    let dt_convert = t1.elapsed();

    let xml = match resp.result {
        Some(x) => x,
        None => {
            return ConvertResponse {
                id,
                result: String::new(),
                status: resp.status,
                status_code: resp.status_code as i32,
                version,
                log: resp.log,
                timings: None,
            };
        }
    };

    let post_opts = PostOptions {
        pmml: true,
        cmml: false,
        keep_xmath: false,
        stylesheet: Some("resources/XSLT/LaTeXML-html5.xsl"),
        destination: None,
        // We deliberately leave `source_directory` unset so the
        // engine emits absolute paths in `<img src=...>`. Our
        // `rewrite_session_paths` step below maps those absolute
        // paths to `/api/session/{id}/files/<rel>`. Setting
        // `source_directory` would make the engine emit relative
        // paths (`<img src="fig.png">`) which the browser would
        // resolve against `/editor` — wrong for our routing.
        source_directory: None,
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
    }
}

/// Rewrite any `src="..."` or `href="..."` whose path lives under
/// `session_dir` to `/api/session/{session_id}/files/<relative>`. The
/// search runs over the raw HTML string; we don't need a real parser
/// because the post-processor's output uses double-quoted attributes
/// and absolute file paths only when the engine resolved a graphic
/// (or similar) under our search_paths.
fn rewrite_session_paths(html: &str, session_dir: &std::path::Path, session_id: &str) -> String {
    let prefix = match session_dir.to_str() {
        Some(s) => s,
        None => return html.to_string(),
    };
    // For each occurrence of the absolute prefix in a quoted attribute,
    // replace with the file-route URL. Reuse a single allocation; the
    // happy path doesn't trigger any rewrite at all.
    if !html.contains(prefix) {
        return html.to_string();
    }

    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    let pattern = format!("\"{prefix}");
    while let Some(off) = html[cursor..].find(&pattern) {
        let abs_start = cursor + off + 1; // skip the `"`
        out.push_str(&html[cursor..abs_start]);
        let after_prefix = abs_start + prefix.len();
        // Find the closing quote.
        let close = match html[after_prefix..].find('"') {
            Some(i) => after_prefix + i,
            None => {
                out.push_str(&html[abs_start..]);
                cursor = html.len();
                break;
            }
        };
        let rel_with_lead = &html[after_prefix..close];
        let rel = rel_with_lead.trim_start_matches('/');
        out.push_str(&format!("/api/session/{session_id}/files/{rel}"));
        cursor = close;
    }
    out.push_str(&html[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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
        })
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
