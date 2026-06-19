// File panel — tree rendering, header new/upload/download actions,
// click-to-open into the editor. No rename / delete in v1.2 per
// `docs/FileUI.md` "Non-goals". Auto-convert is triggered via the
// `requestPreview` callback after every successful file-op response.

import type { EditorHandle } from "./editor.ts";
import type { FileMeta, SessionClient, SessionEnvelope } from "./session.ts";
import { SessionExpiredError } from "./session.ts";
import { showFatalCard, showNotice } from "./toast.ts";

const HEADER_USER = "x-ar5iv-user";

export interface FilePanelOptions {
  /** Element that receives the file tree (children replaced on render). */
  treeEl:        HTMLElement;
  /** Header element holding the action buttons (Phase 3 stub). */
  actionsEl:     HTMLElement;
  /** The current session client. Replaced from the outside via
   *  `setSession()` when the user picks a different example slot. */
  session:       SessionClient;
  editor:        EditorHandle;
  /** Called after every successful state change so the preview pane
   *  catches up. The convert flow is owned by `main.ts`. */
  requestPreview: () => void;
  /** Called when the user opens a different file. The driver in
   *  `main.ts` is responsible for save-then-load and updating its
   *  `activePath`. Promise resolves once the swap is complete. */
  onOpenFile:    (path: string) => Promise<void>;
  /** Surface errors (replaced with a toast in Phase 6). */
  reportError:   (msg: string) => void;
  /** Called when an action completes that may have switched the
   *  session id (import-archive, switch-slot). The driver re-binds
   *  the WS / loads the new active file. */
  onSessionSwap: (env: SessionEnvelope) => void;
}

interface TreeNode {
  name:     string;
  path:     string;
  isDir:    boolean;
  children: TreeNode[];
}

export class FilePanel {
  private opts:        FilePanelOptions;
  private active:      string | null;
  private collapsed:   Set<string> = new Set();

  constructor(opts: FilePanelOptions) {
    this.opts = opts;
    this.active = opts.session.envelope.entry || null;
    this.renderActions();
    this.render();
    this.installDragAndDrop();
  }

