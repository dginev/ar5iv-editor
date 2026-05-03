use askama::Template;
use axum::{
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};

use crate::{
    error::AppError,
    templates::{AboutTemplate, EditorTemplate, HelpTemplate, IndexTemplate},
};

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

fn render_html(status: StatusCode, body: String) -> Response {
    (status, Html(body)).into_response()
}
