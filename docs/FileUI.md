# File Panel UI for Anonymous Sessions — Plan v1.2

A left-hand file tree panel (Overleaf-style), per-user anonymous sessions
with server-side scratch directories, file upload, and 10-minute
inactivity GC. Existing two-pane shell becomes a three-pane shell with
two draggable vertical resizers.

This is **v1.2** of the plan. v1 and v1.1 are preserved in git history.
v1.2 introduces a **per-user, per-slot session model** so that loading an
example creates (or reuses) a tmpdir scoped to that example — repeated
picks of the same example never multiply directories, and edits made to
example A are still there when the user comes back to it from example B
within the idle window.

## Goals

1. Anonymous user gets a private working directory the moment they open
   `/editor`. No login, no DB, no persistence across server restarts.
2. They can create files/folders, upload files (text and binary, including
   graphics), rename, delete, and switch which file the editor is editing.
3. Conversions resolve `\input{chapter}`, `\includegraphics{fig}`,
   `\usepackage{mystyle}` against the active session's directory.
4. Loading an example uses (or creates) one tmpdir per (user, example).
   Repeated picks reuse; concurrent examples each have their own tmpdir
   so unsaved edits in one are preserved while the user explores another.
5. Sessions are GC'd 10 minutes after the last activity; the directory is
   removed.
6. The shell has three panes (files / source / preview) with two draggable
   vertical separators that persist their widths to localStorage and are
   pointer-driven (mouse + touch).

## Non-goals (v1.2)

- Multi-user collaboration, login, persistence across restarts.
- File rename / delete operations in the file panel UI. The server's
  rename/delete routes are still implemented (and tested) for ZIP-import
  and future use, but the frontend exposes neither in v1.2 — the kebab
  menu shows only "Download." Rationale: rename/delete have non-trivial
  active-file UX consequences (follow-the-rename, fall-back-on-delete)
  that we'd rather design once we have user feedback than guess at now.
- Server-side compilation across multiple `.tex` files into one HTML
  output beyond what `\input` already does.
- File search, git, or diffs.
- Image preview inside the file panel beyond an extension-derived icon.

## Phase 0 — De-risk (½ day)

Before any UI work, write a throwaway integration test that:

1. Creates a tmpdir.
2. Drops `chapter1.tex` (`Hello \(x^2\)`) and `fig.png` (any tiny PNG)
   into it.
3. Builds an `OxideConfig` with `search_paths: Some(vec![tmpdir.clone()])`.
4. Runs a doc that does `\input{chapter1}` and
   `\includegraphics[width=2cm]{fig}` through `Converter::convert`.
5. Asserts `<math` and `<img` (or `data:image/png` inline) appear in the
   HTML output, with `status_code == 0`.

Outcome decides which architecture below ships:

- **Pass:** the rest of the plan is web plumbing; proceed as written.
- **Fail (search_paths ignored / partial):** fall back to either
  (a) `std::env::set_current_dir` on the worker thread per request, or
  (b) lexically rewriting `\input` / `\includegraphics` paths to absolute
  on the way in. (a) is incompatible with the single-thread engine if
  multiple sessions converge; (b) is uglier but safe. Either path
  inflates the budget by ~1 day.

Budget: ½ day. If the test fails fast and the fix is mechanical, less.

## Architecture

### Source of truth for the active buffer (decided)

Every file the user can edit lives on disk in the active session's
directory. The WebSocket convert request **does not carry the source
text**; it carries the path of the file to convert. Before sending the
convert frame, the client PUTs the active buffer to that path and awaits
the ack. This is the single most important shape decision in v1.1:

- one place to read from at conversion time (disk),
- no possibility of the wire copy and the disk copy diverging mid-edit,
- `\input{other}` always resolves consistently with what the user sees
  in the file panel.

The cost is one extra PUT round-trip per convert. With `keep-alive`'d
HTTP/1.1 (or HTTP/2 if we add it later), this is sub-ms on localhost
and a small constant in production.

### Session model (revised in v1.2)

A session is a tmpdir keyed by a `(user_id, slot)` pair, not just a
random id. This is what allows examples to dedupe: picking "calculus"
twice maps to the same `(user_id, "example:calculus")` key, hence the
same tmpdir.

- `UserId` is a **256-bit cryptographically random token**, generated
  from `OsRng` and rendered as 43-char URL-safe base64 (no padding).
  It is *not* a serial id, *not* a UUID, and carries no embedded
  metadata (no timestamp, no MAC, no counter): just 32 bytes of
  entropy. Minted by the server on the user's first visit, returned
  to the browser, and stored client-side in `localStorage`. It is a
  pure capability — possession of the token grants access to all
  sessions under that key, and the token has no anonymity-leaking
  structure. The server stores user ids only as in-memory map keys,
  alongside `last_activity`; nothing is logged that ties a user id to
  an IP address (logs use a per-request request-id, not the user
  token).
- `Slot` is a short string identifying the *role* of the session:
  - `"blank"` — the default scratch session a new user lands in.
  - `"example:<name>"` — one slot per example name, dedup target.
  - `"upload:<sha256-hex-prefix>"` — one slot per imported ZIP archive,
    keyed by content hash so re-uploads of the same archive dedup.
- `SessionId` is a **256-bit cryptographically random token** with the
  same shape as `UserId` (43-char base64url). Minted server-side at
  session creation. The id is what the file routes and the WS upgrade
  URL refer to; the `(user_id, slot)` key is the *lookup* used by
  examples and bootstrap. Unguessable by design — the convert/file
  routes treat the session id as a bearer credential bound to the
  owning user id (the server checks `X-Ar5iv-User` on every request).
- **Disk vs URL identity are decoupled.** The on-disk leaf name is a
  *separate* 256-bit token (`disk_token`), not derived from the public
  `SessionId`. The pair is joined only in the in-memory registry. A
  leaked URL or a tracing log line therefore reveals nothing about the
  filesystem layout, and the disk-side namespace is independently
  greppable for hygiene tooling.
- `SessionRegistry` holds two maps under one `RwLock`:
  - `by_id:    HashMap<SessionId, Arc<Session>>` — fast id-keyed access
    for the file routes and the WS handler.
  - `by_slot:  HashMap<(UserId, Slot), SessionId>` — dedup index used
    only at lookup-or-create time.
- `Session` owns:
  - `id: SessionId`
  - `user_id: UserId`
  - `slot: Slot`
  - `dir: PathBuf` — `<base>/<id>/`, where `<base>` is canonicalised
    once at startup. Default base:
    `std::env::temp_dir().join("ar5iv-editor-sessions")`,
    overridable via `AR5IV_EDITOR_SESSIONS_DIR`.
  - `last_activity: AtomicU64` — unix-millis. Bumped on every received
    WS frame, every successful HTTP file route, and every conversion.
  - `bytes_used: AtomicU64`, `file_count: AtomicU32` — quotas.
