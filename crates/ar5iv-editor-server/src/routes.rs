use askama::Template;
use axum::{
    Json,
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};

use ar5iv_editor_protocol::{LatexmlOxideVersion, VersionInfo};

use crate::{
    error::AppError,
    templates::{AboutTemplate, EditorTemplate, HelpTemplate, IndexTemplate},
};

/// Captured at build time from `build.rs`. Format: short SHA.
const LATEXML_OXIDE_SHA: &str = env!("LATEXML_OXIDE_SHA");
/// Captured at build time from `build.rs`. Format: YYYY-MM-DD.
const LATEXML_OXIDE_DATE: &str = env!("LATEXML_OXIDE_DATE");
/// Public-facing repo URL. Override at run time via
/// `AR5IV_EDITOR_LATEXML_OXIDE_URL` if you fork the engine.
const LATEXML_OXIDE_REPO_DEFAULT: &str = "https://github.com/dginev/latexml-oxide";

pub async fn index() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, IndexTemplate.render()?))
}

pub async fn editor() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, EditorTemplate.render()?))
}

pub async fn about() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, AboutTemplate.render()?))
}

pub async fn help() -> Result<Response, AppError> {
    Ok(render_html(StatusCode::OK, HelpTemplate.render()?))
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
            sha:  LATEXML_OXIDE_SHA.to_string(),
            date: LATEXML_OXIDE_DATE.to_string(),
            url,
        },
    })
}

fn render_html(status: StatusCode, body: String) -> Response {
    (status, Html(body)).into_response()
}
