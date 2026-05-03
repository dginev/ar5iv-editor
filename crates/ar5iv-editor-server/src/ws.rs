use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket, close_code},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};

use ar5iv_editor_protocol::{ConvertRequest, ConvertResponse};

use crate::AppState;
use crate::session::{Session, SessionId};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    // Bind the session at upgrade time. Anything malformed → 1008.
    // The query is `?session_id=…&user_id=…`. The user_id is verified
    // against the session's owner so a leaked session id alone isn't
    // enough.
    let raw_session = params.get("session_id").cloned().unwrap_or_default();
    let raw_user = params.get("user_id").cloned().unwrap_or_default();

    let session = match resolve_session(&state, &raw_session, &raw_user).await {
        Ok(s) => s,
        Err(reason) => {
            return ws
                .on_upgrade(move |mut socket| async move {
                    let _ = socket
                        .send(Message::Close(Some(CloseFrame {
                            code:   close_code::POLICY,
                            reason: reason.into(),
                        })))
                        .await;
                });
        }
    };

    ws.on_upgrade(move |socket| handle_socket(socket, state, session))
}

async fn resolve_session(
    state: &AppState,
    raw_session: &str,
    raw_user: &str,
) -> Result<Arc<Session>, &'static str> {
    let sid = SessionId::parse(raw_session).map_err(|_| "bad session_id")?;
    let uid = SessionId::parse(raw_user).map_err(|_| "bad user_id")?;
    let session = state.sessions.get(&sid).await.map_err(|_| "session_expired")?;
    if session.user_id != uid {
        return Err("forbidden");
    }
    Ok(session)
}

async fn handle_socket(socket: WebSocket, state: AppState, session: Arc<Session>) {
    let (mut sender, mut receiver) = socket.split();
    let (resp_tx, mut resp_rx) = mpsc::channel::<ConvertResponse>(16);

    let send_task = tokio::spawn(async move {
        while let Some(resp) = resp_rx.recv().await {
            let payload = match serde_json::to_string(&resp) {
                Ok(s) => s,
                Err(e) => {
                    warn!(error = %e, "failed to serialize response");
                    continue;
                }
            };
            if sender.send(Message::Text(payload.into())).await.is_err() {
                break;
            }
        }
    });

    let mut active_cancel: Option<oneshot::Sender<()>> = None;

    while let Some(Ok(msg)) = receiver.next().await {
        // Any received frame counts as activity; this is what keeps an
        // active tab's session alive between conversions.
        session.touch();
        match msg {
            Message::Text(text) => {
                let req: ConvertRequest = match serde_json::from_str(text.as_str()) {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = resp_tx
                            .send(ConvertResponse::fatal(0, format!("bad request: {e}")))
                            .await;
                        continue;
                    }
                };
                let id = req.id;

                if let Some(prev) = active_cancel.take() {
                    let _ = prev.send(());
                }
                let (cancel_tx, cancel_rx) = oneshot::channel();
                active_cancel = Some(cancel_tx);

                let converter = state.converter.clone();
                let resp_tx = resp_tx.clone();
                let session = session.clone();
                tokio::spawn(async move {
                    tokio::select! {
                        resp = converter.convert(req, session) => {
                            let _ = resp_tx.send(resp).await;
                        }
                        _ = cancel_rx => {
                            debug!(id, "request superseded by newer one");
                        }
                    }
                });
            }
            Message::Close(_) => break,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    if let Some(prev) = active_cancel.take() {
        let _ = prev.send(());
    }
    drop(resp_tx);
    let _ = send_task.await;
}
