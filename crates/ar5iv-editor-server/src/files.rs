//! HTTP file routes for the per-session scratch directory.
//!
//! See `docs/FileUI.md` for the full API. The session id lives in the
//! URL; the user id rides on the `X-Ar5iv-User` header. Every
//! mutating route bumps the session's `version` counter and
//! `last_activity` only on success.

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Multipart, Path as AxumPath, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;

use crate::AppState;
use crate::archive::{self, ConflictPolicy};
use crate::error::AppError;
use crate::quota;
use crate::session::{Session, SessionId, Slot, UserId};

const X_AR5IV_USER: &str = "x-ar5iv-user";

// ---------------------------------------------------------------------------
// Wire types.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateSessionBody {
    pub slot: Slot,
}

#[derive(Debug, Serialize)]
pub struct SessionEnvelope {
    pub id:    SessionId,
    pub slot:  Slot,
    pub entry: String,
    pub files: Vec<FileMeta>,
}

#[derive(Debug, Serialize)]
pub struct FileListing {
    pub files:   Vec<FileMeta>,
    pub version: u64,
}

#[derive(Debug, Serialize)]
pub struct FileMeta {
    pub path: String,
    pub size: u64,
    pub kind: FileKind,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Text,
    Binary,
    Dir,
}

#[derive(Debug, Serialize)]
pub struct WriteAck {
    pub size:    u64,
    pub mtime:   u64,
    pub version: u64,
}

#[derive(Debug, Serialize)]
pub struct OkAck {
    pub ok:      bool,
    pub version: u64,
}

#[derive(Debug, Serialize)]
pub struct UploadAck {
    pub files:   Vec<FileMeta>,
    pub version: u64,
    /// Filenames whose extension wasn't in the upload allowlist and
    /// were silently skipped server-side. The frontend surfaces this
    /// list as an info toast so the user knows their `.out` / `.aux` /
    /// scratch files won't show up in the tree. Empty when every
    /// posted file landed cleanly.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct MkdirBody {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameBody {
    pub from: String,
    pub to:   String,
}

#[derive(Debug, Serialize)]
pub struct UserEnvelope {
    pub user_id: UserId,
}

// ---------------------------------------------------------------------------
// Router wiring.
// ---------------------------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/user", post(mint_user))
        .route("/api/session", post(create_session))
        .route("/api/session/{id}/files", get(list_files).delete(clear_files))
        .route(
            "/api/session/{id}/files/{*path}",
            get(get_file).put(put_file).delete(delete_file),
        )
        .route("/api/session/{id}/upload", post(upload_files))
        .route("/api/session/{id}/upload-archive", post(upload_archive))
        .route("/api/session/{id}/export-zip", get(export_zip))
        .route("/api/session/{id}/archive", get(archive_zip))
        .route("/api/import-archive", post(import_archive))
        .route("/api/session/{id}/mkdir", post(mkdir))
        .route("/api/session/{id}/rename", post(rename))
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

async fn mint_user(State(state): State<AppState>) -> Json<UserEnvelope> {
    Json(UserEnvelope { user_id: state.sessions.mint_user_id() })
}

async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateSessionBody>,
) -> Result<Json<SessionEnvelope>, AppError> {
    let user_id = extract_user(&headers)?;
    quota::check_root_capacity(state.sessions.config()).await?;

    // For example slots, validate the slug is in the manifest before
    // we mint a tmpdir.
    if let Slot::Example(slug) = &body.slot
        && state.examples.get(slug).is_none()
    {
        return Err(AppError::bad_request(format!("unknown example: {slug}")));
    }

    let examples = state.examples.clone();
    let slot = body.slot.clone();
    let cfg = state.sessions.config().clone();
    let session = state
        .sessions
        .lookup_or_create(&user_id, &slot, |dir| {
            // `seed` runs outside the registry write lock.
            let slot = slot.clone();
            let examples = examples.clone();
            let cfg = cfg.clone();
            async move {
                seed_slot(&slot, &examples, &cfg, &dir).await
            }
        })
        .await?;

    // Pre-warm the session's engine child so the user's first edit converts
    // against a warm process (~50-400 ms) instead of paying the cold spawn +
    // `initialize` handshake (~1-10 s). Fire-and-forget: the response returns
    // now and the spawn overlaps with the client hydrating the editor.
    {
        let converter = state.converter.clone();
        let dir = session.dir.clone();
        tokio::spawn(async move { converter.prewarm(&dir).await });
    }

    let listing = scan_files(&session.dir).await?;
    let entry = entry_file_for(&session, &state).unwrap_or_else(|| "main.tex".to_string());

    Ok(Json(SessionEnvelope {
        id:    session.id.clone(),
        slot:  session.slot.clone(),
        entry,
        files: listing,
    }))
}

