//! Warm engine pool: one `latexml_oxide --server` LSP child per active
//! session, so document conversions ride the engine's warm-preamble +
//! fork-body cache (~50–400 ms per edit) instead of a cold in-process
//! rebuild (~1–10 s). The pool is the server-side sibling of the VS Code
//! extension's executable lane — every client converts through the same
//! engine process model.
//!
//! Design notes (each one a scar):
//! * **Byte-accurate LSP framing.** `Content-Length` counts UTF-8 BYTES;
//!   framing over decoded strings hangs forever on the first multi-byte
//!   response (the VS Code extension shipped exactly that bug). The codec
//!   here never decodes before slicing — see [`take_frame`].
//! * **stderr is always drained.** The engine logs progress notes to
//!   stderr; an undrained pipe eventually blocks the child mid-conversion.
//!   Each child gets a stderr→tracing forwarder task.
//! * **Requests are forwarded immediately, never queued.** The engine
//!   preempts its in-flight conversion when a newer same-project request
//!   arrives (SIGTERM→SIGKILL on the fork child) and answers the stale id
//!   with `status:"cancelled"` — letting it see the new request *during*
//!   the old conversion is what makes typing responsive. A bridge-side
//!   queue would serialize away that capability.
//! * **Children run with `cwd = session dir`.** Graphics post-processing
//!   writes converted images relative to the cwd; pointing it at the
//!   session dir lands them where the file routes already serve
//!   (`/api/session/{id}/files/...`).
//! * **Self-healing, never silent.** A dead/timed-out child fails the
//!   request loudly (the bridge falls back to the in-process worker and
//!   logs), gets reaped, and the next request respawns fresh.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

// ======================================================================
// Configuration.
// ======================================================================

#[derive(Debug, Clone)]
pub struct LspPoolConfig {
    /// Path to the `latexml_oxide` engine binary.
    pub engine: PathBuf,
    /// Maximum number of warm children kept alive (one per session; a
    /// warm LaTeX kernel state is roughly 200 MB RSS, so the default
    /// stays modest). Sessions beyond capacity evict the
    /// least-recently-used idle child.
    pub capacity: usize,
    /// Per-conversion wall-clock budget handed to the child
    /// (`--timeout`; its Watchdog hard-kills the fork on breach).
    pub timeout_secs: u64,
    /// Per-conversion RSS ceiling in MiB handed to the child
    /// (`--max-memory`).
    pub max_memory_mb: u64,
    /// Children idle longer than this are reaped opportunistically
    /// (covers expired sessions without a dedicated timer task).
    pub idle_reap_secs: u64,
}

/// Locate the engine binary: explicit env override → `$PATH`. Returns
/// `None` (pool disabled, in-process fallback) when neither resolves —
/// the caller logs this LOUDLY once; a silently degraded lane is how
/// stale-engine bugs hide.
pub fn resolve_engine() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AR5IV_LATEXML_BIN") {
        let p = PathBuf::from(p);
        if is_executable(&p) {
            return Some(p);
        }
        warn!(
            "AR5IV_LATEXML_BIN={} is not an executable file; ignoring",
            p.display()
        );
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join("latexml_oxide"))
        .find(|c| is_executable(c))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

// ======================================================================
// Errors / output.
// ======================================================================

#[derive(Debug)]
pub enum LspError {
    Spawn(std::io::Error),
    /// The child died (EOF on its stdout) before answering.
    ChildDied,
    /// No answer within the deadline (engine timeout + grace); the child
    /// has been killed and removed from the pool.
    Timeout,
    /// The child answered with a JSON-RPC error object.
    Rpc(String),
}

impl std::fmt::Display for LspError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LspError::Spawn(e) => write!(f, "failed to spawn latexml_oxide: {e}"),
            LspError::ChildDied => write!(f, "latexml_oxide child exited mid-request"),
            LspError::Timeout => write!(f, "latexml_oxide child did not answer in time"),
            LspError::Rpc(m) => write!(f, "latexml_oxide rpc error: {m}"),
        }
    }
}

impl std::error::Error for LspError {}

/// The fields of a `latexml/convert` result the bridge consumes.
/// Deserialized directly from the JSON-RPC `result` subtree (see
/// [`LspPool::convert`]) — no intermediate `Value` clone. `#[serde(default)]`
/// makes every field optional; a missing/null/malformed result decodes via
/// [`LspOutput::default`] to `status_code = 3` (engine error), matching the
/// pre-typed `get_str`/`unwrap_or(3)` behaviour.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct LspOutput {
    pub html: String,
    pub log: String,
    pub status: String,
    #[serde(rename = "statusCode")]
    pub status_code: i64,
    pub sources: Vec<String>,
    pub root: Option<String>,
}