- A tokio task in `main.rs` ticks every 30 s and runs the GC sweep
  described below. Idle-timeout slack is therefore up to 30 s past the
  configured **10 minutes**; this is acceptable.

Lookup-or-create flow (used by example loading and bootstrap):

1. Take the registry write lock.
2. Look up `(user_id, slot)` in `by_slot`. If present and the
   `Arc<Session>` is in `by_id`, return its id (existing tmpdir reused).
3. Otherwise, mint a new `SessionId`, create the dir, seed it from the
   slot's template (the example's source for `"example:<name>"`, the
   welcome `main.tex` for `"blank"`), insert into both maps, return
   the id.
4. Enforce per-user session cap before insert; if the user is over,
   evict their oldest-by-`last_activity` slot first.

### Orphan sweep on session create

A periodic GC tick deletes registered sessions that have gone idle.
That misses two cases:

1. **Crash survivors.** A previous run that exited uncleanly leaves
   tmpdirs under `sessions_root` that no live registry knows about.
2. **Race-window survivors.** A `mkdir` between the lookup-or-create
   write-lock-acquire and the registry insert could leave a dir if
   the seed function panicked between the two.

`SessionRegistry::sweep_orphans()` walks `sessions_root`, intersects
filenames against the live `disk_token` set, and removes any entry
whose name matches the 43-char token shape AND whose mtime is older
than `idle_timeout`. The shape filter ("not a token-shaped name →
keep") makes accidental deletion of admin-placed files (`README`,
`.htaccess`, etc.) under the sessions root impossible.

The sweep runs:

- **At startup**, before the first request — this is where most
  benefit lands; previous-run leftovers are deleted before any new
  session is minted.
- **At every `lookup_or_create` call** — a small per-create cost, but
  it puts the cleanup invariant on the hottest path. Worst case is
  one `read_dir` per session creation, which is cheap relative to the
  rest of session-create.
- **As part of the periodic GC task**, every ~2 minutes — covers the
  case where a server runs for a long time without any new sessions
  being created.

### GC ordering and the request race (decided)

Sessions can be GC'd while a request is in flight. The protocol:

1. The GC sweep takes the registry write lock, scans, and *removes the
   registry entries* (both `by_id` and `by_slot`) for any expired
   session.
2. After the lock is released, the sweep `tokio::fs::remove_dir_all`'s
   each removed session's directory.

In-flight requests that hold an `Arc<Session>` from before step 1 will
hit ENOENT (or EACCES, on the unlinked dir) when they touch disk. The
file routes catch any IO error whose path lies inside the (now-removed)
session dir and respond **`410 Gone`** with a JSON body
`{ "code": "session_expired" }`. The frontend treats `410 session_expired`
as "this slot needs to be reopened": it re-issues the lookup-or-create
call for the slot it was last on (typically `"blank"`), reloads the
file list, then continues. The convert worker maps the same condition
to a `ConvertResponse` with status `"session_expired"` and
`status_code: 4` (new code; existing codes are 0/3).

### Quotas (anonymous = abusable)

- Max 50 MB per session.
- Max 200 files per session.
- Max 10 MB per single uploaded file.
- Max 25 MB per uploaded ZIP archive (after extraction limits below).
- Max 8 concurrent sessions per `user_id` (oldest-by-`last_activity`
  evicted on overflow).
- Max 16 `user_id`s per remote IP at once.
- Max 2 GB used by the sessions root directory; refuse new sessions
  beyond that with `503 Service Unavailable` and a clear message.
- All limits configurable via env vars with sensible defaults.

Per-user cap is the headline disk-pollution defence: an enthusiastic
example-clicker will create at most 8 tmpdirs before older ones start
eviction-GCing automatically, regardless of the 10-minute idle clock.

The 2 GB cap is checked at session-create time (cheap fs walk of the
sessions root, cached for ~10 s). It is the difference between a
graceful "come back later" and a server outage.

### Path safety (decided)

Path traversal is the highest-impact defect class for this feature.
The rule is **lexical normalisation, not canonicalisation**:

1. Every user-supplied path is parsed as a relative path.
2. Reject anything containing a `..` segment, an absolute prefix, an
   empty segment, a `\` separator (Windows-style), a NUL byte, or a
   leading `/`.
3. After normalisation, join onto the (already-canonicalised at startup)
   `session.dir` and use the result.

We **never** call `fs::canonicalize` on user input, because canonicalize
follows symlinks and a future codepath that creates symlinks (or accepts
them via ZIP) would silently extend the attack surface.

Symlinks are refused at every creation site:

- `PUT /api/session/.../files/*path`: writes via
  `OpenOptions::new().write(true).create(true).truncate(true).custom_flags(O_NOFOLLOW)`
  (Unix) so an existing symlink at the target fails the open.
- Multipart upload: same.
- Folder upload: each entry passes through `resolve` and the same
  `O_NOFOLLOW` write path; folder structure is reconstructed from the
  browser's relative paths, never from absolute paths.
- `mkdir`: refuses if the parent path traversal touches a symlink.
- ZIP upload (v1): symlink entries (`mode & S_IFLNK`) are rejected before
  any extraction. Path traversal in entry names is rejected by the same
  `resolve` chokepoint. See "ZIP upload" below for the full rule set.

A small helper

```rust
fn resolve(session: &Session, rel: &str) -> Result<PathBuf, AppError>
```

is the single chokepoint; routes never assemble paths themselves.

### HTTP routes (new)

All routes are under `/api`. The user id is supplied via the
`X-Ar5iv-User` header on every request (sent by the frontend, sourced
from `localStorage`). The server rejects requests whose `user_id` does
not own the targeted session.

| Method | Path                                  | Body                         | Response                            |
|--------|---------------------------------------|------------------------------|-------------------------------------|
| POST   | `/api/user`                           | —                            | `{ user_id }` (mints + returns)     |
| POST   | `/api/session`                        | `{ slot }`                   | `{ id, slot, files: [...] }`        |
| GET    | `/api/session/{id}/files`             | —                            | `{ files: [{ path, size, kind }] }` |
| GET    | `/api/session/{id}/files/{*path}`     | —                            | file bytes (text or binary)         |
| PUT    | `/api/session/{id}/files/{*path}`     | bytes (octet-stream)         | `{ size, mtime }`                   |
| POST   | `/api/session/{id}/upload`            | multipart (files or folder)  | `{ files: [{ path, size }] }`       |
| POST   | `/api/session/{id}/upload-zip`        | application/zip              | `{ files: [{ path, size }] }`       |
| POST   | `/api/import-zip`                     | application/zip              | `{ id, slot, files: [...] }`        |
| POST   | `/api/session/{id}/mkdir`             | `{ path }`                   | `{ ok: true }`                      |
| POST   | `/api/session/{id}/rename`            | `{ from, to }`               | `{ ok: true }`                      |
| DELETE | `/api/session/{id}/files/{*path}`     | —                            | `{ ok: true }`                      |

Behaviour:

- `POST /api/session` is **lookup-or-create**: if the calling user
  already has a session for the requested slot, its id is returned;
  otherwise a fresh tmpdir is minted, seeded for the slot, and
  returned. This is the single primitive that examples and bootstrap
  share.
- `POST /api/import-zip` creates a *new project* — i.e., a new slot
  named `"upload:<sha256-hex-prefix>"` derived from the archive
  contents — and unpacks the ZIP into it. Re-uploading the same archive
  is therefore idempotent; the user keeps editing whatever they had
  there last time. Returns the same shape as `POST /api/session`.
- `POST /api/session/{id}/upload-zip` is the alternative: extract into
  the *current* session (overlaying or refusing on collision per query
  param `?on_conflict=skip|overwrite`, default `skip`).

General behaviour:

- `*path` is Axum's wildcard; nested paths supported.
- File listing returns a flat array of relative paths plus a `kind`
  enum (`"text"`, `"binary"`, `"dir"`). The frontend builds the tree.
- Multipart uploads **stream to disk** through `axum::extract::Multipart`
  (no per-request memory buffer). Each field's filename is normalised
  through `resolve` before any bytes are written. The frontend may
  populate filenames from `webkitdirectory`-style folder selection;
  relative paths in the upload preserve folder structure.
- Upload **extension allowlist**: `.tex`, `.sty`, `.cls`, `.bib`,
  `.bst`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.pdf`, `.eps`,
  `.csv`, `.txt`, `.md`, `.toml`, `.json`, `.yaml`, `.yml`. Anything
  else: `415 Unsupported Media Type` with the rejected name in the
  body.
- Quota and session-expiry checks apply uniformly; both bump
  `last_activity` only on success (no free keepalive from a 4xx).
- Every successful upload / PUT / rename / delete returns a small
  `version: u64` field (per-session monotonic counter). The frontend
  uses it to trigger an automatic re-convert (see "Auto re-convert"
  below) and to ignore convert results that race a still-pending
  write.

### Editor-openable extension allowlist (decided)

The frontend opens these extensions in CodeMirror:
`.tex`, `.sty`, `.cls`, `.bib`, `.bst`, `.txt`, `.md`, `.csv`,
`.toml`, `.json`, `.yaml`, `.yml`, `.svg`. Anything else (`.png`,
`.pdf`, ...) shows a metadata stub in the source pane: filename, size,
type, "use in your TeX as `\includegraphics{name}`."

### WebSocket changes

The session is bound at upgrade time, not per frame:

```
/convert?session_id={uuid}
```

`ws_handler` extracts the query, looks up the session, and either:

- accepts the upgrade and stores `Arc<Session>` on the connection state, or
- rejects with `1008 Policy Violation` and a body of `session_expired`
  if the session is unknown.

`ConvertRequest` changes:

- **Removed:** `tex` field. The source comes from disk now.
- **Added:** `active_file: String` — the relative path within the
  session of the file to convert. The worker reads
  `session.dir.join(active_file)` directly; the file must already exist
  (PUT'd by the client moments earlier).
- `preamble`, `profile`, `format`, `preload` unchanged.

Convert worker:

- `OxideConfig.search_paths = Some(vec![session.dir.clone()])`.
- Reads `active_file` from disk into the `tex` string passed to
  `Converter::convert`. (Internally the engine still wants a string;
  we just read it ourselves rather than trusting the wire.)
- Bumps `last_activity` on success and on superseded.

The WS handler bumps `last_activity` on **any** received frame
(text/binary/ping/pong); WebSocket-level pings the browser sends are
visible to Axum/tokio-tungstenite as `Message::Ping`. There is **no
app-level heartbeat protocol**; the existing per-keystroke convert
traffic plus browser pings is more than enough to keep an active tab's
session alive. A truly idle tab (no edits for 10 min) is, by intent,
exactly the case the GC handles.

### Auto re-convert (the live preview is the headline feature)

The preview must visibly catch up the moment any input the active file
depends on changes — keystrokes, sure, but also: a graphic just
finished uploading, a `\input{chapter1}` just got its body PUT, a ZIP
just unpacked, a file got renamed. The rule is simple and uniform:

> **Every state change to the session directory triggers a re-convert
> of the currently-active file.**

Implementation:

- The frontend keeps a single `requestPreview()` entrypoint that
  schedules a debounced (300 ms) convert for the active file.
- Editor edits call it on every keystroke, after the debounced PUT
  resolves. The PUT-then-convert chain is unchanged from v1.1.
- File-route operations (upload single, upload multiple, upload
  folder, upload-zip, import-zip, mkdir, rename, delete) call
  `requestPreview()` once when their HTTP response resolves
  successfully — even if the file the user is editing wasn't itself
  changed. Rationale: a ZIP upload that drops in `figures/fig.png`
  changes what `\includegraphics{figures/fig}` resolves to, even
  though the active `main.tex` didn't change.
- Each convert request carries the `version: u64` of the most recent
  successful write (server-assigned). The convert worker echoes the
  version back; the frontend ignores any response whose version is
  older than the latest write currently pending. (Existing
  `superseded`-by-id logic in `ws.rs` already handles same-buffer
  staleness; this extends the idea to "stale w.r.t. the filesystem.")
- Failure of a file op skips the auto-convert (no re-convert on the
  user's stale state).
- Bulk operations (folder upload, ZIP) deliberately fire
  `requestPreview()` exactly once, after the *whole* upload settles —
  not once per inner file. The debounce already coalesces but
  anchoring on the bulk-op's resolution avoids 200 spurious
  intermediate previews.

### Frontend bootstrap (decided)

The frontend keeps two pieces of identity:

- `localStorage["ar5iv.user_id"]` — minted by the server, persistent
  across tabs and reloads, identifies the user for slot dedup. Sent as
  `X-Ar5iv-User` on every API request.
- `sessionStorage["ar5iv.current_slot"]` — which slot this *tab* is
  currently looking at (`"blank"`, `"example:calculus"`, etc.). Per-tab,
  so different tabs can edit different examples in parallel.

On page load:

1. Read `localStorage["ar5iv.user_id"]`. If absent, `POST /api/user`,
   store the returned id.
2. Read `sessionStorage["ar5iv.current_slot"]`, defaulting to `"blank"`.
3. `POST /api/session { slot }` (lookup-or-create). Store the returned
   `id` in memory only — it's a derivable function of `(user_id, slot)`,
   not a primary key the client owns.
4. Hydrate the file panel from the response's `files` listing. Set the
   active file to `main.tex` (or, for example slots, whatever the
   example calls its entry file — recorded in the example metadata).

When the user picks a different example from the dropdown:

1. Update `sessionStorage["ar5iv.current_slot"]`.
2. `POST /api/session { slot: "example:<name>" }`. The server returns
   the existing id if the user has been here before; otherwise it
   mints a fresh tmpdir, copies the example's source files in, and
   returns its id.
3. Replace the file panel and the editor's BufferStore with the new
   listing.

On `410 session_expired` from any subsequent request, the frontend
re-runs step 3 of bootstrap with the current slot — the server will
mint a new tmpdir if needed.

The file routes accept `If-None-Match` ETags later; v1 keeps it dumb.

### Frontend layout

`templates/editor.html` becomes:

```html
<section class="ar5iv-editor-shell">
  <div class="pane pane-files">…</div>
  <div class="resizer" data-edge="files-source" role="separator"
       aria-orientation="vertical" tabindex="0"></div>
  <div class="pane pane-source">…</div>
  <div class="resizer" data-edge="source-preview" role="separator"
       aria-orientation="vertical" tabindex="0"></div>
  <div class="pane pane-preview">…</div>
</section>
```

CSS Grid:

```css
.ar5iv-editor-shell {
  display: grid;
  grid-template-columns: var(--w-files, 14rem)
                         4px
                         var(--w-source, 1fr)
                         4px
                         minmax(0, 1fr);
}
```

`frontend/src/resizers.ts`: PointerEvents on each resizer
(`pointerdown` / `pointermove` / `pointerup` / `pointercancel`,
`setPointerCapture`), update CSS vars on the host, persist to
`localStorage` on `pointerup`. Keyboard nudging via Left/Right when
the resizer has focus (a11y). PointerEvent works for mouse and touch
uniformly, so narrow-screen drag-to-resize is free.

A media-query fallback for viewports < 700 px collapses `.pane-files`
to a 2 rem icon strip with a "show file panel" toggle. The resizer
between files and source is hidden in that mode; the source/preview
resizer remains.

### Status-click log toggle (preserved)

The current click-on-status toggle hides the preview and shows the
conversion log in its place. Three-pane refactor preserves this:
the `#log` element still lives inside `.pane-preview` and the existing
`bootLogToggle()` keeps working with no edits.

### Frontend file panel

`frontend/src/files.ts`:

- `FileTree`: holds a `Map<path, FileEntry>` (path is
  forward-slash-separated, relative), renders a collapsible tree into
  `.pane-files`, and emits events on click / double-click / context.
- Header buttons: New file, New folder, Upload, Collapse-pane.
- Per-row kebab menu in v1.2: **Download only**. (Rename and Delete
  intentionally deferred — see Non-goals.)
- Drag-and-drop upload onto the panel; hover styling.
- Active-file highlight; click switches the editor's active buffer.
- Binary / non-editor-allowlisted files: clicking shows the metadata
  stub in the source pane instead of opening in CodeMirror.

### Editor multi-buffer

`editor.ts` is extended with `BufferStore`:

- `Map<path, EditorState>` keyed by relative path.
- "Current path" pointer; `setActive(path)` does
  `view.setState(buffers.get(path))`. Because each `EditorState` holds
  its own selection, scroll position, and history, switching files
  preserves cursor and undo per buffer for free.
- Loading a not-yet-cached file: GET its bytes, build an `EditorState`
  with the same extensions, store, then `setActive`.
- Per-buffer dirty flag, reset on successful PUT. A debounced (300 ms)
  PUT saves the active buffer; convert is sent only after the PUT acks
  (chained, not parallel) so the disk copy and engine input agree.
- Closing/deleting a buffer drops it from the store; renames update
  the key and the path in any pending PUT.

### Welcome content for `main.tex` (decided)

On `"blank"`-slot session creation, `main.tex` is seeded with the
existing **Hello-world example** from `frontend/src/examples.ts`. This
keeps the welcome content and the `examples` dropdown in sync — there
is exactly one canonical "Hello world" string in the codebase, and the
welcome experience drifts when (and only when) the example does. The
example renders to a satisfying preview on first sight and gives the
user something concrete to edit.

Any other slot (`"example:<name>"`, `"upload:<...>"`) seeds itself from
its own template, not from the welcome content.

### Examples: shared source of truth (decided in v1.2)

Examples move out of `frontend/src/examples.ts` and into a new
top-level repo directory, shared by both the server (which seeds
example slots) and the frontend (which lists them in the dropdown):

```
ar5iv-editor/
├── examples/
│   ├── _index.toml          # ordered list of example names + entry files
│   ├── pythagoras/
│   │   └── main.tex
│   ├── maxwell/
│   │   └── main.tex
│   └── …
```

- **Server side**: `crates/ar5iv-editor-server/build.rs` (or the
  `include_dir!` macro from the `include_dir` crate) embeds the
  `examples/` tree into the binary at compile time. On
  `Slot::Example(name)` creation, the seeding code copies that
  example's tree into the new session dir verbatim.
- **Frontend side**: Vite's `import.meta.glob('/examples/**/*',
  { as: 'raw', eager: true })` pulls the same files into the bundle.
  The dropdown is rendered from `_index.toml` (also embedded), so
  there is exactly one ordered list of examples in the codebase.
- **Migration**: each entry currently in `frontend/src/examples.ts`
  becomes a `examples/<slug>/main.tex` file. The 16 ports from
  ltxmojo translate one-to-one. The file `examples.ts` is reduced to
  a tiny shim that re-exports the bundled content for the existing
  dropdown wiring during the transition; once the file panel + slot
  model is live, the shim goes away.
- **Multi-file examples** drop in naturally: add more files under
  `examples/<name>/` and update `_index.toml` to point `entry` at the
  intended `main.tex`. v1.2 ships every example as a single
  `main.tex`, so nothing else changes for the dropdown UX.

### Examples behaviour (decided in v1.2)

Picking an example calls `POST /api/session { slot: "example:<name>" }`.
The server's lookup-or-create:

- If the user has been here before *and* their tmpdir for this example
  hasn't been GC'd, returns the existing id with the user's saved
  edits intact. No copy, no churn.
- Otherwise mints a fresh tmpdir, copies the example's source tree
  (from the embedded `examples/<name>/`) into it, and returns the new
  id.

Switching examples does **not** discard the previous example's
tmpdir; it stays around (subject to per-user 8-session cap and 10-min
GC) so the user can flip back and forth. The "blank" scratch slot is
just another slot under this rule, distinguished only by name.

### Folder upload (in v1.2)

The Upload button supports both file-pick and folder-pick:

- File pick: `<input type="file" multiple>`.
- Folder pick: `<input type="file" webkitdirectory>` (Chrome, Edge,
  Safari, Firefox — all current versions). On Firefox in particular
  this is reliable since 2022; the inconsistency caveats from v1.1
  no longer hold.
- Drag-and-drop accepts both files and folders via
  `DataTransferItem.webkitGetAsEntry()`, walked recursively.

Each entry contributes a relative path to a single multipart upload.
The server reconstructs the directory structure under the session root,
creating missing parents via the same `resolve` chokepoint. Symlinks
in DataTransfer entries are skipped silently with a warning in the
UI's upload toast (browsers don't expose them to JS today, but the
defence costs nothing).

The total upload is bounded by per-session quotas; oversized batches
fail atomically with no partial state on disk (uploads stream into a
staging subdir then rename-into-place).

### Archive upload — ZIP and tar.gz (in v1.2)

**Import** accepts both `.zip` and `.tar.gz` (with `.tgz` as an alias).
**Export** is ZIP-only; we don't generate tarballs. Rationale: the arXiv
ecosystem ships papers as `.tar.gz`, so accepting them is essential for
a credible "drop in a paper" UX, but ZIP is a better lingua franca for
download (built-in browser support on every OS).

Two entry points (both accept either archive format, sniffed by leading
bytes — gzip's `0x1f 0x8b` vs ZIP's `PK\x03\x04`):

- **"New project from archive"** in the file panel header → `POST
  /api/import-archive`. Creates a *new slot*
  `"upload:<sha256-hex-prefix>"` and unpacks into a fresh tmpdir. The
  user's current edits in whatever they were on are untouched; the
  file panel switches to the new project.
- **"Add archive contents"** kebab inside an existing project → `POST
  /api/session/{id}/upload-archive?on_conflict=skip|overwrite`.
  Unpacks into the current tmpdir.

Routes are renamed from the v1.1 spec: `/api/import-zip` →
`/api/import-archive`, `/api/session/{id}/upload-zip` →
`/api/session/{id}/upload-archive`. The Content-Type the client sends
is informational; the server sniffs the magic bytes.

Extraction rules (defence-in-depth, applied to **both** formats before
any byte is written):

- Entry names go through `resolve` — `..`, absolute paths, NUL,
  backslash all rejected.
- Symlink entries rejected outright. ZIP: `(external_attrs >> 16) &
  S_IFMT == S_IFLNK`. Tar: `TypeFlag::Symlink` and `TypeFlag::Link`.
- Hardlink and device-node entries (tar's `Char`, `Block`, `Fifo`,
  `Continuous`) rejected outright.
- Per-entry uncompressed size cap (10 MB, single-file quota).
- Compressed-to-uncompressed ratio cap (default 100×) defeats both
  zip-bombs and gzip-bombs; the gzip layer's wrapped size is the
  numerator, not the underlying tar size.
- Total uncompressed size cap (default: per-session 50 MB quota).
- Extension allowlist same as for multipart upload.
- Extraction streams entry-by-entry into a staging subdir, then atomic
  rename-into-place if every entry succeeds; on any failure the
  staging subdir is removed and the session is left untouched.

The import-archive path additionally caps total entries (default 500)
and nesting depth (default 16) before extraction begins.

Implementation: the new `crates/ar5iv-editor-server/src/archive.rs`
module owns both formats behind one trait. `zip` crate handles ZIP;
`flate2::read::GzDecoder` + `tar::Archive` handles tar.gz. Both feed
into the same path-validation + quota chokepoints, so the security
surface is one set of checks, not two.

### Archive-bearing examples

Examples whose source is itself an archive (e.g. a real arXiv paper)
declare an `archive` field in `_index.json`:

```jsonc
{ "name": "arXiv: 1709.07020", "slug": "arxiv",
  "entry": "full_article.tex", "archive": "1709.07020v1.tar.gz" }