async fn clear_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<OkAck>, AppError> {
    // Wipe every entry directly under the session root, leaving the
    // root itself intact so the user can keep using the same session
    // id. Quota counters drop to zero, the cached preview HTML and
    // main-entry pick reset, and the version bumps so any in-flight
    // convert frame the client races us with gets the post-clear
    // version echo. Used by the file panel's "clear" button — a
    // destructive operation gated by a confirm dialog client-side.
    let session = require_session(&state, &headers, &id).await?;
    let mut entries = tokio::fs::read_dir(&session.dir)
        .await
        .map_err(map_io_err_with(&session))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| AppError::internal(format!("read_dir entry: {e}")))?
    {
        let p = entry.path();
        let ft = entry
            .file_type()
            .await
            .map_err(|e| AppError::internal(format!("file_type: {e}")))?;
        if ft.is_dir() {
            tokio::fs::remove_dir_all(&p)
                .await
                .map_err(|e| AppError::internal(format!("rmdir {}: {e}", p.display())))?;
        } else {
            tokio::fs::remove_file(&p)
                .await
                .map_err(|e| AppError::internal(format!("rm {}: {e}", p.display())))?;
        }
    }
    session.bytes_used.store(0, Ordering::Relaxed);
    session.file_count.store(0, Ordering::Relaxed);
    if let Ok(mut h) = session.last_html.lock() {
        *h = None;
    }
    if let Ok(mut m) = session.main_entry.lock() {
        *m = None;
    }
    let version = session.bump_version();
    session.touch();
    Ok(Json(OkAck { ok: true, version }))
}

async fn list_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<FileListing>, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    session.touch();
    let files = scan_files(&session.dir).await?;
    Ok(Json(FileListing { files, version: session.version.load(Ordering::Relaxed) }))
}

async fn get_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((id, rel)): AxumPath<(String, String)>,
) -> Result<Response, AppError> {
    // GET file is the one route the browser hits without our custom
    // `X-Ar5iv-User` header — `<img src="...">`, `<a href=...>` and
    // download links can't add custom headers. Authorize on the
    // 256-bit SessionId alone here: knowing the full URL is already
    // unforgeable (the same threshold as a bearer token), and
    // because the route is read-only there's no state-change risk.
    // Mutating routes (PUT / DELETE / POST below) still require the
    // X-Ar5iv-User header AND match it against the session's owner.
    let sid = SessionId::parse(&id)?;
    let session = state.sessions.get(&sid).await?;
    if let Ok(uid) = extract_user(&headers)
        && session.user_id != uid
    {
        // If the caller *did* present a header but it's wrong,
        // surface the mismatch as 403 — this is a deliberate fetch
        // by something that knows the protocol, not a bare image
        // GET. (Without a header, fall through to the public-by-id
        // path above.)
        return Err(AppError::forbidden());
    }
    session.touch();
    let path = session.resolve(&rel)?;
    let bytes = tokio::fs::read(&path).await.map_err(map_io_err_with(&session))?;
    let ct = sniff_content_type(&path);
    Ok(([(header::CONTENT_TYPE, ct)], bytes).into_response())
}

async fn put_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((id, rel)): AxumPath<(String, String)>,
    body: Bytes,
) -> Result<Json<WriteAck>, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    let cfg = state.sessions.config();
    quota::check_upload_size(cfg, body.len() as u64)?;

    let path = session.resolve(&rel)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::internal(format!("mkdir parent: {e}")))?;
    }

    // Capture pre-existing size so quota delta doesn't double-count an
    // overwrite.
    let prior = match tokio::fs::metadata(&path).await {
        Ok(m) => Some(m.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(AppError::internal(format!("stat: {e}"))),
    };
    let delta_bytes = (body.len() as u64).saturating_sub(prior.unwrap_or(0));
    let delta_files = if prior.is_none() { 1 } else { 0 };
    quota::check_session_growth(cfg, &session, delta_bytes, delta_files)?;

    write_no_follow(&path, &body).await.map_err(map_io_err_with(&session))?;

    if delta_files > 0 {
        session.file_count.fetch_add(delta_files, Ordering::Relaxed);
    }
    session.bytes_used.fetch_add(delta_bytes, Ordering::Relaxed);
    let version = session.bump_version();
    session.touch();

    // A new file landed; the project's main-entry pick may need to
    // change. Editing an existing file keeps the same set, so we skip
    // the heuristic on plain overwrites — keystroke-debounced PUTs
    // dominate the WS chatter and find_main_tex isn't free.
    if delta_files > 0 {
        session.refresh_main_entry();
    }

    let mtime = tokio::fs::metadata(&path)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Json(WriteAck { size: body.len() as u64, mtime, version }))
}