  /** Wire drag-and-drop onto the file panel so users can drop an
   *  archive (.zip / .tar.gz / .tgz), loose files, or a *folder*
   *  straight onto it. Folder drops are walked via
   *  `DataTransferItem.webkitGetAsEntry()` — that enumeration is
   *  lazy/async, unlike `<input webkitdirectory>` which blocks the
   *  UI thread on a synchronous walk. Each enumerated file is
   *  tagged with a `webkitRelativePath` so the server preserves the
   *  folder hierarchy. */
  private installDragAndDrop(): void {
    const target = this.opts.treeEl.parentElement ?? this.opts.treeEl;
    // `.pane-files` is `height: calc(100vh - var(--header-h))`, so
    // its hit-area already spans the entire sidebar — including the
    // empty space below the tree. We still pin a `min-height` on the
    // tree itself so the visible drop affordance feels intentional
    // when only a few rows are present.
    this.opts.treeEl.style.minHeight = "calc(100vh - var(--header-h) - 4rem)";

    // Track drag enter/leave with a depth counter — without it,
    // moving the pointer over any child element (a button, a tree
    // row) fires a dragleave on the parent, which would otherwise
    // flicker the highlight off and on. The class only comes off
    // when the depth returns to zero.
    let dragDepth = 0;
    const isFilesDrag = (e: DragEvent) =>
      !!e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!isFilesDrag(e)) return;
      e.preventDefault();
      dragDepth++;
      target.classList.add("pane-files--drop");
    };
    const onOver = (e: DragEvent) => {
      // Drop only fires on a target whose dragover handler called
      // preventDefault — without this the browser interprets the
      // gesture as "open this file in a new tab".
      if (isFilesDrag(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!isFilesDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) target.classList.remove("pane-files--drop");
    };
    const onDrop = async (e: DragEvent) => {
      dragDepth = 0;
      target.classList.remove("pane-files--drop");
      if (!e.dataTransfer) return;
      e.preventDefault();
      // Prefer `items` so we can detect directory entries; fall
      // back to `files` whenever the entry API isn't available *or*
      // returns nothing useful (synthetic drops, certain edge
      // cases). The `files` path can't preserve subdirectory layout,
      // so we only fall through to it when `items` produces no
      // entries.
      const items = Array.from(e.dataTransfer.items ?? []);
      const fileItems = items.filter((it) => it.kind === "file");
      if (fileItems.length > 0 && "webkitGetAsEntry" in fileItems[0]) {
        const entries: FileSystemEntry[] = [];
        for (const it of fileItems) {
          const entry = (it as DataTransferItem & {
            webkitGetAsEntry: () => FileSystemEntry | null;
          }).webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
        if (entries.length > 0) {
          const collected = await readEntriesAsFiles(entries);
          if (collected.length > 0) void this.actionUploadFiles(collected);
          return;
        }
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void this.actionUploadFiles(files);
    };
    target.addEventListener("dragenter", onEnter);
    target.addEventListener("dragover", onOver);
    target.addEventListener("dragleave", onLeave);
    target.addEventListener("drop", onDrop);
  }

  setActiveFile(path: string | null): void {
    this.active = path;
    this.render();
  }

  setSession(env: SessionEnvelope): void {
    // Caller has already updated the SessionClient's envelope; we just
    // pick up the new file list and entry path.
    this.active = env.entry || null;
    this.collapsed.clear();
    this.render();
  }

  /** Refresh the file list from the server (e.g. after an upload or
   *  a delete) and, if the session was previously empty, auto-open a
   *  sensible default in the editor. Does NOT trigger a convert —
   *  callers that mutated the file set (upload, delete, clear, new
   *  file) are responsible for calling `requestPreview()` after this
   *  resolves; pure file-switch interactions don't need to. */
  async refresh(): Promise<void> {
    try {
      const listing = await this.opts.session.listFiles();
      this.opts.session.envelope = {
        ...this.opts.session.envelope,
        files: listing.files,
      };
      this.render();
      // Auto-open a sensible default after the first upload into a
      // previously-empty session (the "New Project" flow). Skipped
      // when something is already active so a refresh after a
      // mid-session upload doesn't yank the editor out from under
      // the user.
      if (this.active === null) {
        const candidate = pickPostUploadEntry(listing.files);
        if (candidate !== null) await this.openFile(candidate);
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`refresh failed: ${e}`);
    }
  }

  // -------------------------------------------------------------------
  // Render.
  // -------------------------------------------------------------------

  private render(): void {
    const tree = buildTree(this.opts.session.envelope.files);
    const root = document.createElement("ul");
    root.className = "ftree-root";
    this.renderNodes(tree, root, 0);
    this.opts.treeEl.replaceChildren(root);
  }

  private renderNodes(nodes: TreeNode[], parent: HTMLElement, depth: number): void {
    for (const n of nodes) {
      const li = document.createElement("li");
      li.className = "ftree-row";
      if (n.isDir) li.classList.add("ftree-row--dir");
      if (n.path === this.active) li.classList.add("ftree-row--active");

      const row = document.createElement("button");
      row.type = "button";
      row.className = "ftree-button";
      row.style.paddingLeft = `${0.4 + depth * 0.85}rem`;

      const icon = document.createElement("span");
      icon.className = "ftree-icon";
      // Folders get a collapse-state arrow; files have no glyph —
      // their filename + extension is the visual signal, in keeping
      // with the monospace aesthetic of the timings strip.
      icon.textContent = n.isDir
        ? this.collapsed.has(n.path) ? "▶" : "▼"
        : "";
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "ftree-label";
      label.textContent = n.name;
      row.appendChild(label);

      row.addEventListener("click", () => {
        if (n.isDir) {
          if (this.collapsed.has(n.path)) this.collapsed.delete(n.path);
          else this.collapsed.add(n.path);
          this.render();
        } else {
          void this.openFile(n.path);
        }
      });
      li.appendChild(row);

      // Hover-revealed delete affordance — a small red ✕ floated to
      // the right of every row (file or directory). Clicking it asks
      // for confirmation; on accept the path is unlinked server-side
      // (recursive for directories) and the panel re-renders. The
      // listener stops propagation so the row's click doesn't fire
      // an open / collapse alongside the delete.
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ftree-delete";
      del.title = n.isDir
        ? `Delete folder “${n.name}” and all of its contents`
        : `Delete file “${n.name}”`;
      del.setAttribute("aria-label", del.title);
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.actionDelete(n);
      });
      li.appendChild(del);

      parent.appendChild(li);

      if (n.isDir && !this.collapsed.has(n.path)) {
        const sub = document.createElement("ul");
        sub.className = "ftree-sublist";
        this.renderNodes(n.children, sub, depth + 1);
        parent.appendChild(sub);
      }
    }
  }

  private async openFile(path: string): Promise<void> {
    if (path === this.active) return;
    if (!isEditableExtension(path)) {
      this.opts.reportError(
        `${path} is not a text file. Reference it from your TeX, e.g. \\includegraphics{${stripExt(path)}}.`,
      );
      return;
    }
    try {
      await this.opts.onOpenFile(path);
      this.active = path;
      this.render();
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`open ${path} failed: ${e}`);
    }
  }

  // -------------------------------------------------------------------
  // Header actions.
  // -------------------------------------------------------------------

  private renderActions(): void {
    this.opts.actionsEl.replaceChildren();

    const createBtn = makeTextButton("create", "Create a new file");
    createBtn.addEventListener("click", () => void this.actionNewFile());
    this.opts.actionsEl.appendChild(createBtn);

    const uploadBtn = makeTextButton(
      "upload",
      "Click to pick files or a .zip / .tar.gz archive. " +
      "Drag-and-drop a folder, files, or archive onto the file panel " +
      "for full directory uploads.",
    );
    uploadBtn.addEventListener("click", () => this.triggerUpload());
    this.opts.actionsEl.appendChild(uploadBtn);

    const downloadBtn = makeTextButton(
      "download",
      "Download the project (sources + rendered HTML) as ZIP",
    );
    downloadBtn.addEventListener("click", () => void this.actionDownload());
    this.opts.actionsEl.appendChild(downloadBtn);

    const clearBtn = makeTextButton(
      "clear",
      "Delete every file in this project (cannot be undone)",
    );
    clearBtn.classList.add("pane-action--destructive");
    clearBtn.addEventListener("click", () => void this.actionClear());
    this.opts.actionsEl.appendChild(clearBtn);
  }

  private triggerUpload(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    // Deliberately NOT using `webkitdirectory`: Chrome's directory
    // picker enumerates the chosen folder synchronously on the UI
    // thread before returning a FileList. Picking ~/Downloads (or
    // any big tree) freezes the tab. We split modes by *gesture*
    // instead — click here gets a regular file picker (archives +
    // loose files), drag-and-drop on the panel handles directories
    // via `DataTransferItem.webkitGetAsEntry`, which enumerates
    // lazily off the main thread.
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      void this.actionUploadFiles(files);
    });
    input.click();
  }

  private async actionClear(): Promise<void> {
    const fileCount = this.opts.session.envelope.files.filter(
      (f) => f.kind !== "dir",
    ).length;
    if (fileCount === 0) {
      // Nothing to clear — give the user feedback rather than firing
      // a no-op DELETE that they'd never notice succeeded.
      this.opts.reportError("project is already empty");
      return;
    }
    const ok = window.confirm(
      `Delete every file in this project (${fileCount})?\n\n` +
      `This cannot be undone. The session itself stays open — you can ` +
      `keep editing or upload a new folder once the slate is clean.`,
    );
    if (!ok) return;
    try {
      await this.opts.session.clearFiles();
      // Update the local envelope to the now-empty state, then route
      // through `onSessionSwap` so main.ts drops the editor's buffers,
      // resets `activePath`, and re-renders the empty tree. The
      // session id stays — we're explicitly not minting a new one.
      this.opts.session.envelope = {
        ...this.opts.session.envelope,
        files: [],
        entry: "",
      };
      this.opts.onSessionSwap(this.opts.session.envelope);
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`clear failed: ${e}`);
    }
  }

  private async actionDelete(node: TreeNode): Promise<void> {
    const noun = node.isDir ? "folder (and all of its contents)" : "file";
    const ok = window.confirm(
      `Delete ${noun} “${node.path}”?\n\nThis cannot be undone.`,
    );
    if (!ok) return;
    try {
      await this.opts.session.deletePath(node.path);
      // If the active file disappeared underneath us, drop the editor's
      // claim on it so subsequent renders don't highlight a phantom
      // and `refresh()` auto-opens whatever the new main pick is.
      if (this.active === node.path
          || (node.isDir && this.active?.startsWith(node.path + "/"))) {
        this.active = null;
      }
      // The file set changed — fire one convert against the new
      // disk state. Switching the editor's active buffer (which
      // refresh() may do as part of the auto-open) does NOT itself
      // trigger a convert anymore, so this single requestPreview is
      // the entire conversion event for the delete.
      await this.refresh();
      this.opts.requestPreview();
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`delete ${node.path} failed: ${e}`);
    }
  }

  private async actionNewFile(): Promise<void> {
    const raw = window.prompt("New file path (relative, e.g. notes.tex)?");
    if (!raw) return;
    const path = raw.trim();
    if (!path) return;
    if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
      this.opts.reportError("invalid path");
      return;
    }
    try {
      await this.opts.session.putText(path, "");
      await this.refresh();
      this.opts.requestPreview();
      void this.openFile(path);
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`new file failed: ${e}`);
    }
  }

  private async actionUploadFiles(files: File[]): Promise<void> {
    try {
      const form = new FormData();
      for (const f of files) {
        // `webkitRelativePath` is set when the input is in directory
        // mode. For plain multi-select it's empty and we fall back
        // to `name`.
        const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        form.append("file", f, name);
      }
      const url = `/api/session/${this.opts.session.envelope.id}/upload`;
      const resp = await fetch(url, {
        method:  "POST",
        body:    form,
        headers: { [HEADER_USER]: this.opts.session.userId },
      });
      if (resp.status === 410) {
        sessionExpiredCard();
        return;
      }
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`upload failed: ${resp.status} ${txt}`);
      }
      const ack = (await resp.json().catch(() => ({}))) as { skipped?: string[] };
      // The file set changed — refresh the panel, then fire one
      // convert. Auto-opening a file in the editor (which refresh
      // may do for an empty session) does NOT itself trigger a
      // convert; this is the only conversion event for the upload.
      await this.refresh();
      this.opts.requestPreview();
      if (ack.skipped && ack.skipped.length > 0) {
        showNotice(formatSkippedMessage(ack.skipped));
      }
    } catch (e) {
      this.opts.reportError(`upload failed: ${e}`);
    }
  }

  private async actionDownload(): Promise<void> {
    try {
      const url = `/api/session/${this.opts.session.envelope.id}/export-zip`;
      const resp = await fetch(url, {
        headers: { [HEADER_USER]: this.opts.session.userId },
      });
      if (resp.status === 410) {
        sessionExpiredCard();
        return;
      }
      if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
      const blob = await resp.blob();
      const cd = resp.headers.get("content-disposition") ?? "";
      const filenameMatch = /filename="([^"]+)"/.exec(cd);
      const filename = filenameMatch?.[1] ?? "ar5iv-session.zip";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      this.opts.reportError(`download failed: ${e}`);
    }
  }
}