```

The archive sits at `examples/<slug>/<archive>`. At slot-create time
for `slot: "example:<slug>"`, the server detects the `archive` field
and unpacks through the same `archive.rs` chokepoint that user
uploads use — same allowlist, same size caps, same staging-and-rename.
Plain (non-archive) examples are unaffected; they're seeded as today
by copying `examples/<slug>/main.tex` verbatim.

The frontend bundle excludes archive bytes (Vite glob is restricted to
`*.tex` only); the dropdown's back-compat shim simply skips
archive-bearing entries (they require a server round-trip), and the
v1.2 slot-aware path treats them the same as any other example slot.

### Project export (ZIP only)

`GET /api/session/{id}/export-zip` streams a deterministic ZIP of the
session's contents (sorted entries, no symlinks emitted). Same
defences as upload, in reverse — refuses if the session walk exceeds
the per-session quotas (it can't in practice, but the cheap check
guards against future surprises). No tar.gz export; ZIP-only.

## Abuse defence: front the service with Anubis (decided in v1.2)

Anonymous uploads + LaTeX compute + free disk + WebSockets is a
crawler/scraper magnet. Per-IP and per-user caps mitigate the worst
of it but don't stop scripted abuse cheaply. v1.2 puts the entire
service behind [Anubis](https://github.com/TecharoHQ/anubis) — a
proof-of-work / browser-fingerprint gate — with strict policy that
only lets humans through:

- Anubis runs as a reverse proxy in front of `ar5iv-editor`'s Axum
  binary; nothing reaches Axum until Anubis issues a signed cookie.
  In production this is a single-binary Anubis fronting our binary,
  both behind the platform's TLS terminator.
- Policy: deny everything that doesn't pass the JS challenge. The
  default Anubis bot allowlist (search engines for `/about` and
  `/help` if we want indexing; otherwise full deny) can be tuned in
  `anubis.yaml`. v1.2 starts with full deny — the editor surface is
  not something a bot needs.
- Static assets and the marketing pages can be carved out via path
  rules in `anubis.yaml` if we decide their absence in search results
  is a problem; the `/api/*`, `/convert`, and `/editor` paths stay
  gated unconditionally.
- The `X-Ar5iv-User` header is unaffected: Anubis sits at L7 between
  the browser and Axum, doesn't inspect or rewrite our headers, and
  we keep our existing per-user/per-IP caps as a second layer.

This shifts the threat model: the per-IP session cap goes from "primary
defence" to "defence-in-depth," which lets us *raise* the legitimate
limits (16 → 32 user_ids per IP, say) without making abuse cheaper —
the cost a bot pays to clear Anubis dwarfs the cost of opening a
session.

Operationally, Anubis adds a one-time JS challenge on first visit
(typically 1–3 s) and then a cookie that lasts a configurable window.
This is acceptable for a tool people open once and edit in for
minutes. Tracked in deployment docs, not the editor codebase itself.

## Phase plan

### Phase 0 — De-risk (½ d)

The integration test described above. Decide go/no-go.

### Phase 1 — Examples migration + backend session + file routes (1.25 d)

- **Examples migration** (small, do it first to unblock everything
  else):
  - Create top-level `examples/` directory with `_index.toml` and one
    subdir per example, each containing `main.tex`. Move every entry
    currently in `frontend/src/examples.ts` here verbatim.
  - Server side: `include_dir!("examples")` (or a tiny `build.rs`)
    embeds the tree.
  - Frontend side: replace the `EXAMPLES` constant in
    `frontend/src/examples.ts` with a Vite `import.meta.glob`-driven
    loader that reads from `/examples/**`. Existing dropdown wiring
    in `main.ts` keeps working through the transition.
- New module `crates/ar5iv-editor-server/src/session.rs`: `SessionId`,
  `UserId`, `Slot` (enum: `Blank | Example(String) | Upload([u8;32])`),
  `Session`, `SessionRegistry` with the dual maps, `resolve` helper,
  GC sweep entrypoint.
- New module `crates/ar5iv-editor-server/src/files.rs`: route handlers
  for create-or-lookup-session, list, get, put, mkdir, rename, delete.
  (Rename/delete are server-side only in v1.2; the frontend doesn't
  expose them yet but the routes are needed by the ZIP-import path
  and by tests.)
- New module `crates/ar5iv-editor-server/src/quota.rs`: limit checks
  and the 2 GB sessions-root soft cap.
- `AppState` gains `sessions: Arc<SessionRegistry>`.
- `main.rs` spawns the GC tick task.
- `config.rs` gains: `sessions_dir`, `session_idle_timeout` (default
  10 min), `quota_session_bytes`, `quota_session_files`,
  `quota_upload_bytes`, `quota_zip_bytes`, `quota_root_bytes`,
  `quota_sessions_per_user`, `quota_users_per_ip`.
- Tests:
  - create-session → upload → list → fetch → rename → delete → GC
    after timeout (timeout overridden to ~200 ms in the test).
  - lookup-or-create dedup: two POSTs to the same slot return the
    same id and don't duplicate the tmpdir.
  - per-user-cap eviction: 9th slot evicts the oldest.
  - path-traversal: every blocked input form returns 400.
  - symlink-refusal: a pre-planted symlink under the session dir is
    refused on PUT/upload.
  - 403 on `X-Ar5iv-User` mismatch; 410 `session_expired` on routes
    after GC.
  - example-slot seeding: requesting `slot: "example:pythagoras"`
    creates a tmpdir whose contents match the embedded
    `examples/pythagoras/` tree byte-for-byte.

### Phase 2 — Wire convert through sessions (½ d)

- `ConvertRequest`: drop `tex`, add `active_file`, add `version`.
- `ConvertResponse`: add `version` echo.
- `ws_handler` extracts `?session_id=` from upgrade URL; rejects with
  `1008` if unknown.
- `convert_one` reads `active_file` from `session.dir`, sets
  `search_paths` to `[session.dir]`, and sets
  `PostOptions.source_directory = Some(session.dir.clone())`. The
  latter is what makes `<img>` `src` attributes come back relative —
  see the Phase 0 finding below.
- **Resolved-path rewrite (post-processing step).** Phase 0 confirmed
  that `OxideConfig.search_paths` resolves `\input` and
  `\includegraphics` from the session dir. The rendered HTML's
  `<img src="...">` carries the *absolute* on-disk path, e.g.
  `<img src="/tmp/ar5iv-editor-sessions/<uuid>/fig.png">`. This both
  leaks the session dir layout into the page and produces a URL the
  browser cannot fetch. The convert worker post-processes the HTML
  by rewriting any `src` (or `href`) that resolves under
  `session.dir` to `/api/session/{id}/files/<relative>`, before
  returning to the WS handler. A focused regex over the html string
  is sufficient; passing `PostOptions.source_directory` to the
  post-processor likely makes paths relative on its end and removes
  the rewrite, but we should not depend on it without verifying.
- `last_activity` bumped on every received WS frame.
- New status_code `4` = `session_expired`.
- Integration test: PUT `chapter1.tex` via files route, then convert
  a doc that does `\input{chapter1}` over WS, assert MathML in result.
- Integration test: upload `fig.png` via files route, convert a doc
  with `\includegraphics{fig}`, assert the response HTML contains
  `<img src="/api/session/{id}/files/fig.png">` (no absolute fs paths
  leak through).

### Phase 3 — Three-pane shell + resizers (¾ d)

- Edit `templates/editor.html` (the production template) to add the
  third pane and the two resizers. The dev `frontend/index.html`
  already mirrors this layout via Vite, so update it in lockstep.
- `frontend/src/resizers.ts`: PointerEvents, CSS-var updates,
  localStorage persistence, keyboard nudging.
- Media query for <700 px: collapse files pane.
- Smoke-check: status-click log toggle still works.

### Phase 4 — Archive unpack (ZIP + tar.gz) + ZIP export server-side (1 d)

(Swapped earlier with what was originally Phase 6, so the file-panel
phase can wire its UI to real, tested endpoints.)

- New module `crates/ar5iv-editor-server/src/archive.rs`. One trait
  fronts the two formats; ZIP via the `zip` crate, tar.gz via
  `flate2::read::GzDecoder` + `tar::Archive`. Both feed the same
  path-validation, allowlist, and quota chokepoints.
- Defence-in-depth extraction rules (per-entry size, ratio, total
  size, depth, count, symlink/hardlink/device-node rejection,
  allowlist) — applied uniformly to both formats.
- Streaming extractor into a staging subdir; atomic
  rename-or-rollback.
- Magic-byte sniffer dispatches incoming archive bodies between the
  two formats; the client's Content-Type is advisory.
- `POST /api/import-archive` and
  `POST /api/session/{id}/upload-archive` routes wired here.
- `GET /api/session/{id}/export-zip` route: streams a deterministic
  ZIP of the session's contents (sorted entries, no symlinks emitted).
  ZIP-only; no tar.gz export.
- Tests: zip-bomb + gzip-bomb rejection, path-traversal in both ZIP
  and tar entry names, symlink/hardlink/device rejection, conflict
  policies, atomicity on partial failure, round-trip export → import
  preserves the file set, tar.gz import-of-arxiv-example works
  end-to-end.

### Phase 5 — File panel UI + uploads (1.25 d)

- `frontend/src/files.ts` with `FileTree`, header actions, **Download**-
  only kebab menu (no rename/delete in v1.2 per Non-goals).
- Single-file and folder upload via `<input>` and DataTransfer drag-drop;
  shared streaming-multipart code path.
- "New project from ZIP" entry point + per-project "Add ZIP contents."
- "Download project as ZIP" header button (calls `export-zip`).
- Default selection: `main.tex`.
- Empty-state placeholder (defensive; should never appear in practice).

### Phase 6 — Editor multi-buffer + bootstrap + auto-convert (1 d)

- `BufferStore` in `editor.ts`.
- Frontend bootstrap in `main.ts` (`localStorage` user_id +
  `sessionStorage` slot, 410-fallback).
- PUT-then-convert chain on edits.
- Single `requestPreview()` entrypoint wired to: edits, all file-route
  successes, examples-dropdown changes, ZIP unpack completion.
- Toasts for failed file ops; metadata stub for non-editable files.

### Phase 7 — Anubis integration (½ d, mostly ops)

- Add an `anubis.yaml` to the repo with deny-by-default policy and
  the few allowlist rules we want.
- Add a `docker-compose.yml` (or a `deploy/` README section) that
  pipes Anubis → ar5iv-editor.
- Smoke-test the WebSocket upgrade through Anubis (the proxy must
  pass `Upgrade: websocket`; trivially true for Anubis but verify).
- Document in `README.md`.

### Phase 8a — Dockerization + cloud demo deploy (¾ d)

The plan in v1.2 already calls for an Anubis-fronted deploy
(Phase 7); this phase is the *concrete, demoable* shape of that.
Goal: a single image we can push to ghcr.io and pull on a €5/mo
box, with full TLS, in under 10 minutes.

Constraints:

- **latexml-oxide is single-threaded** — adding vCPU past 1 is
  wasted on the engine. The only CPU dimension that matters for
  warm conversion latency is single-core clock × IPC. That rules
  out the usual "burstable t3 / shared vCPU" tiers everyone
  defaults to: those throttle exactly when the engine wants to
  run.
- The image needs TeX Live's `kpsewhich` for the engine's
  package-resolution fallback. Slim runtime image, but not
  scratch.
- Anubis fronts the binary; no other middleware.

Recommendation: **Hetzner Cloud CCX13** (~€13.10/mo / ~$14.50,
2 *dedicated* AMD EPYC 7763 vCPUs, 8 GB RAM, 80 GB NVMe, 20 TB
egress). The dedicated-cores tier is the value sweet spot once the
budget allows it — no neighbour contention on conversion, which is
the single biggest source of warm-latency jitter on the burstable
tiers. Fly.io \`performance-2x\` (~$11/mo + RAM) is the
deploy-from-\`flyctl\` alternative; pick it if Git-push DX matters
more than absolute consistency.

Why 2 vCPUs matter even with a single-threaded engine: one core
stays pinned to the latexml-oxide worker, the other absorbs
Anubis (JS challenge verification), Caddy (TLS termination),
Axum/tokio runtime, WebSocket multiplexing, and OS overhead. On
a single-core box those compete with the engine and surface as
warm-conversion jitter. On 2 dedicated cores the worker thread
runs uncontested.

CPX11 (€4.51/mo, shared vCPUs) remains the rock-bottom fallback
if cost is the only axis, but expect ~2× the warm-latency
variance and occasional spikes when noisy neighbours are heavy.

Work items:

- Verify the existing \`deploy/Dockerfile\` actually builds end-to-end.
  It currently assumes \`latexml-oxide\` lives in the docker-build
  context next to \`ar5iv-editor\`; document the symlink trick or
  switch to a multi-context build (\`docker buildx build\`'s
  \`--build-context\`).
- Add a small \`deploy/build-and-push.sh\` that does the
  symlink + build + push to ghcr.io in one shot.
- Add \`deploy/cloud-demo.md\` with a step-by-step Hetzner CCX13
  recipe (provision → SSH → docker → pull → up). Include a
  one-shot Caddyfile for TLS, the demo-tightened quota env vars
  (\`QUOTA_PER_IP=4\`, \`SESSION_IDLE_SECS=300\`), and the
  recommended tmpfs size (1 GB on CCX13's 8 GB RAM is
  comfortable; drop to 512 MB if running on the smaller CPX11
  fallback). Note CPU-pinning via \`cpuset\` so the convert
  worker container claims one core uncontested.
- Add a \`fly.toml\` for the Fly.io path so the alternate recipe
  is one \`flyctl deploy\` away.
- "CPU sanity-check" snippet that runs the existing
  \`measure_pipeline\` ignored-test on the candidate box and
  bails if warm conversions land >150 ms (a sign of throttling or
  slower silicon than advertised).
- README cross-link: bump the existing \`deploy/README.md\` to
  point at the new cloud-demo guide.

Out of scope:

- Auto-scaling. Horizontal scaling means more containers, not
  more cores; the engine still serialises through one thread per
  process. If demand grows past a single CPX11 we revisit
  per-container pinning, not autoscale groups.
- Kubernetes. Too heavy for a demo.
- Managed databases / queues. Sessions are tmpfs-only.

### Phase 8b — Tests + docs (½ d)

- Backend: route-level tests for upload limits, path traversal, GC,
  session-expiry behaviour, soft-cap behaviour, ZIP defences.
- E2E: a small Playwright (or hand-driven) script that:
  uploads `fig.png`, references it from `main.tex`, watches the
  preview auto-refresh, then imports a ZIP and confirms a fresh
  project slot opens.
- README update (a "File panel" section, screenshots, deployment).
- This doc gets a "v1.2 done" stamp and a v1.3 stub for any deferred
  ideas (multi-file examples, search, etc.).

## Crate boundaries

No new crates. `ar5iv-editor-protocol` gains:

- `active_file: String` on `ConvertRequest`; `tex` removed.
- `FileMeta { path, size, kind }`, `FileListing { files: Vec<FileMeta> }`,
  `SessionCreated { id, files: Vec<FileMeta> }` for the file routes
  (the frontend's TS types are hand-mirrored against this crate, as
  with the existing wire types — keeping them colocated is the
  established pattern).

## Out-of-scope risks worth naming

- **CPU starvation.** The convert worker remains single-threaded;
  multi-file projects with many `\input`s land more bytes per request
  but introduce no new concurrency vector. Re-check after a 5-file
  demo lands.
- **Reading bytes off disk per convert.** A 100 KB `\input` chain hits
  the OS page cache and is essentially free; no caching layer in v1.
- **Disk fill.** Mitigated by the 2 GB sessions-root soft cap, the
  per-session and per-user caps, and the GC. Worth a SECURITY note in
  v1.2 that names the threat model in one paragraph.
- **CSRF and bearer-credential hygiene.** State-changing routes are
  authenticated by the `X-Ar5iv-User` custom header, which the browser
  will not attach to cross-origin requests without explicit JS — so a
  malicious third-party site cannot forge requests on the user's
  behalf. There are no cookies and no implicit ambient auth. The
  256-bit `user_id` and `session_id` are pure capability tokens; the
  server never logs them, and the access log redacts session ids in
  URLs to a salted hash.
- **XSS is the residual auth risk.** `localStorage` is readable by any
  script running on the origin. A successful XSS therefore exfiltrates
  the user_id and grants the attacker access to all the user's
  sessions. The editor's own surface renders **only converter output**
  (LaTeXML's HTML5 stylesheet, ar5iv-css, MathML), and the converter
  must not emit `<script>` — it doesn't today. Any future feature that
  injects user-controlled HTML into the preview must explicitly
  re-evaluate this boundary.
- **Active-file rename/delete UX (deferred).** Server routes exist but
  the frontend exposes only "Download" in v1.2. When we re-enable
  rename/delete in a later version, decisions to make: rename of the
  currently-edited file follows it (BufferStore key updates, editor
  stays open); delete of the currently-edited file falls back to
  `main.tex`, or empty state if `main.tex` is gone too.

## Effort recap

| Phase                                                     | Estimate |
|-----------------------------------------------------------|----------|
| Phase 0 de-risk                                           | 0.5 d    |
| Phase 1 examples migration + backend session + files      | 1.25 d   |
| Phase 2 convert-through-sessions                          | 0.5 d    |
| Phase 3 three-pane shell + resizers                       | 0.75 d   |
| Phase 4 archive unpack (ZIP + tar.gz) + ZIP export        | 1.0 d    |
| Phase 5 file panel UI + uploads                           | 1.25 d   |
| Phase 6 editor multi-buffer + bootstrap + auto-convert    | 1.0 d    |
| Phase 7 Anubis integration                                | 0.5 d    |
| Phase 8a Dockerization + cloud demo deploy                | 0.75 d   |
| Phase 8b tests + docs                                     | 0.5 d    |
| **Total**                                                 | **8.0 d**|

~7 working days for a v1.2 that feels Overleaf-shaped, has folder/ZIP
upload + export, gates abuse with Anubis, and keeps the headline
live-preview feel. Reserve one extra day of slack for the worst-case
search_paths fallback.

## Changelog

- **v1.2 (this revision)**
  - **Disk/URL identity decoupled**: on-disk dir names are a separate
    256-bit `disk_token`, not derived from the public `SessionId`. A
    leaked URL or log line cannot be turned into a filesystem path.
  - **Orphan sweep at create + boot**: every fresh session triggers a
    cheap `sweep_orphans()` over the sessions root that deletes any
    token-shaped subdirectory not in the live registry whose mtime is
    older than the idle timeout. Same sweep runs at startup so a
    previous-run's leftovers cannot accumulate. Length+alphabet shape
    filter prevents accidental deletion of hand-placed admin files.
  - Examples moved out of `frontend/src/examples.ts` into a top-level
    `examples/` directory of `.tex` files, embedded into the server
    binary via `include_dir!` and into the frontend bundle via Vite
    `import.meta.glob`. One source of truth, ready for multi-file
    examples in v1.3.
  - Phase 4 and Phase 6 swapped: server-side ZIP unpack + export ships
    before the file-panel UI, so the UI wires to real endpoints. ZIP
    *export* added (`GET /api/session/{id}/export-zip`) for project
    download.
  - File rename / delete deferred from the v1.2 frontend. Server
    routes still ship and are tested (the ZIP-import path uses them
    internally), but the kebab menu shows only "Download" until UX
    decisions for active-file rename/delete are made.
  - CSRF / auth section rewritten: `X-Ar5iv-User` custom header is the
    primary auth credential (no cookies); 256-bit tokens, no logging
    of tokens, salted-hash redaction of session ids in access logs;
    XSS named explicitly as the residual risk.
  - Non-goals reframed: ZIP import + export are *in scope*; only
    rename/delete UI and the bigger-ticket items (collab, login,
    search) remain non-goals.
  - 403 (X-Ar5iv-User mismatch) split from 410 (session expired).
  - Session model promoted to per-user-per-slot keying. Sessions are
    now indexed by `(user_id, slot)`; loading the same example twice
    reuses one tmpdir. New "upload:" slot for ZIP imports.
  - Idle timeout 5 min → 10 min.
  - Per-user concurrent-session cap (8); per-IP user_id cap (16);
    LRU eviction on overflow.
  - `UserId` and `SessionId` are now 256-bit `OsRng` random tokens,
    base64url-encoded — *not* UUIDs, *not* serial ids. No embedded
    metadata, anonymity-preserving by construction.
  - Folder upload promoted into v1 (was deferred); single shared
    multipart code path for files and folders, with DataTransfer-based
    drag-drop.
  - ZIP upload promoted into v1: `POST /api/import-zip` creates a new
    project slot keyed by archive hash; per-session
    `POST .../upload-zip` overlays into the current project.
    Defence-in-depth extraction (size, ratio, depth, count, symlink,
    allowlist) into a staging subdir with atomic rename-or-rollback.
  - Auto re-convert on every successful file-route op: edits, single
    upload, folder upload, ZIP unpack, mkdir, rename, delete all
    funnel through one debounced `requestPreview()`. Convert
    request/response gain a `version` field so stale results can't
    overwrite a freshest preview after a write.
  - Welcome `main.tex` is now sourced from the existing Hello-world
    entry in `examples.ts` (single source of truth).
  - Service is fronted by **Anubis** with deny-by-default policy;
    per-IP/per-user caps become defence-in-depth.
  - File routes carry the user id in `X-Ar5iv-User`; lookup-or-create
    is `POST /api/session { slot }`.
- **v1.1**
  - Convert request no longer carries `tex`; uses `active_file` against
    disk. Single source of truth.
  - Lexical path normalisation, no `canonicalize` on user input.
    Symlinks refused at every creation site via `O_NOFOLLOW`.
  - GC removes registry entry first, then directory; in-flight
    requests return `410 session_expired` (HTTP) or `status_code 4`
    (WS).
  - Session bound at WS upgrade via `?session_id=`; per-frame id
    removed.
  - App-level heartbeat dropped; rely on existing WS frames + browser
    ping.
  - Frontend stores the id in `sessionStorage` (per-tab); recreates on
    410.
  - Editor-openable extension allowlist; binary files show a metadata
    stub.
  - Multipart uploads stream to disk; uploads gated by extension
    allowlist.
  - 2 GB sessions-root soft cap promoted from "out-of-scope risk" to
    in-v1 quota.
  - Status-click log toggle preservation called out explicitly.
  - "Open questions" section retired.
  - "Day N" labels replaced with "Phase N" to stop implying calendar
    days.
- **v1** — initial draft (in git history).