async fn delete_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((id, rel)): AxumPath<(String, String)>,
) -> Result<Json<OkAck>, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    let path = session.resolve(&rel)?;
    let prior = tokio::fs::metadata(&path).await.map_err(map_io_err_with(&session))?;
    if prior.is_dir() {
        tokio::fs::remove_dir_all(&path).await.map_err(map_io_err_with(&session))?;
    } else {
        tokio::fs::remove_file(&path).await.map_err(map_io_err_with(&session))?;
        session
            .bytes_used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(prior.len()))
            })
            .ok();
        session.file_count.fetch_sub(1.min(session.file_count.load(Ordering::Relaxed)), Ordering::Relaxed);
    }
    let version = session.bump_version();
    session.touch();
    session.refresh_main_entry();
    Ok(Json(OkAck { ok: true, version }))
}

async fn upload_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    mut multipart: Multipart,
) -> Result<Json<UploadAck>, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    let cfg = state.sessions.config();
    let mut written: Vec<FileMeta> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    // Snapshot the pre-upload count so we can decide whether the
    // "unwrap one folder level" heuristic should run after the
    // batch lands. Folder uploads from `webkitdirectory` post every
    // file with the picker's folder name as the leading segment of
    // `webkitRelativePath`; for a fresh session that's pure
    // wrapping noise we strip below. On a populated session we
    // leave the upload alone — an `assets/` drop into an existing
    // project genuinely belongs under `assets/`.
    let prior_file_count = session.file_count.load(Ordering::Relaxed);

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request(format!("multipart: {e}")))?
    {
        let filename = field
            .file_name()
            .ok_or_else(|| AppError::bad_request("multipart: missing filename"))?
            .to_string();
        // Archive: buffer the bytes (bounded by `quota_archive_bytes`)
        // and run them through the same `unpack_overlay` path the
        // dedicated `upload-archive` endpoint uses. This lets the
        // single "upload" button transparently accept `.zip` /
        // `.tar.gz` files alongside loose folder picks — previously
        // those bodies ran through the regular file path, hit the
        // extension allowlist (which doesn't include archive
        // formats), and got silently skipped after a long drain.
        if is_archive_extension(&filename) {
            let mut bytes = Vec::with_capacity(64 * 1024);
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|e| AppError::bad_request(format!("multipart chunk: {e}")))?
            {
                bytes.extend_from_slice(&chunk);
                quota::check_archive_size(cfg, bytes.len() as u64)?;
            }
            let dir = session.dir.clone();
            let cfg_owned = cfg.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                archive::unpack_overlay(&bytes, &dir, &cfg_owned, ConflictPolicy::Skip)
            })
            .await
            .map_err(|e| AppError::internal(format!("join: {e}")))??;
            session.bytes_used.fetch_add(outcome.bytes_written, Ordering::Relaxed);
            session.file_count.fetch_add(outcome.files_written, Ordering::Relaxed);
            for p in outcome.paths {
                let kind = file_kind_for(&p);
                written.push(FileMeta { path: p, size: 0, kind });
            }
            // Carry through any entries the archive dropped for a disallowed
            // extension, so they join this batch's skipped list.
            skipped.extend(outcome.skipped);
            continue;
        }
        if !is_allowed_extension(&filename) {
            // Drain the field's body so the next field can be parsed,
            // then move on. Folder uploads in particular routinely
            // include latex scratch (`.aux`, `.out`, `.log`) the user
            // doesn't care about; bailing on the whole batch over one
            // unrecognised extension makes the button useless.
            while let Some(_chunk) = field
                .chunk()
                .await
                .map_err(|e| AppError::bad_request(format!("multipart chunk: {e}")))?
            {}
            skipped.push(filename);
            continue;
        }
        let path = session.resolve(&filename)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::internal(format!("mkdir parent: {e}")))?;
        }

        let mut file = open_no_follow_for_write(&path)
            .await
            .map_err(map_io_err_with(&session))?;
        let mut bytes_in_file: u64 = 0;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::bad_request(format!("multipart chunk: {e}")))?
        {
            bytes_in_file = bytes_in_file.saturating_add(chunk.len() as u64);
            quota::check_upload_size(cfg, bytes_in_file)?;
            quota::check_session_growth(cfg, &session, chunk.len() as u64, 0)?;
            file.write_all(&chunk).await.map_err(map_io_err_with(&session))?;
            session.bytes_used.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
        file.flush().await.map_err(map_io_err_with(&session))?;
        session.file_count.fetch_add(1, Ordering::Relaxed);

        let kind = file_kind_for(&filename);
        written.push(FileMeta { path: filename, size: bytes_in_file, kind });
    }

    if prior_file_count == 0
        && let Some(prefix) = single_top_level_prefix(&written)
    {
        unwrap_one_level(&session, &prefix, &mut written).await?;
    }

    let version = session.bump_version();
    session.touch();
    session.refresh_main_entry();
    Ok(Json(UploadAck { files: written, version, skipped }))
}

