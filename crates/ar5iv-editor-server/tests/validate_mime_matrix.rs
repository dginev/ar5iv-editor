//! MIME-driven schema selection on `POST /api/validate`.
//!
//! Three supported document formats, each with its own MIME type and
//! validation schema (served as presets by the vnu service):
//!
//! | MIME type                  | schema                          |
//! |----------------------------|---------------------------------|
//! | `text/html`                | LaTeXML scholarly HTML5 profile |
//! | `application/latexml+xml`  | LaTeXML XML document schema     |
//! | `application/mathml+xml`   | MathML 4 Core                   |
//!
//! The 3×3 matrix below posts one *valid* example of each format
//! under each of the three MIME types: every example must validate
//! clean under its own type and produce errors under the other two.
//! A missing Content-Type defaults to HTML5; an unsupported one is a
//! 415.
//!
//! Needs a live vnu service — gated on `AR5IV_TEST_VALIDATOR_URL`
//! (e.g. `http://127.0.0.1:8899` with
//! `java -cp validator/build/dist/vnu.jar nu.validator.servlet.Main 8899`
//! running from the submodule's jar). Without it the test skips.

use std::sync::Arc;
use std::time::Duration;

use ar5iv_editor::{
    AppState, config::SessionConfig, convert::Converter, examples::ExampleCatalog, router,
    session::SessionRegistry,
};
use serde_json::Value;
use tempfile::TempDir;
use tokio::net::TcpListener;

/// Minimal LaTeXML scholarly HTML5 page shell — the release-smoke
/// document, validated clean against the scholarly profile.
const HTML5_EXAMPLE: &str = r#"<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>s</title></head><body class="ltx_page_root"><div class="ltx_page_main"><div class="ltx_page_content"><article class="ltx_document"></article></div><footer class="ltx_page_footer"></footer></div></body></html>"#;

/// `latexml_oxide --format=xml` output for a one-paragraph article
/// (engine @1a97514349) — valid against the LaTeXML document schema.
const LATEXML_EXAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<?latexml class="article"?>
<?latexml RelaxNGSchema="LaTeXML"?>
<document xmlns="http://dlmf.nist.gov/LaTeXML" class="ltx_authors_1line">
  <resource src="LaTeXML.css" type="text/css"/>
  <resource src="ltx-article.css" type="text/css"/>
  <title>Sample</title>
  <para xml:id="p1">
    <p>A tiny <text font="bold">document</text> with math: <Math mode="inline" tex="x^{2}+1" text="x ^ 2 + 1" xml:id="p1.m1">
        <XMath>
          <XMApp>
            <XMTok meaning="plus" role="ADDOP">+</XMTok>
            <XMApp>
              <XMTok role="SUPERSCRIPTOP" scriptpos="post1"/>
              <XMTok font="italic" role="UNKNOWN">x</XMTok>
              <XMTok fontsize="70%" meaning="2" role="NUMBER">2</XMTok>
            </XMApp>
            <XMTok meaning="1" role="NUMBER">1</XMTok>
          </XMApp>
        </XMath>
      </Math>.</p>
  </para>
</document>
"#;

/// Minimal MathML Core fragment (math as document root).
const MATHML_EXAMPLE: &str = r#"<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></math>"#;

const MIME_HTML5: &str = "text/html; charset=utf-8";
const MIME_LATEXML: &str = "application/latexml+xml";
const MIME_MATHML: &str = "application/mathml+xml";

struct TestRig {
    base:     String,
    client:   reqwest::Client,
    _server:  tokio::task::JoinHandle<()>,
    _tempdir: TempDir,
}