impl Default for LspOutput {
    fn default() -> Self {
        Self {
            html: String::new(),
            log: String::new(),
            status: String::new(),
            status_code: 3,
            sources: Vec::new(),
            root: None,
        }
    }
}

// ======================================================================
// Framing codec (pure; unit-tested below).
// ======================================================================

/// Extract one complete LSP frame body from `buf`, draining it. BYTE
/// arithmetic throughout — `Content-Length` is a byte count and must
/// never be compared against decoded-character lengths.
fn take_frame(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    loop {
        let header_end = find_subseq(buf, b"\r\n\r\n")?;
        let content_length = parse_content_length(&buf[..header_end]);
        let body_start = header_end + 4;
        match content_length {
            Some(len) if buf.len() >= body_start + len => {
                let body = buf[body_start..body_start + len].to_vec();
                buf.drain(..body_start + len);
                return Some(body);
            }
            // Malformed header (no parseable Content-Length): drop it and
            // resync on the next header boundary.
            None => {
                buf.drain(..body_start);
            }
            // Body not fully arrived yet.
            Some(_) => return None,
        }
    }
}

fn find_subseq(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_content_length(header: &[u8]) -> Option<usize> {
    let s = std::str::from_utf8(header).ok()?;
    s.split("\r\n").find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if k.trim().eq_ignore_ascii_case("content-length") {
            v.trim().parse().ok()
        } else {
            None
        }
    })
}

fn frame(msg: &Value) -> Vec<u8> {
    let body = msg.to_string();
    let mut out = Vec::with_capacity(body.len() + 32);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    out.extend_from_slice(body.as_bytes());
    out
}

// ======================================================================
// One pooled child.
// ======================================================================

struct PooledChild {
    stdin: tokio::sync::Mutex<ChildStdin>,
    /// Process handle, kept for the kill path. `None` after shutdown.
    child: std::sync::Mutex<Option<Child>>,
    pending: std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    /// Millis since pool creation, for LRU/idle decisions (atomic so the
    /// hot path never takes a lock just to touch a timestamp).
    last_used_ms: AtomicU64,
}

impl PooledChild {
    fn is_busy(&self) -> bool {
        self.pending.lock().map(|p| !p.is_empty()).unwrap_or(false)
    }

    /// Kill the child and fail everything pending. Idempotent.
    fn shutdown(&self) {
        self.alive.store(false, Ordering::Relaxed);
        // Dropping the pending senders errs the awaiting receivers.
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        if let Ok(mut slot) = self.child.lock()
            && let Some(mut child) = slot.take()
        {
            // The engine exits cleanly on stdin EOF; `start_kill` is the
            // impatient version — the throwaway child model makes the
            // distinction cosmetic, and kill-now means eviction never
            // waits on a wedged process.
            let _ = child.start_kill();
            tokio::spawn(async move {
                let _ = child.wait().await; // reap, no zombie
            });
        }
    }
}

// ======================================================================
// The pool.
// ======================================================================

pub struct LspPool {
    cfg: LspPoolConfig,
    epoch: Instant,
    children: tokio::sync::Mutex<HashMap<PathBuf, Arc<PooledChild>>>,
}

impl LspPool {
    pub fn new(cfg: LspPoolConfig) -> Self {
        info!(
            "LSP engine pool: {} (capacity {}, timeout {}s)",
            cfg.engine.display(),
            cfg.capacity,
            cfg.timeout_secs
        );
        Self {
            cfg,
            epoch: Instant::now(),
            children: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    /// Convert `text` (the on-disk content of `abs_path`, already written
    /// by the file routes) in the warm child of the session at
    /// `session_dir`. Errors are for the caller to fall back on — the
    /// offending child is already reaped.
    pub async fn convert(
        &self,
        session_dir: &Path,
        abs_path: &Path,
        text: &str,
    ) -> Result<LspOutput, LspError> {
        let child = self.child_for(session_dir).await?;
        let id = child.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        child
            .pending
            .lock()
            .expect("pending lock poisoned")
            .insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "latexml/convert",
            "params": {
                "uri": format!("file://{}", abs_path.display()),
                "text": text,
            },
        });
        {
            let mut stdin = child.stdin.lock().await;
            if let Err(e) = stdin.write_all(&frame(&msg)).await {
                drop(stdin);
                self.reap(session_dir, &child).await;
                warn!("LSP child write failed ({e}); reaped");
                return Err(LspError::ChildDied);
            }
            let _ = stdin.flush().await;
        }

        // Engine timeout + grace for fork/serialize/transport overhead.
        let deadline = Duration::from_secs(self.cfg.timeout_secs + 15);
        let mut resp = match tokio::time::timeout(deadline, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => {
                // Sender dropped: the read task saw EOF (child died).
                self.reap(session_dir, &child).await;
                return Err(LspError::ChildDied);
            }
            Err(_) => {
                self.reap(session_dir, &child).await;
                warn!(
                    "LSP child unresponsive after {}s; killed",
                    deadline.as_secs()
                );
                return Err(LspError::Timeout);
            }
        };
        child.last_used_ms.store(self.now_ms(), Ordering::Relaxed);

        if let Some(err) = resp.get("error") {
            return Err(LspError::Rpc(
                err.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            ));
        }
        // Move the `result` subtree out of the response and decode it straight
        // into the typed struct: no deep `.cloned()` of the (HTML-bearing)
        // result and no per-field re-allocation. `take()` swaps in `Null`,
        // which — like a missing/malformed result — decodes via
        // `LspOutput::default()` (status_code = 3), preserving prior behaviour.
        let result = resp
            .get_mut("result")
            .map(Value::take)
            .unwrap_or(Value::Null);
        Ok(serde_json::from_value::<LspOutput>(result).unwrap_or_default())
    }