/// Inspect the just-written upload set and, if every entry shares
/// the same first path segment AND no entry sits at the session
/// root already, return that segment. Used by `upload_files` to
/// flatten `mypaper/...` → `...` after a webkitdirectory pick into
/// an empty session. Returns `None` for mixed-prefix sets, single
/// flat files, or any path containing only one segment.
fn single_top_level_prefix(written: &[FileMeta]) -> Option<String> {
    if written.is_empty() {
        return None;
    }
    let first = written[0].path.split_once('/')?.0.to_string();
    if first.is_empty() {
        return None;
    }
    for f in written {
        let head = match f.path.split_once('/') {
            Some((h, rest)) if !rest.is_empty() => h,
            _ => return None, // root-level file or empty rest → don't unwrap
        };
        if head != first {
            return None;
        }
    }
    Some(first)
}

/// Move every file under `<session>/<prefix>/` up one level into
/// `<session>/`, then remove the now-empty wrapper directory. Updates
/// the in-memory `written` list so the response advertises the
/// post-unwrap paths the client will see in the next listFiles.
async fn unwrap_one_level(
    session: &Session,
    prefix: &str,
    written: &mut [FileMeta],
) -> Result<(), AppError> {
    let prefix_with_slash = format!("{prefix}/");
    for f in written.iter_mut() {
        let stripped = f
            .path
            .strip_prefix(&prefix_with_slash)
            .ok_or_else(|| AppError::internal("unwrap: prefix mismatch"))?
            .to_string();
        let from = session.resolve(&f.path)?;
        let to = session.resolve(&stripped)?;
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::internal(format!("unwrap mkdir: {e}")))?;
        }
        tokio::fs::rename(&from, &to)
            .await
            .map_err(|e| AppError::internal(format!("unwrap rename: {e}")))?;
        f.path = stripped;
    }
    // The wrapper directory should be empty after every file moved
    // up — `remove_dir_all` is fine if a stray dotfile or empty
    // sub-tree lingered. Best-effort: a failure here doesn't undo
    // the upload, just leaves a tidy-up artefact.
    let wrapper = session.resolve(prefix)?;
    let _ = tokio::fs::remove_dir_all(&wrapper).await;
    Ok(())
}

async fn upload_archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Result<Json<UploadAck>, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    let cfg = state.sessions.config().clone();
    let policy = ConflictPolicy::Skip; // TODO: parse `?on_conflict=overwrite`

    // Unpack on the blocking pool — extraction is CPU + disk-bound and
    // shouldn't block the runtime under load.
    let dir = session.dir.clone();
    let bytes = body.to_vec();
    let outcome = tokio::task::spawn_blocking(move || {
        archive::unpack_overlay(&bytes, &dir, &cfg, policy)
    })
    .await
    .map_err(|e| AppError::internal(format!("join: {e}")))??;

    session.bytes_used.fetch_add(outcome.bytes_written, Ordering::Relaxed);
    session.file_count.fetch_add(outcome.files_written, Ordering::Relaxed);
    let version = session.bump_version();
    session.touch();
    session.refresh_main_entry();

    let files: Vec<FileMeta> = outcome
        .paths
        .into_iter()
        .map(|p| FileMeta {
            kind: file_kind_for(&p),
            path: p,
            size: 0, // size known per-entry but not surfaced individually here
        })
        .collect();
    // Files dropped for a disallowed extension (e.g. `.mp4`) — the archive's
    // good files were kept; report the rest so the client can surface them.
    Ok(Json(UploadAck { files, version, skipped: outcome.skipped }))
}

async fn export_zip(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    session.touch();
    let dir = session.dir.clone();

    // Bundle the cached preview HTML alongside the source files when
    // it's available. Session-relative `/api/session/{id}/files/<rel>`
    // URLs in the fragment are rewritten to plain `<rel>` so the
    // extracted ZIP renders standalone (extract → open `index.html`).
    let session_id = session.id.to_string();
    // Cold export path: materialise the cached Arc<str> into an owned String
    // for the zip builder (the hot convert path keeps the cheap Arc).
    let html_fragment = session
        .last_html
        .lock()
        .ok()
        .and_then(|g| g.as_deref().map(str::to_string));
    let extras = build_export_extras(html_fragment, &session_id);

    // Build the ZIP into a buffer on the blocking pool. Session quotas
    // bound the size — the 50 MB session cap is comfortably in-memory.
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, AppError> {
        let mut buf: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        archive::export_zip(&dir, &mut cursor, &extras)?;
        Ok(buf)
    })
    .await
    .map_err(|e| AppError::internal(format!("join: {e}")))??;

    let filename = format!("ar5iv-session-{}.zip", &session.id.to_string()[..8]);
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

