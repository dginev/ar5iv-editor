//! Per-user-per-slot scratch sessions backing the file panel UI.
//!
//! See `docs/FileUI.md` for the full design. The short version: a
//! session is a tmpdir keyed by `(UserId, Slot)`. Same key → same
//! tmpdir; users can flip between examples without losing edits.
//! Sessions are GC'd 10 minutes after the last activity.

use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::TryRngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{debug, warn};

use crate::config::SessionConfig;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Identity tokens — 256-bit OsRng, base64url-encoded. Not UUIDs, not
// serial ids. See `docs/FileUI.md` "Session model" for rationale.
// ---------------------------------------------------------------------------

/// 256-bit cryptographically random token, rendered as 43-char URL-safe
/// base64. Used for both `UserId` and `SessionId`; the two share a shape
/// but live in distinct types so the compiler catches mix-ups.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Token(String);

impl Token {
    pub fn new() -> Self {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng
            .try_fill_bytes(&mut bytes)
            .expect("OsRng failed; refusing to mint a low-entropy token");
        Self(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn as_str(&self) -> &str { &self.0 }

    /// Parse a client-supplied token. Accepts only the 43-char
    /// URL-safe-base64 shape we mint. Anything else → 400.
    pub fn parse(s: &str) -> Result<Self, AppError> {
        if s.len() != 43 {
            return Err(AppError::bad_request("token: bad length"));
        }
        // base64url alphabet — letters, digits, `-`, `_`. Reject padding.
        if !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(AppError::bad_request("token: bad alphabet"));
        }
        // Decode-and-discard to confirm it round-trips.
        URL_SAFE_NO_PAD
            .decode(s.as_bytes())
            .map_err(|_| AppError::bad_request("token: bad encoding"))?;
        Ok(Self(s.to_string()))
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Don't leak the full token into logs — first 8 chars is plenty
        // for cross-referencing while keeping the secret out of plaintext
        // log lines. See `docs/FileUI.md` "Logs and anonymity".
        write!(f, "Token({}…)", &self.0[..self.0.len().min(8)])
    }
}

impl std::fmt::Display for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub type UserId = Token;
pub type SessionId = Token;

// ---------------------------------------------------------------------------
// Slots — the role the session plays for the user. See `docs/FileUI.md`.
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Slot {
    Blank,
    Example(String),
    Upload([u8; 32]),
}

impl Slot {
    /// Parse a wire string of the form `"blank" | "example:<name>" |
    /// "upload:<hex>"`. The example-name validation against the known
    /// list happens at a layer that has the manifest handy
    /// (`AppState::has_example`); here we only enforce shape.
    pub fn parse(s: &str) -> Result<Self, AppError> {
        if s == "blank" {
            return Ok(Slot::Blank);
        }
        if let Some(name) = s.strip_prefix("example:") {
            if name.is_empty()
                || name.len() > 64
                || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(AppError::bad_request("slot: bad example name"));
            }
            return Ok(Slot::Example(name.to_string()));
        }
        if let Some(hex) = s.strip_prefix("upload:") {
            if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(AppError::bad_request("slot: bad upload hash"));
            }
            let mut bytes = [0u8; 32];
            for (i, chunk) in hex.as_bytes().chunks_exact(2).enumerate() {
                bytes[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16)
                    .map_err(|_| AppError::bad_request("slot: bad upload hash"))?;
            }
            return Ok(Slot::Upload(bytes));
        }
        Err(AppError::bad_request("slot: unknown shape"))
    }

    pub fn to_key(&self) -> String {
        match self {
            Slot::Blank => "blank".into(),
            Slot::Example(n) => format!("example:{n}"),
            Slot::Upload(h) => {
                let mut s = String::with_capacity(7 + 64);
                s.push_str("upload:");
                for b in h {
                    use std::fmt::Write;
                    let _ = write!(s, "{b:02x}");
                }
                s
            }
        }
    }
}

impl Serialize for Slot {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_key())
    }
}