// -----------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------

/** Pick a default file to open right after the first upload into a
 *  fresh session. Restricted to `.tex` because the auto-open feeds
 *  straight into a convert request — landing on a `00README.json`
 *  (left behind from an arXiv unpack) or some other non-source text
 *  file would dispatch the engine on content it can't parse, which
 *  surfaces as bogus diagnostics in the preview. Returns `null` when
 *  there's no `.tex` to render; the user can still click any file
 *  manually, the editor just won't auto-attach to one. */
function pickPostUploadEntry(files: FileMeta[]): string | null {
  const main = files.find((f) => f.kind === "text" && f.path === "main.tex");
  if (main) return main.path;
  return files.find((f) => f.kind === "text" && f.path.endsWith(".tex"))?.path ?? null;
}

/** Common copy for the "your tmpdir was swept" fatal card. The card is
 *  idempotent — multiple callers racing to surface the same condition
 *  collapse onto a single overlay. */
function sessionExpiredCard(): void {
  showFatalCard(
    "Session expired",
    "Your editing session was cleaned up after a long idle period. Reloading to start a fresh one.",
  );
}

/** Two-line summary for the upload-skipped notice. Headline carries the
 *  count; the second line names a few examples (truncated past a
 *  reasonable cap so a multi-hundred-file build directory doesn't blow
 *  out the banner). */