/// `GET /api/session/{id}/archive` — convert the session's project into a
/// self-contained HTML5 ZIP via latexml-oxide's native `whatsout=archive`
/// packer and stream it as a download. This is the `/upload` ZIP-to-ZIP
/// path: the bundle carries the rendered HTML + the engine's generated /
/// copied resources only (no uploaded sources), produced correctly by the
/// engine rather than by walking + filtering the session dir.
///
/// When nothing renders (fatal error / empty result) the conversion log is
/// returned with `422 Unprocessable Entity` so the page can show it
/// instead of downloading an empty archive.
async fn archive_zip(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    session.touch();

    match state.converter.convert_archive(session.clone()).await {
        Ok(ok) => {
            let filename = format!("ar5iv-{}.zip", &session.id.to_string()[..8]);
            Ok((
                [
                    (header::CONTENT_TYPE, "application/zip".to_string()),
                    (
                        header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"{filename}\""),
                    ),
                    // The engine's outcome summary, surfaced in the page's
                    // STATUS line (e.g. "No obvious problems",
                    // "2 warnings; 1 error").
                    (
                        header::HeaderName::from_static("x-ar5iv-status"),
                        archive_status_header(ok.status_code, &ok.status),
                    ),
                ],
                ok.zip,
            )
                .into_response())
        }
        Err(resp) => {
            // Nothing rendered — hand back the conversion log so /upload can
            // surface it (mirrors the no-HTML branch's "show the log"),
            // plus the outcome summary in the status header.
            let body = if resp.log.trim().is_empty() {
                format!("conversion produced no output ({})", resp.status)
            } else {
                resp.log
            };
            Ok((
                StatusCode::UNPROCESSABLE_ENTITY,
                [
                    (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string()),
                    (
                        header::HeaderName::from_static("x-ar5iv-status"),
                        archive_status_header(resp.status_code, &resp.status),
                    ),
                ],
                body,
            )
                .into_response())
        }
    }
}

/// Compose the `X-Ar5iv-Status` header value — the conversion outcome the
/// `/upload` page shows in its STATUS line. Prefers the engine's own
/// summary ("No obvious problems", "2 warnings; 1 error", "Fatal:…");
/// falls back to a code-derived label when the engine left it blank.
/// Sanitised to a single line of printable ASCII (header values can't
/// carry CR/LF or arbitrary bytes).
fn archive_status_header(status_code: i32, status: &str) -> String {
    let s = status.trim();
    let label = if !s.is_empty() {
        s.to_string()
    } else {
        match status_code {
            0 => "no problems".to_string(),
            2 => "completed with issues".to_string(),
            3 => "fatal failure".to_string(),
            4 => "session expired".to_string(),
            other => format!("status {other}"),
        }
    };
    label
        .chars()
        .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { ' ' })
        .take(200)
        .collect()
}

/// ar5iv stylesheets (copied in from `~/git/ar5iv-css/css` into
/// `frontend/public/css/`) embedded at compile time so the export
/// route doesn't depend on the static-dir layout. Same files the live
/// preview's shadow root pulls via `/static/css/...`.
pub(crate) const AR5IV_CSS: &[u8] = include_bytes!("../../../frontend/public/css/ar5iv.css");
pub(crate) const AR5IV_FONTS_CSS: &[u8] =
    include_bytes!("../../../frontend/public/css/ar5iv-fonts.css");

/// Build the synthetic-entry list for the export ZIP. When a preview
/// HTML is available we emit a self-contained `index.html` plus the
/// ar5iv stylesheet bundle under `css/`. Without a preview, only the
/// session's source files end up in the archive.
fn build_export_extras(
    html_fragment: Option<String>,
    session_id: &str,
) -> Vec<(String, Vec<u8>)> {
    let Some(fragment) = html_fragment else {
        return Vec::new();
    };
    let rewritten = rewrite_for_offline(&fragment, session_id);
    let index_html = build_offline_index(&rewritten);
    vec![
        ("index.html".to_string(), index_html.into_bytes()),
        ("css/ar5iv.css".to_string(), AR5IV_CSS.to_vec()),
        ("css/ar5iv-fonts.css".to_string(), AR5IV_FONTS_CSS.to_vec()),
    ]
}

/// Inverse of `convert::rewrite_session_paths`: collapse
/// `/api/session/{id}/files/<rel>` URLs back to relative `<rel>` so
/// the exported `index.html` can find images / `\input`'d fragments
/// next to itself when extracted offline.
fn rewrite_for_offline(html: &str, session_id: &str) -> String {
    let needle = format!("/api/session/{session_id}/files/");
    html.replace(&needle, "")
}

/// The ar5iv stylesheet `<link>`s the export bundle ships, injected so
/// the page renders offline against the sibling `css/` directory.
const OFFLINE_CSS_LINKS: &str = "<link rel=\"stylesheet\" href=\"css/ar5iv-fonts.css\">\n\
<link rel=\"stylesheet\" href=\"css/ar5iv.css\">\n";

