use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("template render error: {0}")]
    Template(#[from] askama::Error),

    /// Malformed input from the client. Renders as 400.
    #[error("bad request: {0}")]
    BadRequest(String),

    /// Caller's `X-Ar5iv-User` does not own the targeted session.
    /// Renders as 403. See `docs/FileUI.md`.
    #[error("forbidden")]
    Forbidden,

    /// Session id is unknown — either expired-and-GC'd or never existed.
    /// Renders as 410 Gone with `{"code": "session_expired"}` so the
    /// frontend can branch on the JSON shape rather than the bare 410.
    #[error("session expired")]
    SessionExpired,

    /// Quota or capacity guard tripped. Renders as 413
    /// (Payload Too Large) with a human-readable reason.
    #[error("quota: {0}")]
    Quota(String),

    /// Service is too busy / refusing new sessions because the
    /// disk-soft-cap is hit. Renders as 503.
    #[error("unavailable: {0}")]
    Unavailable(String),

    /// Catch-all for unexpected internal failures.
    #[error("internal: {0}")]
    Internal(String),
}

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self { Self::BadRequest(msg.into()) }
    pub fn forbidden() -> Self { Self::Forbidden }
    pub fn session_expired() -> Self { Self::SessionExpired }
    pub fn quota(msg: impl Into<String>) -> Self { Self::Quota(msg.into()) }
    pub fn unavailable(msg: impl Into<String>) -> Self { Self::Unavailable(msg.into()) }
    pub fn internal(msg: impl Into<String>) -> Self { Self::Internal(msg.into()) }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::Template(_) | AppError::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::SessionExpired => (StatusCode::GONE, "session_expired"),
            AppError::Quota(_) => (StatusCode::PAYLOAD_TOO_LARGE, "quota"),
            AppError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        };
        if matches!(self, AppError::Internal(_) | AppError::Template(_)) {
            tracing::error!(error = %self, "request failed");
        } else {
            tracing::debug!(error = %self, code, "request rejected");
        }
        let body = Json(json!({ "code": code, "message": self.to_string() }));
        (status, body).into_response()
    }
}