function formatSkippedMessage(skipped: string[]): string {
  const max = 8;
  const head = skipped.slice(0, max).map((p) => p.split("/").pop() || p);
  const more = skipped.length > max ? `, +${skipped.length - max} more` : "";
  const noun = skipped.length === 1 ? "file" : "files";
  return `Skipped ${skipped.length} ${noun} with unsupported extensions\n${head.join(", ")}${more}`;
}

/** Recursively flatten a list of `FileSystemEntry` (from a drag-drop
 *  `webkitGetAsEntry()` walk) into a flat list of `File`s, each with
 *  a synthetic `webkitRelativePath` so the server preserves the
 *  folder hierarchy. Mirrors what `<input webkitdirectory>` posts —
 *  but the walk is async/lazy via the file system entry API, so
 *  dropping a giant tree doesn't block the UI thread. */
async function readEntriesAsFiles(
  entries: FileSystemEntry[],
  pathPrefix = "",
): Promise<File[]> {
  const out: File[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      const rel = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
      // Force `webkitRelativePath` on the synthetic File — `actionUploadFiles`
      // reads it to build the multipart filename, exactly as it does for
      // <input webkitdirectory>.
      Object.defineProperty(file, "webkitRelativePath", {
        configurable: true,
        value: rel,
      });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const collected: FileSystemEntry[] = [];
      for (;;) {
        // `readEntries` is paginated: it returns at most ~100 entries
        // per call, so we loop until it returns an empty batch.
        const batch = await new Promise<FileSystemEntry[]>(
          (resolve, reject) => reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        collected.push(...batch);
      }
      const sub = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
      out.push(...(await readEntriesAsFiles(collected, sub)));
    }
  }
  return out;
}

