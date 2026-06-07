use askama::Template;
use axum::{
    Json,
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
};
use serde::Deserialize;

use ar5iv_editor_protocol::{LatexmlOxideVersion, SchemaSourceVersion, VersionInfo};

use crate::{
    AppState,
    error::AppError,
    templates::{
        AboutTemplate, EditorTemplate, HelpTemplate, SchemasTemplate, UploadTemplate,
        VscodeTemplate,
    },
};

/// Captured at build time from `build.rs`. Format: short SHA.
const LATEXML_OXIDE_SHA: &str = env!("LATEXML_OXIDE_SHA");
/// Captured at build time from `build.rs`. Format: YYYY-MM-DD.
const LATEXML_OXIDE_DATE: &str = env!("LATEXML_OXIDE_DATE");
/// Public-facing repo URL. Override at run time via
/// `AR5IV_EDITOR_LATEXML_OXIDE_URL` if you fork the engine.
const LATEXML_OXIDE_REPO_DEFAULT: &str = "https://github.com/dginev/latexml-oxide";
/// Captured at build time from `build.rs`. Short SHA of the
/// `validator` submodule pin (schema source + vnu service build).
const VALIDATOR_SHA: &str = env!("VALIDATOR_SHA");
const VALIDATOR_REPO_DEFAULT: &str = "https://github.com/dginev/validator";

/// Default schema preset forwarded to the validation service: the
/// LaTeXML scholarly profile. Mirrors the preset line registered in
/// the validator submodule's `resources/presets.txt` — the vnu
/// servlet only honors schema URLs from its allowlist, and preset
/// membership is what puts these on it.
const VALIDATE_SCHEMA_DEFAULT: &str = "http://s.validator.nu/html5-scholarly.rnc \
     http://s.validator.nu/html5/assertions.sch http://c.validator.nu/all/";

/// `GET /` — the editor is the app's home; bounce to it.
pub async fn root_redirect() -> Redirect {
    Redirect::permanent("/editor")
}

pub async fn editor() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, EditorTemplate.render()?))
}

/// `GET /upload` — a standalone archive-drop page: pick or drag a single
/// self-sufficient LaTeX ZIP archive and see the converted ar5iv HTML5 rendered
/// inline. It rides the same `/api/import-archive` + `/convert` pipeline as the
/// editor, reusing the shared `frontend-core/` preview to render the result.
pub async fn upload() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, UploadTemplate.render()?))
}

/// `GET /vscode` — the self-hosted VS Code for the Web workbench, bootstrapped
/// from the vendored standalone build with the ar5iv extension loaded as a
/// built-in. When the build hasn't been vendored
/// (`vscode-extension/scripts/fetch-vscode-web.mjs`) the route degrades to a
/// launcher/status page so the link is never dead.
pub async fn vscode(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    // The ESM bootstrap (template + main.js) is vendored next to the standalone
    // build by `fetch-vscode-web.mjs`. The build's module names carry a version-
    // specific `.internal` suffix (pinned 1.121.0), which we patch in here.
    let ar5iv_dir = state.vscode_web_dir.join("ar5iv");
    let template = match tokio::fs::read_to_string(ar5iv_dir.join("workbench.html")).await {
        Ok(template) => template,
        Err(_) => return Ok(render_html(StatusCode::OK, VscodeTemplate.render()?)),
    };
    let main_js = match tokio::fs::read_to_string(ar5iv_dir.join("workbench-main.js")).await {
        Ok(js) => js,
        Err(_) => return Ok(render_html(StatusCode::OK, VscodeTemplate.render()?)),
    };

    let base = "/vscode-static";
    let (scheme, authority, origin) = request_origin(&headers);
    let config = workbench_config_json(&scheme, &authority, &origin);

    // Bootstrap scripts (mirrors @vscode/test-web's ESM static-build assembly):
    // a theme-sync shim, the english NLS messages, then the workbench main
    // module with its `./workbench.api` import rewritten to the build's real
    // ESM entry. The theme shim is a classic inline script (runs before the
    // deferred module): it reads the site's `/editor` theme choice from
    // localStorage (same origin) and patches the workbench color theme so the
    // two surfaces agree on light/dark when browsing between them.
    let theme_shim = "<script>(function(){try{\
var t=localStorage.getItem('ar5iv-editor-theme');\
var dark=t?(t!=='paper'):(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);\
var el=document.getElementById('vscode-workbench-web-configuration');\
if(el){var c=JSON.parse(el.getAttribute('data-settings'));\
c.configurationDefaults=c.configurationDefaults||{};\
c.configurationDefaults['workbench.colorTheme']=dark?'Default Dark Modern':'Default Light Modern';\
el.setAttribute('data-settings',JSON.stringify(c));}}catch(e){}})();</script>";
    let workbench_entry = format!("{base}/out/vs/workbench/workbench.web.main.internal.js");
    let main_module = main_js.replace("./workbench.api", &workbench_entry);
    let workbench_main = format!(
        "{theme_shim}\n<script src=\"{base}/out/nls.messages.js\"></script>\n<script type=\"module\">{main_module}</script>"
    );

    let html = template
        // The pinned build emits `workbench.web.main.internal.css`; the vendored
        // template (older test-web) links `workbench.web.main.css`.
        .replace("workbench.web.main.css", "workbench.web.main.internal.css")
        .replace("{{WORKBENCH_WEB_BASE_URL}}", base)
        .replace("{{WORKBENCH_WEB_CONFIGURATION}}", &html_attr_escape(&config))
        .replace("{{WORKBENCH_BUILTIN_EXTENSIONS}}", "[]")
        .replace("{{WORKBENCH_MAIN}}", &workbench_main);
    Ok(render_html(StatusCode::OK, html))
}