/// Turn the cached conversion HTML into the standalone `index.html`.
///
/// latexml-oxide's HTML5 output is already a *complete* document — its
/// own `<head>` (carrying the `\title`-derived `<title>`), the
/// `ltx_page_main` body, the lot — but it embeds no stylesheet links
/// (the live preview injects those into its shadow root itself). So we
/// keep that document intact, preserving latexml's `<title>`, and splice
/// the bundled ar5iv stylesheet links in just before `</head>`. Wrapping
/// it in a second shell (as we used to) produced nested `<html>`/`<head>`
/// and a hardcoded `<title>ar5iv export</title>` that shadowed the real
/// one. If we're ever handed a bare fragment instead (no `</head>`), fall
/// back to the minimal wrapper.
fn build_offline_index(html: &str) -> String {
    // First `</head>` is the document head's — body content never precedes
    // it, so this targets latexml's `<head>` even if a verbatim block later
    // contains the literal text.
    if let Some(head_end) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + OFFLINE_CSS_LINKS.len());
        out.push_str(&html[..head_end]);
        out.push_str(OFFLINE_CSS_LINKS);
        out.push_str(&html[head_end..]);
        out
    } else {
        wrap_offline_html(html)
    }
}

/// Wrap a rendered *fragment* in a minimal HTML5 shell that links the
/// ar5iv stylesheets we ship alongside it. Mirrors the live preview's
/// shadow-root setup (`<div class="ltx_page_main">…</div>`) so the same
/// selectors apply. Fallback for [`build_offline_index`] when the
/// conversion output isn't a complete document.
fn wrap_offline_html(fragment: &str) -> String {
    format!(
        "<!DOCTYPE html>\n\
<html lang=\"en\">\n\
<head>\n\
  <meta charset=\"utf-8\">\n\
  <title>ar5iv export</title>\n\
  <link rel=\"stylesheet\" href=\"css/ar5iv-fonts.css\">\n\
  <link rel=\"stylesheet\" href=\"css/ar5iv.css\">\n\
</head>\n\
<body>\n\
<article class=\"ltx_page_main\">\n\
{fragment}\n\
</article>\n\
</body>\n\
</html>\n"
    )
}

async fn import_archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<SessionEnvelope>, AppError> {
    let user_id = extract_user(&headers)?;
    quota::check_root_capacity(state.sessions.config()).await?;
    quota::check_archive_size(state.sessions.config(), body.len() as u64)?;

    // Slot key = `upload:<sha256-hex-of-archive-bytes>`. Re-uploading
    // the same archive returns the same session id.
    let hash = archive::content_hash(&body);
    let slot = Slot::Upload(hash);

    let cfg = state.sessions.config().clone();
    let bytes = std::sync::Arc::new(body.to_vec());
    let session = state
        .sessions
        .lookup_or_create(&user_id, &slot, |dir| {
            let bytes = bytes.clone();
            let cfg = cfg.clone();
            async move {
                tokio::task::spawn_blocking(move || archive::unpack_into(&bytes, &dir, &cfg))
                    .await
                    .map_err(|e| AppError::internal(format!("join: {e}")))?
                    .map(|o| (o.bytes_written, o.files_written))
            }
        })
        .await?;

    let listing = scan_files(&session.dir).await?;
    let entry = pick_default_entry(&listing).unwrap_or_else(|| "main.tex".to_string());
    Ok(Json(SessionEnvelope {
        id: session.id.clone(),
        slot: session.slot.clone(),
        entry,
        files: listing,
    }))
}

/// Pick a sensible "open this file first" path from a listing. Prefers
/// `main.tex` if present, otherwise the first `.tex` file lexically,
/// otherwise the first file at all.
fn pick_default_entry(files: &[FileMeta]) -> Option<String> {
    if files.iter().any(|f| f.path == "main.tex") {
        return Some("main.tex".into());
    }
    if let Some(t) = files
        .iter()
        .find(|f| matches!(f.kind, FileKind::Text) && f.path.ends_with(".tex"))
    {
        return Some(t.path.clone());
    }
    files.first().map(|f| f.path.clone())
}

async fn mkdir(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<MkdirBody>,
) -> Result<Json<OkAck>, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    let path = session.resolve(&body.path)?;
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(map_io_err_with(&session))?;
    let version = session.bump_version();
    session.touch();
    session.refresh_main_entry();
    Ok(Json(OkAck { ok: true, version }))
}

async fn rename(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<RenameBody>,
) -> Result<Json<OkAck>, AppError> {
    let session = require_session(&state, &headers, &id).await?;
    let from = session.resolve(&body.from)?;
    let to = session.resolve(&body.to)?;
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::internal(format!("mkdir parent: {e}")))?;
    }
    tokio::fs::rename(&from, &to).await.map_err(map_io_err_with(&session))?;
    let version = session.bump_version();
    session.touch();
    session.refresh_main_entry();
    Ok(Json(OkAck { ok: true, version }))
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