    /// Spawn (or reuse) the session's warm child *without* converting, so the
    /// first real convert skips the cold spawn + `initialize` handshake. Meant
    /// to be called fire-and-forget at session creation; errors are swallowed
    /// (the convert path retries and self-heals).
    pub async fn prewarm(&self, session_dir: &Path) {
        match self.child_for(session_dir).await {
            Ok(_) => debug!("prewarmed LSP child for {}", session_dir.display()),
            Err(e) => debug!("prewarm for {} failed: {e}", session_dir.display()),
        }
    }

    /// Fetch the session's live child, or spawn one (evicting as needed).
    async fn child_for(&self, session_dir: &Path) -> Result<Arc<PooledChild>, LspError> {
        let mut children = self.children.lock().await;

        // Opportunistic sweep: dead children and idle ones (expired
        // sessions) go first, so capacity reflects reality.
        let now = self.now_ms();
        let idle_cutoff_ms = self.cfg.idle_reap_secs.saturating_mul(1000);
        children.retain(|dir, c| {
            let alive = c.alive.load(Ordering::Relaxed);
            let idle = now.saturating_sub(c.last_used_ms.load(Ordering::Relaxed));
            let keep = alive && (idle < idle_cutoff_ms || c.is_busy());
            if !keep {
                debug!(
                    "reaping LSP child for {} (alive={alive}, idle={idle}ms)",
                    dir.display()
                );
                c.shutdown();
            }
            keep
        });

        if let Some(c) = children.get(session_dir) {
            if c.alive.load(Ordering::Relaxed) {
                c.last_used_ms.store(now, Ordering::Relaxed);
                return Ok(c.clone());
            }
            c.shutdown();
            children.remove(session_dir);
        }

        // Capacity: evict the least-recently-used idle child.
        while children.len() >= self.cfg.capacity.max(1) {
            let victim = children
                .iter()
                .filter(|(_, c)| !c.is_busy())
                .min_by_key(|(_, c)| c.last_used_ms.load(Ordering::Relaxed))
                .map(|(dir, _)| dir.clone());
            match victim {
                Some(dir) => {
                    debug!(
                        "evicting LSP child for {} (pool at capacity)",
                        dir.display()
                    );
                    if let Some(c) = children.remove(&dir) {
                        c.shutdown();
                    }
                }
                // Everyone is busy: spawn over capacity rather than block
                // the request behind another session's conversion.
                None => break,
            }
        }

        let child = self.spawn_child(session_dir).await?;
        children.insert(session_dir.to_path_buf(), child.clone());
        Ok(child)
    }