impl<'de> Deserialize<'de> for Slot {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        Slot::parse(&s).map_err(serde::de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Session and registry.
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Session {
    /// Public, URL-visible token. Sent in `?session_id=` and the file
    /// routes. **Not** the on-disk directory name — see `dir`.
    pub id:            SessionId,
    pub user_id:       UserId,
    pub slot:          Slot,
    /// On-disk directory. The leaf name is a separately-minted random
    /// token (`disk_token`) that the public `id` is *not* derived from
    /// — leaking a URL therefore does not reveal the on-disk path. The
    /// in-memory registry is the only place the two are connected.
    pub dir:           PathBuf,
    /// The disk-side leaf name, kept beside `dir` so log/route code
    /// can refer to it without re-deriving from the path. Never sent
    /// to the client.
    pub disk_token:    Token,
    pub last_activity: AtomicU64,
    pub bytes_used:    AtomicU64,
    pub file_count:    AtomicU32,
    /// Per-session monotonic write counter. Bumped by every successful
    /// PUT / upload / mkdir / rename / delete; echoed in convert
    /// responses so stale frames cannot overwrite the freshest preview.
    pub version:       AtomicU64,
}

impl Session {
    pub fn touch(&self) {
        self.last_activity.store(now_millis(), Ordering::Relaxed);
    }

    pub fn bump_version(&self) -> u64 {
        // Returns the *new* version (post-increment) so callers can
        // include it in their response payload.
        self.version.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Resolve a user-supplied relative path inside the session dir.
    /// Lexical normalisation only — no `canonicalize` calls, no symlink
    /// dereferences. See `docs/FileUI.md` "Path safety".
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, AppError> {
        if rel.is_empty() {
            return Err(AppError::bad_request("path: empty"));
        }
        if rel.bytes().any(|b| b == 0) {
            return Err(AppError::bad_request("path: NUL byte"));
        }
        if rel.contains('\\') {
            return Err(AppError::bad_request("path: backslash"));
        }
        let p = Path::new(rel);
        if p.is_absolute() {
            return Err(AppError::bad_request("path: absolute"));
        }
        let mut clean = PathBuf::new();
        for c in p.components() {
            match c {
                Component::Normal(s) => {
                    let bytes = s.as_encoded_bytes();
                    if bytes.is_empty() {
                        return Err(AppError::bad_request("path: empty segment"));
                    }
                    clean.push(s);
                }
                Component::CurDir => {} // skip `.`
                Component::ParentDir
                | Component::RootDir
                | Component::Prefix(_) => {
                    return Err(AppError::bad_request("path: traversal"));
                }
            }
        }
        if clean.as_os_str().is_empty() {
            return Err(AppError::bad_request("path: empty"));
        }
        Ok(self.dir.join(clean))
    }
}

#[derive(Default, Debug)]
struct RegistryInner {
    by_id:   HashMap<SessionId, Arc<Session>>,
    by_slot: HashMap<(UserId, String), SessionId>,
    /// Per-user MRU queue — back is most-recent. Used at insert time to
    /// evict the oldest slot once the user is at the per-user cap.
    by_user: HashMap<UserId, VecDeque<SessionId>>,
}

/// Holds every live session and the GC-ordered ↔ id ↔ slot indices.
pub struct SessionRegistry {
    cfg:   SessionConfig,
    inner: RwLock<RegistryInner>,
}

impl SessionRegistry {
    pub fn new(cfg: SessionConfig) -> Self {
        Self { cfg, inner: RwLock::new(RegistryInner::default()) }
    }

    pub fn config(&self) -> &SessionConfig { &self.cfg }

    /// Walk the sessions-root and remove any subdirectory that is *not*
    /// currently registered AND whose mtime is older than the idle
    /// timeout. Called on every session create and once at startup so
    /// crashes / unclean shutdowns don't leak disk forever.
    ///
    /// Live sessions are identified by their `disk_token` (the
    /// directory leaf), not by the public `id`, so this check works
    /// after the v1.2 disk/URL decoupling.
    ///
    /// Errors during the walk are logged and swallowed — the call site
    /// is best-effort hygiene, not a correctness gate.
    pub async fn sweep_orphans(&self) {
        let live: std::collections::HashSet<String> = {
            let inner = self.inner.read().await;
            inner
                .by_id
                .values()
                .map(|s| s.disk_token.as_str().to_string())
                .collect()
        };

        let cutoff = std::time::SystemTime::now()
            .checked_sub(self.cfg.idle_timeout)
            .unwrap_or(std::time::UNIX_EPOCH);

        let mut entries = match tokio::fs::read_dir(&self.cfg.sessions_dir).await {
            Ok(e) => e,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(err) => {
                warn!(error = %err, "sweep_orphans: read_dir failed");
                return;
            }
        };

        let mut to_delete: Vec<PathBuf> = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else { continue };
            // Skip names that match a live session — fast O(1) hash hit.
            if live.contains(name_str) {
                continue;
            }
            // Cheap shape filter: only consider entries that *look*
            // like our 43-char tokens so we can't accidentally nuke
            // an admin's hand-placed file under the sessions root.
            if name_str.len() != 43
                || !name_str
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                continue;
            }
            let path = entry.path();
            let stale = match tokio::fs::metadata(&path).await {
                Ok(m) => match m.modified() {
                    Ok(t) => t < cutoff,
                    // No mtime support → treat as stale to avoid leaks.
                    Err(_) => true,
                },
                Err(_) => continue,
            };
            if stale {
                to_delete.push(path);
            }
        }

        for d in to_delete {
            if let Err(e) = tokio::fs::remove_dir_all(&d).await {
                warn!(path = %d.display(), error = %e, "sweep_orphans: remove_dir_all failed");
            } else {
                debug!(path = %d.display(), "sweep_orphans: removed stale dir");
            }
        }
    }

    /// Look up a session by id. Returns 410 if it doesn't exist (the
    /// session may have been GC'd or never existed). The 403/410 split
    /// for ownership lives at the route layer — this method does not
    /// check `user_id`.
    pub async fn get(&self, id: &SessionId) -> Result<Arc<Session>, AppError> {
        let inner = self.inner.read().await;
        inner.by_id.get(id).cloned().ok_or_else(|| AppError::session_expired())
    }

    /// Lookup-or-create. If the (user, slot) pair already maps to a
    /// live session, return its id and bump it to the back of the
    /// user's MRU queue. Otherwise mint a fresh tmpdir, run `seed`
    /// to populate it, register it, and return the new id.
    ///
    /// `seed` runs *outside* the registry write lock, with the new
    /// session's path as input, so heavy IO doesn't block other
    /// callers. If `seed` fails the half-built dir is removed and
    /// the error propagates.
    pub async fn lookup_or_create<F, Fut>(
        &self,
        user_id: &UserId,
        slot: &Slot,
        seed: F,
    ) -> Result<Arc<Session>, AppError>
    where
        F:   FnOnce(PathBuf) -> Fut,
        Fut: std::future::Future<Output = Result<(u64, u32), AppError>>,
    {
        // Fast path: existing session.
        {
            let mut inner = self.inner.write().await;
            if let Some(existing_id) = inner.by_slot.get(&(user_id.clone(), slot.to_key())).cloned()
                && let Some(s) = inner.by_id.get(&existing_id).cloned()
            {
                bump_to_mru_back(&mut inner, user_id, &existing_id);
                s.touch();
                return Ok(s);
            }
        }

        // Opportunistic disk-space hygiene: every fresh session is a
        // good moment to sweep orphans (unregistered dirs whose mtime
        // is older than the idle timeout). Cheap (one read_dir per
        // create) and covers crash-survivors that the periodic GC tick
        // never saw register. See `sweep_orphans`.
        self.sweep_orphans().await;

        // Slow path: prepare a new tmpdir outside the lock so disk IO
        // doesn't serialise. We mint two unrelated 256-bit tokens —
        // `new_id` is what the client sees in URLs, `disk_token` is
        // what becomes the directory name. The pair is only joined in
        // the in-memory registry, so a leaked URL never reveals the
        // on-disk path. See `Session::dir`.
        let new_id = SessionId::new();
        let disk_token = Token::new();
        let dir = self.cfg.sessions_dir.join(disk_token.as_str());
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| AppError::internal(format!("mkdir session dir: {e}")))?;

        let seed_result = seed(dir.clone()).await;
        let (bytes_used, file_count) = match seed_result {
            Ok(stats) => stats,
            Err(e) => {
                // Best-effort cleanup; ignore the secondary error so
                // the original cause is what the caller sees.
                let _ = tokio::fs::remove_dir_all(&dir).await;
                return Err(e);
            }
        };

        let session = Arc::new(Session {
            id:            new_id.clone(),
            user_id:       user_id.clone(),
            slot:          slot.clone(),
            dir,
            disk_token,
            last_activity: AtomicU64::new(now_millis()),
            bytes_used:    AtomicU64::new(bytes_used),
            file_count:    AtomicU32::new(file_count),
            version:       AtomicU64::new(0),
        });

        // Re-lock to insert. Race window: another caller for the same
        // (user, slot) may have completed in the meantime; if so, drop
        // ours and return theirs. Cheap correctness over fancy
        // optimistic concurrency.
        {
            let mut inner = self.inner.write().await;
            let key = (user_id.clone(), slot.to_key());
            if let Some(existing_id) = inner.by_slot.get(&key).cloned()
                && let Some(s) = inner.by_id.get(&existing_id).cloned()
            {
                drop(inner);
                let _ = tokio::fs::remove_dir_all(&session.dir).await;
                return Ok(s);
            }

            // Per-user-cap eviction. The list returned here lists ids
            // queued for fs cleanup *after* we drop the lock.
            let to_evict = enforce_per_user_cap(
                &mut inner,
                user_id,
                self.cfg.quota_sessions_per_user,
            );

            inner.by_id.insert(new_id.clone(), session.clone());
            inner
                .by_slot
                .insert(key, new_id.clone());
            inner
                .by_user
                .entry(user_id.clone())
                .or_default()
                .push_back(new_id.clone());

            drop(inner);
            for evict_dir in to_evict {
                let _ = tokio::fs::remove_dir_all(&evict_dir).await;
            }
        }

        Ok(session)
    }