/// The `IWorkbenchConstructionOptions` injected into the workbench HTML: load
/// the ar5iv extension (served at /vscode-ext) as a built-in, point conversions
/// at this same origin, and isolate webview content under /vscode-static.
fn workbench_config_json(scheme: &str, authority: &str, origin: &str) -> String {
    serde_json::json!({
        "additionalBuiltinExtensions": [
            { "scheme": scheme, "authority": authority, "path": "/vscode-ext" },
            // The vendored VS Code `latex` builtin (TextMate grammars for
            // tex/latex/bibtex, served from the standalone build under
            // /vscode-static/extensions/latex). It's declarative — no code
            // entry point — so it runs in the web extension host. We load it
            // explicitly because the workbench is bootstrapped with
            // builtinExtensions=[], so without this .tex files get no syntax
            // highlighting.
            { "scheme": scheme, "authority": authority, "path": "/vscode-static/extensions/latex" }
        ],
        "productConfiguration": {
            "nameShort": "ar5iv Code",
            "nameLong": "ar5iv VS Code (web preview)",
            "applicationName": "ar5iv-code",
            "dataFolderName": ".ar5iv-vscode",
            "version": "1.121.0",
            "enableTelemetry": false,
            // VS Code's webview content frame (pre/index.html) requires its
            // hostname to equal/subdomain `base32(sha256(parentOrigin+salt))`,
            // which is the value substituted for `{{uuid}}`. So the webview
            // endpoint MUST be a per-webview subdomain — same-origin yields a
            // blank webview ("Expected '<hash>' as hostname or subdomain!").
            // Local dev: access via `localhost` ({{uuid}}.localhost resolves to
            // loopback in Chromium). Production: requires `*.<host>` wildcard
            // DNS + TLS (e.g. *.latexml.rs).
            "webEndpointUrlTemplate": format!("{scheme}://{{{{uuid}}}}.{authority}/vscode-static"),
            "webviewContentExternalBaseUrlTemplate":
                format!("{scheme}://{{{{uuid}}}}.{authority}/vscode-static/out/vs/workbench/contrib/webview/browser/pre/")
        },
        // Default settings for the served workbench. `configurationDefaults` is a
        // top-level IWorkbenchConstructionOptions field (NOT under
        // productConfiguration): point ar5iv conversions at this same origin,
        // strip chrome that distracts from the showcase, and open a sample with
        // the preview beside it. The color theme is set client-side (a small
        // inline script reads the site's `/editor` theme choice) so the two
        // surfaces match light/dark when browsing.
        "configurationDefaults": {
            "ar5iv.backendUrl": origin,
            // No demo-sample auto-open: the extension's welcome flow leads
            // with "Open Local Folder…" (mount a REAL local directory; edits
            // preview through the cloud session and saves write back to the
            // local disk), offering the sample as the fallback button.
            "workbench.startupEditor": "none",
            "editor.minimap.enabled": false,
            "window.menuBarVisibility": "hidden"
        },
        "workspaceUri": { "scheme": "tmp", "path": "/ar5iv.code-workspace" }
    })
    .to_string()
}

/// Escape a JSON string for embedding in the `data-settings="…"` HTML attribute
/// of the workbench config meta tag (matching the upstream serving's escaping).
fn html_attr_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;")
}

/// `(scheme, authority, origin)` for the incoming request, honouring a reverse
/// proxy's `X-Forwarded-Proto`. Loopback hosts default to http, everything else
/// to https.
fn request_origin(headers: &HeaderMap) -> (String, String, String) {
    let authority = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:3000")
        .to_string();
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').next().unwrap_or(value).trim().to_string())
        .unwrap_or_else(|| {
            if authority.starts_with("127.0.0.1") || authority.starts_with("localhost") {
                "http".to_string()
            } else {
                "https".to_string()
            }
        });
    let origin = format!("{scheme}://{authority}");
    (scheme, authority, origin)
}