function buildTree(files: FileMeta[]): TreeNode[] {
  // Build nested tree from flat path list. Any directory entries the
  // server emitted are absorbed; we'll re-emit our own shells for any
  // path segment.
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirs = new Map<string, TreeNode>();
  dirs.set("", root);
  // Sort so dirs land before files at the same depth (stable display).
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    if (f.kind === "dir") {
      ensureDir(f.path);
      continue;
    }
    const segs = f.path.split("/");
    const leaf = segs.pop()!;
    const parentPath = segs.join("/");
    const parent = ensureDir(parentPath);
    parent.children.push({
      name: leaf,
      path: f.path,
      isDir: false,
      children: [],
    });
  }
  return root.children;

  function ensureDir(path: string): TreeNode {
    if (dirs.has(path)) return dirs.get(path)!;
    const segs = path.split("/");
    const leaf = segs.pop()!;
    const parentPath = segs.join("/");
    const parent = ensureDir(parentPath);
    const node: TreeNode = { name: leaf, path, isDir: true, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  }
}

function makeTextButton(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  b.textContent = label;
  return b;
}

function isEditableExtension(path: string): boolean {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return [
    "tex", "sty", "cls", "bib", "bst", "bbl", "def", "ldf",
    "txt", "md", "csv", "toml", "json", "yaml", "yml", "svg",
  ].includes(ext);
}

function stripExt(name: string): string {
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}