    async fn spawn_child(&self, session_dir: &Path) -> Result<Arc<PooledChild>, LspError> {
        // INFO, once per child: the warm lane engaging (or not) must be
        // visible at default log level — a silently-cold lane already
        // masked one routing bug (the preload gate).
        info!("spawning warm LSP child for {}", session_dir.display());
        let mut child = Command::new(&self.cfg.engine)
            .arg("--server")
            .arg("--timeout")
            .arg(self.cfg.timeout_secs.to_string())
            .arg("--max-memory")
            .arg(self.cfg.max_memory_mb.to_string())
            // Graphics post-processing writes converted images relative
            // to the cwd; the session dir is where the file routes serve.
            .current_dir(session_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(LspError::Spawn)?;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        // stderr forwarder: NEVER leave the pipe undrained (a full pipe
        // blocks the engine mid-conversion). Forward at debug level —
        // the engine's log also travels in each response's `log` field.
        let dir_label = session_dir.display().to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!(target: "lsp_child", "[{dir_label}] {line}");
            }
        });

        let pooled = Arc::new(PooledChild {
            stdin: tokio::sync::Mutex::new(stdin),
            child: std::sync::Mutex::new(Some(child)),
            pending: std::sync::Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(2), // 1 is the initialize handshake
            alive: AtomicBool::new(true),
            last_used_ms: AtomicU64::new(self.now_ms()),
        });

        // Read task: byte-accurate framing, route responses by id.
        let reader_ref = pooled.clone();
        tokio::spawn(async move {
            let mut stdout = stdout;
            let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
            let mut chunk = [0u8; 16 * 1024];
            loop {
                while let Some(body) = take_frame(&mut buf) {
                    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
                        warn!("LSP child sent unparseable frame ({} bytes)", body.len());
                        continue;
                    };
                    let id = msg.get("id").and_then(Value::as_u64);
                    match id {
                        Some(id) => {
                            let tx = reader_ref.pending.lock().expect("pending lock").remove(&id);
                            if let Some(tx) = tx {
                                let _ = tx.send(msg);
                            }
                            // No waiter: response to a request we stopped
                            // caring about (e.g. post-timeout) — drop it.
                        }
                        // Server-initiated notification (publishDiagnostics
                        // from a notification-triggered conversion). The
                        // pool only issues requests, so just trace it.
                        None => {
                            let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("?");
                            debug!("LSP child notification: {method}");
                        }
                    }
                }
                match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break, // EOF: child gone
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            reader_ref.alive.store(false, Ordering::Relaxed);
            // Dropping pending senders errs the awaiting receivers.
            if let Ok(mut pending) = reader_ref.pending.lock() {
                pending.clear();
            }
        });

        // Initialize handshake (the engine answers before any convert).
        let (tx, rx) = oneshot::channel();
        pooled.pending.lock().expect("pending lock").insert(1, tx);
        let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
        {
            let mut stdin = pooled.stdin.lock().await;
            stdin
                .write_all(&frame(&init))
                .await
                .map_err(|_| LspError::ChildDied)?;
            let _ = stdin.flush().await;
        }
        match tokio::time::timeout(Duration::from_secs(20), rx).await {
            Ok(Ok(_)) => Ok(pooled),
            _ => {
                pooled.shutdown();
                Err(LspError::ChildDied)
            }
        }
    }

    async fn reap(&self, session_dir: &Path, child: &Arc<PooledChild>) {
        child.shutdown();
        let mut children = self.children.lock().await;
        // Only remove OUR child — a concurrent respawn may have replaced it.
        if let Some(current) = children.get(session_dir)
            && Arc::ptr_eq(current, child)
        {
            children.remove(session_dir);
        }
    }
}

// ======================================================================
// Tests.
// ======================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(body: &str) -> Vec<u8> {
        frame(&serde_json::from_str::<Value>(body).unwrap())
    }

    #[test]
    fn take_frame_is_byte_accurate_on_multibyte_bodies() {
        // The VS Code extension bug class: π and — are multi-byte in
        // UTF-8, so byte length > char count. The codec must slice by
        // BYTES or it waits forever for phantom chars.
        let body = r#"{"x":"π—…”quotes”"}"#;
        let mut buf = framed(body);
        let bytes = buf.clone();
        assert!(
            bytes.len() > body.chars().count() + 20,
            "fixture must be multi-byte"
        );
        let got = take_frame(&mut buf).expect("complete frame parses");
        assert_eq!(String::from_utf8(got).unwrap(), body);
        assert!(buf.is_empty());
    }

    #[test]
    fn take_frame_handles_fragmentation_and_pipelining() {
        let a = framed(r#"{"id":1}"#);
        let b = framed(r#"{"id":2,"r":"ünïcode"}"#);
        let mut buf: Vec<u8> = Vec::new();
        // Partial header: nothing yet.
        buf.extend_from_slice(&a[..7]);
        assert!(take_frame(&mut buf).is_none());
        // Rest of frame 1 + all of frame 2 in one read.
        buf.extend_from_slice(&a[7..]);
        buf.extend_from_slice(&b);
        assert_eq!(take_frame(&mut buf).unwrap(), br#"{"id":1}"#);
        assert_eq!(
            String::from_utf8(take_frame(&mut buf).unwrap()).unwrap(),
            r#"{"id":2,"r":"ünïcode"}"#
        );
        assert!(take_frame(&mut buf).is_none());
    }

    #[test]
    fn take_frame_resyncs_after_malformed_header() {
        let mut buf = b"Garbage: yes\r\n\r\n".to_vec();
        buf.extend_from_slice(&framed(r#"{"ok":true}"#));
        assert_eq!(take_frame(&mut buf).unwrap(), br#"{"ok":true}"#);
    }

    #[test]
    fn content_length_parser_tolerates_case_and_spacing() {
        assert_eq!(parse_content_length(b"content-LENGTH:  42"), Some(42));
        assert_eq!(
            parse_content_length(b"Other: 1\r\nContent-Length: 7"),
            Some(7)
        );
        assert_eq!(parse_content_length(b"No-Length: 9"), None);
    }
}
