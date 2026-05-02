use ar5iv_editor_protocol::{ConvertRequest, ConvertResponse};
use latexml::converter::Converter as OxideConverter;
use latexml::post::{PostOptions, run_post_processing};
use latexml_core::common::{Config as OxideConfig, DataSize, OutputFormat};
use std::sync::OnceLock;
use std::sync::mpsc as std_mpsc;
use std::time::Instant;
use tokio::sync::oneshot;
use tracing::{error, warn};

type Job = (ConvertRequest, oneshot::Sender<ConvertResponse>);

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

    pub async fn convert(&self, req: ConvertRequest) -> ConvertResponse {
        let id = req.id;
        let (resp_tx, resp_rx) = oneshot::channel();
        if self.tx.send((req, resp_tx)).is_err() {
            return ConvertResponse::fatal(id, "converter worker has died");
        }
        match resp_rx.await {
            Ok(resp) => resp,
            Err(_) => ConvertResponse::fatal(id, "converter worker dropped the response"),
        }
    }
}

fn worker_main(rx: std_mpsc::Receiver<Job>) {
    init_logger();
    while let Ok((mut req, mut reply)) = rx.recv() {
        // Skip-stale-on-pull: drain anything already queued behind us and
        // process only the freshest request. Older ones get a cheap
        // "superseded" reply so the WS handler's await still completes;
        // the frontend filters those out by id and status.
        loop {
            match rx.try_recv() {
                Ok((newer_req, newer_reply)) => {
                    let stale_id = req.id;
                    let _ = reply.send(ConvertResponse {
                        id: stale_id,
                        result: String::new(),
                        status: "superseded".into(),
                        status_code: 0,
                        log: String::new(),
                    });
                    req = newer_req;
                    reply = newer_reply;
                }
                Err(_) => break,
            }
        }
        let id = req.id;
        let resp =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| convert_one(req)))
                .unwrap_or_else(|_| {
                    error!("latexml-oxide worker panicked while converting id={id}");
                    ConvertResponse::fatal(id, "internal conversion failure (panic)")
                });
        let _ = reply.send(resp);
    }
}

fn init_logger() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        // latexml-oxide has its own `log`-crate logger; install at Warn so
        // stderr stays quiet under tracing-subscriber.
        if let Err(e) = latexml_core::util::logger::init(log::LevelFilter::Warn) {
            warn!(error = %e, "latexml-oxide logger init failed");
        }
    });
}

fn convert_one(req: ConvertRequest) -> ConvertResponse {
    let id = req.id;
    let whatsin = match req.profile.as_deref().unwrap_or("fragment") {
        "math" => DataSize::Math,
        "document" => DataSize::Document,
        _ => DataSize::Fragment, // "fragment" and any unknown profile
    };

    let opts = OxideConfig {
        verbosity: -1,
        format: OutputFormat::HTML5,
        whatsin: whatsin.clone(),
        whatsout: whatsin,
        preamble: req.preamble.clone(),
        postamble: None,
        mode: None,
        bindings_dispatch: None, // converter overrides with latexml_package::dispatch
        extra_bindings_dispatch: None,
        preload: if req.preload.is_empty() {
            None
        } else {
            Some(req.preload.clone())
        },
        search_paths: None,
        include_comments: Some(false),
        nomathparse: None,
    };

    let t_total = Instant::now();
    let t0 = Instant::now();
    let converter = OxideConverter::from_config(opts);
    let dt_build = t0.elapsed();

    let t1 = Instant::now();
    // `convert` consumes the converter; it lazily initialises the session
    // (TeX.pool + bindings) on first use, applies the configured preamble /
    // postamble around the source, then digests + builds the document.
    let resp = converter.convert(format!("literal:{}", req.tex));
    let dt_convert = t1.elapsed();

    let xml = match resp.result {
        Some(x) => x,
        None => {
            return ConvertResponse {
                id,
                result: String::new(),
                status: resp.status,
                status_code: resp.status_code as i32,
                log: resp.log,
            };
        }
    };

    // Post-processing: emit Presentation MathML and run the bundled HTML5
    // XSLT so the result is a real HTML5 document the browser can morph
    // into the preview pane. The stylesheets are `include_str!`d into
    // `latexml_post`, so the path string is just a key, not a real file.
    let post_opts = PostOptions {
        pmml: true,
        cmml: false,
        keep_xmath: false,
        stylesheet: Some("resources/XSLT/LaTeXML-html5.xsl"),
        destination: None,
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
    let html = run_post_processing(&xml, &post_opts);
    let dt_post = t2.elapsed();
    let dt_total = t_total.elapsed();
    eprintln!(
        "[convert id={}] build={} µs  convert={} ms  post={} ms  total={} ms  tex={} B  out={} B",
        id,
        dt_build.as_micros(),
        dt_convert.as_millis(),
        dt_post.as_millis(),
        dt_total.as_millis(),
        req.tex.len(),
        html.len(),
    );

    ConvertResponse {
        id,
        result: html,
        status: resp.status,
        status_code: resp.status_code as i32,
        log: resp.log,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test]
    async fn round_trips_a_math_fragment() {
        let c = Converter::new(1);
        let resp = c
            .convert(ConvertRequest {
                id: 7,
                tex: "\\(x^2 + y^2 = z^2\\)".into(),
                preamble: None,
                profile: Some("fragment".into()),
                format: Some("html5".into()),
                preload: vec![],
            })
            .await;
        assert_eq!(resp.id, 7);
        assert_eq!(
            resp.status_code, 0,
            "conversion failed (status={:?}, log={:?})", resp.status, resp.log
        );
        assert!(
            resp.result.contains("<math"),
            "expected MathML in result, got: {}", resp.result
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

        let t_boot = Instant::now();
        let c = Converter::new(1);
        eprintln!(
            "[boot] worker spawn = {} µs",
            t_boot.elapsed().as_micros()
        );

        for (i, (label, tex)) in inputs.iter().enumerate() {
            let t = Instant::now();
            let resp = c
                .convert(ConvertRequest {
                    id: i as u64,
                    tex: (*tex).into(),
                    preamble: None,
                    profile: Some("fragment".into()),
                    format: Some("html5".into()),
                    preload: preload.clone(),
                })
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
    }
}