fn extract_user(headers: &HeaderMap) -> Result<UserId, AppError> {
    let raw = headers
        .get(X_AR5IV_USER)
        .ok_or_else(|| AppError::bad_request("missing X-Ar5iv-User header"))?
        .to_str()
        .map_err(|_| AppError::bad_request("X-Ar5iv-User: bad encoding"))?;
    UserId::parse(raw)
}

async fn require_session(
    state: &AppState,
    headers: &HeaderMap,
    raw_id: &str,
) -> Result<Arc<Session>, AppError> {
    let user_id = extract_user(headers)?;
    let id = SessionId::parse(raw_id)?;
    let s = state.sessions.get(&id).await?;
    if s.user_id != user_id {
        return Err(AppError::forbidden());
    }
    Ok(s)
}

async fn seed_slot(
    slot: &Slot,
    examples: &Arc<crate::examples::ExampleCatalog>,
    cfg: &crate::config::SessionConfig,
    dir: &std::path::Path,
) -> Result<(u64, u32), AppError> {
    match slot {
        Slot::Blank => {
            let body = b"\\documentclass{article}\n\\begin{document}\nHello, world! Try \\(x^2 + y^2 = z^2\\).\n\\end{document}\n";
            let path = dir.join("main.tex");
            tokio::fs::write(&path, body)
                .await
                .map_err(|e| AppError::internal(format!("seed welcome: {e}")))?;
            Ok((body.len() as u64, 1))
        }
        Slot::Example(slug) => {
            let outcome = examples.seed(slug, dir).await?;
            if let Some(archive_bytes) = outcome.archive {
                // Archive-bearing example: unpack the embedded
                // tarball/zip onto the freshly-seeded dir. Plain files
                // from the example tree (if any) were written by the
                // seed() call above; the archive overlays.
                let dir = dir.to_path_buf();
                let cfg = cfg.clone();
                let unpack = tokio::task::spawn_blocking(move || {
                    crate::archive::unpack_overlay(
                        &archive_bytes,
                        &dir,
                        &cfg,
                        ConflictPolicy::Overwrite,
                    )
                })
                .await
                .map_err(|e| AppError::internal(format!("join: {e}")))??;
                Ok((
                    outcome.bytes.saturating_add(unpack.bytes_written),
                    outcome.files.saturating_add(unpack.files_written),
                ))
            } else {
                Ok((outcome.bytes, outcome.files))
            }
        }
        Slot::Upload(_) => Err(AppError::bad_request(
            "upload-slot creation requires the import-archive route",
        )),
    }
}

fn entry_file_for(session: &Session, state: &AppState) -> Option<String> {
    match &session.slot {
        Slot::Blank => Some("main.tex".to_string()),
        Slot::Example(slug) => state.examples.get(slug).map(|e| e.entry.clone()),
        Slot::Upload(_) => Some("main.tex".to_string()),
    }
}

async fn scan_files(root: &std::path::Path) -> Result<Vec<FileMeta>, AppError> {
    let mut out: Vec<FileMeta> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(AppError::internal(format!("read_dir: {err}"))),
        };
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| AppError::internal(format!("read_dir entry: {e}")))?
        {
            let ft = entry
                .file_type()
                .await
                .map_err(|e| AppError::internal(format!("file_type: {e}")))?;
            let p = entry.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if ft.is_dir() {
                stack.push(p.clone());
                out.push(FileMeta { path: rel, size: 0, kind: FileKind::Dir });
            } else if ft.is_file() {
                let size = entry
                    .metadata()
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                out.push(FileMeta { path: rel.clone(), size, kind: file_kind_for(&rel) });
            }
            // Symlinks intentionally ignored.
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn file_kind_for(path: &str) -> FileKind {
    if matches!(
        std::path::Path::new(path).extension().and_then(|e| e.to_str()),
        Some("tex" | "sty" | "cls" | "bib" | "bst" | "bbl" | "def" | "ldf" | "rhai"
             | "txt" | "md" | "csv"
             | "dat" | "toml" | "json" | "yaml" | "yml" | "svg")
    ) {
        FileKind::Text
    } else {
        FileKind::Binary
    }
}

fn is_allowed_extension(path: &str) -> bool {
    matches!(
        std::path::Path::new(path).extension().and_then(|e| e.to_str()),
        Some("tex" | "sty" | "cls" | "clo" | "bib" | "bst" | "bbl" | "def" | "ldf" | "rhai"
             | "png" | "jpg" | "jpeg" | "gif" | "svg" | "pdf" | "eps"
             | "csv" | "dat" | "txt" | "md" | "toml" | "json" | "yaml" | "yml")
    )
}

/// Archive extensions handled by the upload endpoint via
/// `unpack_overlay`. Compound suffix `.tar.gz` is matched on the full
/// filename rather than on `Path::extension` (which would only see
/// `.gz`); `.tgz` and `.zip` are the regular single-suffix forms.
fn is_archive_extension(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".zip") || lower.ends_with(".tar.gz") || lower.ends_with(".tgz")
}