impl TestRig {
    async fn boot() -> Self {
        let temp = TempDir::new().unwrap();
        // Sessions are irrelevant here (the validate route is
        // stateless); the registry just needs a sane config.
        let cfg = SessionConfig {
            sessions_dir:            temp.path().to_path_buf(),
            idle_timeout:            Duration::from_secs(600),
            gc_interval:             Duration::from_secs(60),
            quota_session_bytes:     1024 * 1024,
            quota_session_files:     50,
            quota_upload_bytes:      256 * 1024,
            quota_archive_bytes:     1024 * 1024,
            quota_root_bytes:        100 * 1024 * 1024,
            quota_sessions_per_user: 3,
            quota_users_per_ip:      4,
        };
        let state = AppState {
            converter: Arc::new(Converter::new(1, None)),
            sessions: Arc::new(SessionRegistry::new(cfg)),
            examples: Arc::new(ExampleCatalog::load().expect("examples manifest")),
            vscode_web_dir: Arc::new(std::path::PathBuf::from("vscode-web")),
            vscode_ext_dir: Arc::new(std::path::PathBuf::from("vscode-extension")),
        };
        let app = router(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        TestRig {
            base: format!("http://{addr}"),
            client: reqwest::Client::new(),
            _server: server,
            _tempdir: temp,
        }
    }

    /// POST a document, return (status, error-message count).
    async fn validate(&self, doc: &str, mime: Option<&str>) -> (u16, usize) {
        let mut req = self
            .client
            .post(format!("{}/api/validate", self.base))
            .body(doc.to_string());
        if let Some(mime) = mime {
            req = req.header("content-type", mime);
        }
        let resp = req.send().await.expect("proxy reachable");
        let status = resp.status().as_u16();
        let errors = if status == 200 {
            let v: Value = resp.json().await.expect("vnu JSON report");
            v["messages"]
                .as_array()
                .expect("messages array")
                .iter()
                .filter(|m| m["type"] == "error")
                .count()
        } else {
            usize::MAX
        };
        (status, errors)
    }
}

/// The vnu service is external; skip (with a notice) when not configured.
fn validator_url() -> Option<String> {
    let url = std::env::var("AR5IV_TEST_VALIDATOR_URL").ok()?;
    // The proxy reads AR5IV_EDITOR_VALIDATOR_URL at request time.
    // SAFETY: set before any request is issued; tests in this file are
    // the only consumers in this process.
    unsafe { std::env::set_var("AR5IV_EDITOR_VALIDATOR_URL", &url) };
    Some(url)
}

#[tokio::test]
async fn mime_matrix_3x3() {
    if validator_url().is_none() {
        eprintln!("skipping: set AR5IV_TEST_VALIDATOR_URL to a running vnu service");
        return;
    }
    let rig = TestRig::boot().await;

    let examples = [
        ("html5", HTML5_EXAMPLE, MIME_HTML5),
        ("latexml", LATEXML_EXAMPLE, MIME_LATEXML),
        ("mathml", MATHML_EXAMPLE, MIME_MATHML),
    ];
    let mimes = [MIME_HTML5, MIME_LATEXML, MIME_MATHML];

    for (name, doc, native_mime) in examples {
        for mime in mimes {
            let (status, errors) = rig.validate(doc, Some(mime)).await;
            assert_eq!(status, 200, "{name} under {mime}: expected 200");
            if mime == native_mime {
                assert_eq!(
                    errors, 0,
                    "{name} must validate clean under its native type {mime}"
                );
            } else {
                assert!(
                    errors > 0,
                    "{name} must produce errors under foreign type {mime}"
                );
            }
        }
    }
}

#[tokio::test]
async fn missing_mime_defaults_to_html5() {
    if validator_url().is_none() {
        eprintln!("skipping: set AR5IV_TEST_VALIDATOR_URL to a running vnu service");
        return;
    }
    let rig = TestRig::boot().await;
    // The HTML5 example is clean under the default...
    let (status, errors) = rig.validate(HTML5_EXAMPLE, None).await;
    assert_eq!((status, errors), (200, 0), "no Content-Type must mean HTML5");
    // ...and a non-HTML document is not, proving the default isn't lax.
    let (status, errors) = rig.validate(MATHML_EXAMPLE, None).await;
    assert_eq!(status, 200);
    assert!(errors > 0, "MathML under the HTML5 default must error");
}

#[tokio::test]
async fn unsupported_mime_is_415() {
    if validator_url().is_none() {
        eprintln!("skipping: set AR5IV_TEST_VALIDATOR_URL to a running vnu service");
        return;
    }
    let rig = TestRig::boot().await;
    let (status, _) = rig.validate(HTML5_EXAMPLE, Some("application/pdf")).await;
    assert_eq!(status, 415, "unsupported Content-Type must be rejected");
}