pub async fn about() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, AboutTemplate.render()?))
}

pub async fn help() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, HelpTemplate.render()?))
}

pub async fn schemas() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, SchemasTemplate.render()?))
}

/// `GET /api/version` — returns build-time info about the
/// latexml-oxide path-dep so the frontend can render a "powered by
/// latexml-oxide @<sha>" link in the preview-pane header.
///
/// The displayed text carries the *build's* date + SHA (so you
/// can tell exactly which commit the running binary was built
/// from). The link target points at the repo's `tree/master` view
/// — always-live, so clicking it shows what's current upstream
/// rather than a snapshot tree that may already be stale by the
/// time someone clicks.
pub async fn version() -> Json<VersionInfo> {
    let repo = std::env::var("AR5IV_EDITOR_LATEXML_OXIDE_URL")
        .unwrap_or_else(|_| LATEXML_OXIDE_REPO_DEFAULT.to_string());
    let url = format!("{repo}/tree/master");
    Json(VersionInfo {
        latexml_oxide: LatexmlOxideVersion {
            sha: LATEXML_OXIDE_SHA.to_string(),
            date: LATEXML_OXIDE_DATE.to_string(),
            url,
        },
        validator: SchemaSourceVersion {
            sha: VALIDATOR_SHA.to_string(),
            url: format!("{VALIDATOR_REPO_DEFAULT}/tree/latexml-html5"),
        },
    })
}

/// Query parameters accepted by `POST /api/validate`, forwarded to
/// the vnu service. All optional; defaults target the scholarly
/// profile with a JSON report.
#[derive(Debug, Deserialize)]
pub struct ValidateParams {
    /// Output format: `json` (default), `gnu`, `xml`, `text`.
    pub out:    Option<String>,
    /// Space-separated schema URLs. Must be on the vnu allowlist
    /// (i.e. appear in the presets the service was built with).
    pub schema: Option<String>,
    /// Parser override (e.g. `xml`); omitted = auto by content-type.
    pub parser: Option<String>,
}

/// `POST /api/validate` — proxy to the vnu (Nu validator) service.
///
/// The request body is the document to validate (HTML5, `text/html`
/// unless the caller says otherwise). The response is the vnu
/// report, passed through verbatim — `?out=json` (the default)
/// yields the `{"messages": [...]}` shape that `corpus-validate.py`
/// and the editor consume.
///
/// The vnu servlet is a separate single-purpose JVM container; we
/// proxy rather than expose it so the schema default, body-size cap,
/// rate limiting, and the Anubis bypass policy all live in one place.
/// `AR5IV_EDITOR_VALIDATOR_URL` unset (e.g. a dev run without the
/// compose stack) degrades to 503 rather than a connection error.
pub async fn validate(
    headers: HeaderMap,
    Query(params): Query<ValidateParams>,
    body: Bytes,
) -> Result<Response, AppError> {
    let Some(base) = std::env::var("AR5IV_EDITOR_VALIDATOR_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
    else {
        return Err(AppError::Unavailable(
            "validation service not configured".to_string(),
        ));
    };
    if body.is_empty() {
        return Err(AppError::BadRequest(
            "empty body; POST the document to validate".to_string(),
        ));
    }

    // One pooled client for the life of the process. The 60 s ceiling
    // is generous on purpose: book-sized HTML on the shared 1-vCPU box
    // can take a while, and the JVM handles its own request queueing.
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            // The vnu servlet 400s requests without a User-Agent.
            .user_agent(concat!("ar5iv-editor/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client builds")
    });

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html; charset=utf-8")
        .to_string();
    let out = params.out.unwrap_or_else(|| "json".to_string());
    let schema = params
        .schema
        .unwrap_or_else(|| VALIDATE_SCHEMA_DEFAULT.to_string());

    let mut query: Vec<(&str, &str)> = vec![("out", &out), ("schema", &schema)];
    if let Some(parser) = params.parser.as_deref() {
        query.push(("parser", parser));
    }

    let upstream = CLIENT
        .post(format!("{}/", base.trim_end_matches('/')))
        .query(&query)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Unavailable(format!("validation service: {e}")))?;

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let resp_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = upstream
        .bytes()
        .await
        .map_err(|e| AppError::Unavailable(format!("validation service: {e}")))?;

    Ok((status, [(header::CONTENT_TYPE, resp_type)], bytes).into_response())
}

fn render_html(status: StatusCode, body: String) -> Response {
    (status, Html(body)).into_response()
}