fn sniff_content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("tex" | "sty" | "cls" | "bib" | "bst" | "txt" | "md" | "csv" | "dat"
             | "toml" | "yaml" | "yml" | "rhai") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(unix)]
async fn open_no_follow_for_write(
    path: &std::path::Path,
) -> std::io::Result<tokio::fs::File> {
    // tokio::fs::OpenOptions exposes `custom_flags` directly on Unix,
    // no `OpenOptionsExt` import required.
    tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc_constants::O_NOFOLLOW)
        .open(path)
        .await
}

#[cfg(not(unix))]
async fn open_no_follow_for_write(
    path: &std::path::Path,
) -> std::io::Result<tokio::fs::File> {
    // Best-effort on non-Unix; the symlink threat model is Unix-shaped.
    tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .await
}

#[cfg(unix)]
mod libc_constants {
    // Equivalent of `libc::O_NOFOLLOW` without taking on the `libc`
    // dep just for one constant. POSIX defines this as 0x20000 on
    // Linux; macOS uses 0x100; we pick the right one at compile time.
    #[cfg(target_os = "linux")]
    pub const O_NOFOLLOW: i32 = 0o400_000;
    #[cfg(target_os = "macos")]
    pub const O_NOFOLLOW: i32 = 0x100;
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub const O_NOFOLLOW: i32 = 0;
}

async fn write_no_follow(path: &std::path::Path, body: &[u8]) -> std::io::Result<()> {
    let mut f = open_no_follow_for_write(path).await?;
    f.write_all(body).await?;
    f.flush().await?;
    Ok(())
}

/// Map an std::io::Error encountered while operating on session state
/// to either 410 (the session dir is gone — GC race) or 500 (any
/// other internal IO failure). NotFound _inside_ the session dir is a
/// "file doesn't exist" 404… but for v1.2 the file routes only target
/// existing paths, so NotFound on the session dir specifically means
/// the dir was unlinked under us. We distinguish by checking whether
/// the session dir itself still exists.
fn map_io_err_with(session: &Session) -> impl Fn(std::io::Error) -> AppError + '_ {
    move |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // Cheap synchronous check: if the session dir disappeared,
            // the session is GC'd. Use std (not tokio) to keep this an
            // ordinary error mapper.
            if !session.dir.exists() {
                return AppError::session_expired();
            }
            // Otherwise it's a regular "no such file" — surface as 400
            // for now. v1.3 may want a dedicated 404.
            return AppError::bad_request(format!("not found: {e}"));
        }
        AppError::internal(format!("io: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_index_preserves_latexml_title_and_injects_css() {
        // latexml-oxide hands us a complete HTML document with its own
        // <head>/<title>; the export must keep that title and only add the
        // bundled stylesheet links — not wrap it in a second shell.
        let doc = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n\
<title>My Paper Title</title>\n</head>\n<body>\n\
<div class=\"ltx_page_main\">body</div>\n</body>\n</html>\n";
        let out = build_offline_index(doc);
        assert!(out.contains("<title>My Paper Title</title>"), "latexml title kept: {out}");
        assert!(!out.contains("ar5iv export"), "no hardcoded title override");
        assert!(out.contains("css/ar5iv.css"), "ar5iv css link injected");
        assert_eq!(out.matches("<head>").count(), 1, "exactly one <head> (no double-wrap)");
        assert_eq!(out.matches("<title>").count(), 1, "exactly one <title>");
    }

    #[test]
    fn offline_index_wraps_bare_fragment() {
        // No </head> → fall back to the minimal shell.
        let frag = "<div class=\"ltx_para\">just a fragment</div>";
        let out = build_offline_index(frag);
        assert!(out.contains("just a fragment"));
        assert!(out.contains("css/ar5iv.css"), "css linked in fallback shell");
        assert!(out.contains("<head>"), "fallback adds a head");
    }

    #[test]
    fn rhai_bindings_are_editable_text() {
        // `.rhai` package bindings (e.g. the Rhai Bindings showcase) carry a
        // custom syntax but are plain text — they must open in the editor,
        // upload like any source file, and serve as text rather than a binary
        // download.
        assert!(matches!(file_kind_for("example.sty.rhai"), FileKind::Text));
        assert!(is_allowed_extension("example.sty.rhai"));
        assert_eq!(
            sniff_content_type(std::path::Path::new("example.sty.rhai")),
            "text/plain; charset=utf-8"
        );
    }
}