    /// One pass of the GC loop: take the registry write lock, remove
    /// any session idle longer than `idle_timeout`, then drop the lock
    /// and `remove_dir_all` the directories. Order matters — see
    /// `docs/FileUI.md` "GC ordering and the request race".
    pub async fn gc_once(&self) {
        let cutoff = now_millis().saturating_sub(self.cfg.idle_timeout.as_millis() as u64);
        let mut to_delete: Vec<PathBuf> = Vec::new();
        {
            let mut inner = self.inner.write().await;
            let stale: Vec<SessionId> = inner
                .by_id
                .iter()
                .filter_map(|(id, s)| {
                    if s.last_activity.load(Ordering::Relaxed) < cutoff {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();
            for id in stale {
                if let Some(s) = inner.by_id.remove(&id) {
                    let key = (s.user_id.clone(), s.slot.to_key());
                    inner.by_slot.remove(&key);
                    if let Some(q) = inner.by_user.get_mut(&s.user_id) {
                        q.retain(|x| x != &id);
                        if q.is_empty() {
                            inner.by_user.remove(&s.user_id);
                        }
                    }
                    to_delete.push(s.dir.clone());
                }
            }
        }
        for d in to_delete {
            if let Err(e) = tokio::fs::remove_dir_all(&d).await {
                warn!(path = %d.display(), error = %e, "GC: remove_dir_all failed");
            } else {
                debug!(path = %d.display(), "GC: removed session dir");
            }
        }
    }

    /// Spawn a background task that calls `gc_once` every
    /// `gc_interval` and `sweep_orphans` once per minute. Returns the
    /// join handle so tests can stop it.
    pub fn spawn_gc(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(me.cfg.gc_interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // Sweep orphans on a coarser schedule than the registry
            // GC — once every ~2 minutes is plenty for crash-survivor
            // cleanup. Counted in `gc_interval` units to keep the
            // tunable surface minimal.
            let orphan_every: u32 = (120 / me.cfg.gc_interval.as_secs().max(1) as u32).max(1);
            let mut tick_count: u32 = 0;
            loop {
                tick.tick().await;
                me.gc_once().await;
                tick_count = tick_count.wrapping_add(1);
                if tick_count.is_multiple_of(orphan_every) {
                    me.sweep_orphans().await;
                }
            }
        })
    }

    /// Mint a fresh `UserId` (tracked in `users`-by-IP rate-limiting at
    /// the route layer, not here).
    pub fn mint_user_id(&self) -> UserId { UserId::new() }
}

fn bump_to_mru_back(
    inner: &mut RegistryInner,
    user_id: &UserId,
    sid: &SessionId,
) {
    let q = inner.by_user.entry(user_id.clone()).or_default();
    q.retain(|x| x != sid);
    q.push_back(sid.clone());
}

/// Evict the user's oldest slots until they are below the cap, *minus
/// one* (so the caller can immediately insert without exceeding it).
/// Returns the directories that need to be `remove_dir_all`'d after
/// the registry lock is dropped.
fn enforce_per_user_cap(
    inner: &mut RegistryInner,
    user_id: &UserId,
    cap: usize,
) -> Vec<PathBuf> {
    let mut evicted_dirs = Vec::new();
    let q = inner.by_user.entry(user_id.clone()).or_default();
    while q.len() >= cap {
        let Some(oldest) = q.pop_front() else { break };
        if let Some(s) = inner.by_id.remove(&oldest) {
            inner.by_slot.remove(&(s.user_id.clone(), s.slot.to_key()));
            evicted_dirs.push(s.dir.clone());
        }
    }
    evicted_dirs
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_round_trips() {
        let t = Token::new();
        assert_eq!(t.as_str().len(), 43);
        let parsed = Token::parse(t.as_str()).unwrap();
        assert_eq!(t, parsed);
    }

    #[test]
    fn token_rejects_bad_input() {
        assert!(Token::parse("").is_err());
        assert!(Token::parse("too short").is_err());
        // Wrong length with otherwise-valid alphabet.
        assert!(Token::parse(&"A".repeat(42)).is_err());
        assert!(Token::parse(&"A".repeat(44)).is_err());
        // Padding character `=` is not in the URL-safe-no-pad alphabet.
        let mut padded = "a".repeat(42);
        padded.push('=');
        assert!(Token::parse(&padded).is_err());
        // Correct shape (round-tripped) must still pass.
        let live = Token::new();
        assert!(Token::parse(live.as_str()).is_ok());
    }

    #[test]
    fn slot_parses_round_trip() {
        for raw in ["blank", "example:foo", "example:foo-bar_1"] {
            let s = Slot::parse(raw).unwrap();
            assert_eq!(s.to_key(), raw);
        }
        let upload_key = format!("upload:{}", "ab".repeat(32));
        let s = Slot::parse(&upload_key).unwrap();
        assert_eq!(s.to_key(), upload_key);
    }

    #[test]
    fn slot_rejects_bad_input() {
        assert!(Slot::parse("").is_err());
        assert!(Slot::parse("Blank").is_err()); // case-sensitive
        assert!(Slot::parse("example:").is_err());
        assert!(Slot::parse("example:bad name").is_err());
        assert!(Slot::parse("upload:short").is_err());
        assert!(Slot::parse("upload:zz").is_err());
        assert!(Slot::parse("garbage").is_err());
    }

    #[test]
    fn resolve_accepts_clean_paths() {
        let s = make_test_session();
        assert!(s.resolve("main.tex").is_ok());
        assert!(s.resolve("sub/main.tex").is_ok());
        assert!(s.resolve("./main.tex").is_ok());
    }

    #[test]
    fn resolve_rejects_traversal() {
        let s = make_test_session();
        assert!(s.resolve("").is_err());
        assert!(s.resolve("/abs").is_err());
        assert!(s.resolve("../escape").is_err());
        assert!(s.resolve("ok/../escape").is_err());
        assert!(s.resolve("nul\0byte").is_err());
        assert!(s.resolve("back\\slash").is_err());
    }

    fn make_test_session() -> Session {
        Session {
            id:            SessionId::new(),
            user_id:       UserId::new(),
            slot:          Slot::Blank,
            dir:           PathBuf::from("/tmp/ar5iv-test-session"),
            disk_token:    Token::new(),
            last_activity: AtomicU64::new(0),
            bytes_used:    AtomicU64::new(0),
            file_count:    AtomicU32::new(0),
            version:       AtomicU64::new(0),
        }
    }
}
