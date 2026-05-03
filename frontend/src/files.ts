// File panel — tree rendering, header upload/download/import actions,
// click-to-open into the editor. No rename / delete in v1.2 per
// `docs/FileUI.md` "Non-goals". Auto-convert is triggered via the
// `requestPreview` callback after every successful file-op response.

import type { EditorHandle } from "./editor.ts";
import type { FileMeta, SessionClient, SessionEnvelope } from "./session.ts";
import { SessionExpiredError } from "./session.ts";

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

const ALLOWED_ARCHIVE_EXTENSIONS = ".zip,.tar.gz,.tgz,application/zip,application/gzip,application/x-tar";

export class FilePanel {
  private opts:        FilePanelOptions;
  private active:      string | null;
  private collapsed:   Set<string> = new Set();

  constructor(opts: FilePanelOptions) {
    this.opts = opts;
    this.active = opts.session.envelope.entry || null;
    this.renderActions();
    this.render();
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

  /** Refresh the file list from the server (e.g., after an upload). */
  async refresh(): Promise<void> {
    try {
      const listing = await this.opts.session.listFiles();
      this.opts.session.envelope = {
        ...this.opts.session.envelope,
        files: listing.files,
      };
      this.render();
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        await this.opts.session.reopen();
        this.opts.onSessionSwap(this.opts.session.envelope);
      } else {
        this.opts.reportError(`refresh failed: ${e}`);
      }
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
      icon.textContent = n.isDir
        ? this.collapsed.has(n.path) ? "▶" : "▼"
        : iconForExt(n.name);
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

      // Per-row kebab — Download only in v1.2 (per Non-goals).
      if (!n.isDir) {
        const kebab = document.createElement("a");
        kebab.className = "ftree-kebab";
        kebab.href = this.opts.session.fileUrl(n.path);
        kebab.title = "Download";
        kebab.textContent = "⬇";
        // Force download with a sensible filename.
        kebab.download = n.name;
        kebab.addEventListener("click", (e) => e.stopPropagation());
        li.appendChild(kebab);
      }

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
        await this.opts.session.reopen();
        this.opts.onSessionSwap(this.opts.session.envelope);
      } else {
        this.opts.reportError(`open ${path} failed: ${e}`);
      }
    }
  }

  // -------------------------------------------------------------------
  // Header actions.
  // -------------------------------------------------------------------

  private renderActions(): void {
    this.opts.actionsEl.replaceChildren();

    const newFileBtn = makeIconButton("+", "New file");
    newFileBtn.addEventListener("click", () => void this.actionNewFile());
    this.opts.actionsEl.appendChild(newFileBtn);

    const uploadFilesBtn = makeIconButton("↑", "Upload files");
    uploadFilesBtn.addEventListener("click", () => this.triggerUpload(false, false));
    this.opts.actionsEl.appendChild(uploadFilesBtn);

    const uploadFolderBtn = makeIconButton("📁", "Upload folder");
    uploadFolderBtn.addEventListener("click", () => this.triggerUpload(true, false));
    this.opts.actionsEl.appendChild(uploadFolderBtn);

    const importArchiveBtn = makeIconButton("📦", "Import archive (ZIP / tar.gz) as new project");
    importArchiveBtn.addEventListener("click", () => this.triggerUpload(false, true));
    this.opts.actionsEl.appendChild(importArchiveBtn);

    const exportBtn = makeIconButton("⬇", "Download project as ZIP");
    exportBtn.addEventListener("click", () => void this.actionExport());
    this.opts.actionsEl.appendChild(exportBtn);
  }

  private triggerUpload(folder: boolean, archive: boolean): void {
    const input = document.createElement("input");
    input.type = "file";
    if (folder) {
      // `webkitdirectory` is the de-facto standard now (Chrome/Edge/
      // Safari/Firefox all support it). Picks an entire folder.
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
      input.multiple = true;
    } else if (archive) {
      input.accept = ALLOWED_ARCHIVE_EXTENSIONS;
    } else {
      input.multiple = true;
    }
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      if (archive) {
        void this.actionImportArchive(files[0]!);
      } else {
        void this.actionUploadFiles(files);
      }
    });
    input.click();
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
        await this.opts.session.reopen();
        this.opts.onSessionSwap(this.opts.session.envelope);
        return;
      }
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`upload failed: ${resp.status} ${txt}`);
      }
      await this.refresh();
      this.opts.requestPreview();
    } catch (e) {
      this.opts.reportError(`upload failed: ${e}`);
    }
  }

  private async actionImportArchive(file: File): Promise<void> {
    try {
      const buf = await file.arrayBuffer();
      const resp = await fetch("/api/import-archive", {
        method:  "POST",
        body:    buf,
        headers: {
          [HEADER_USER]: this.opts.session.userId,
          "content-type": guessArchiveCt(file.name),
        },
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`import archive failed: ${resp.status} ${txt}`);
      }
      const env = (await resp.json()) as SessionEnvelope;
      // Server has minted a new slot — point our SessionClient at it
      // and let the driver re-bind the WS / load the new entry file.
      this.opts.session.envelope = env;
      sessionStorage.setItem("ar5iv.current_slot", env.slot);
      this.opts.onSessionSwap(env);
    } catch (e) {
      this.opts.reportError(`import archive failed: ${e}`);
    }
  }

  private async actionExport(): Promise<void> {
    try {
      const url = `/api/session/${this.opts.session.envelope.id}/export-zip`;
      const resp = await fetch(url, {
        headers: { [HEADER_USER]: this.opts.session.userId },
      });
      if (!resp.ok) throw new Error(`export failed: ${resp.status}`);
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
      this.opts.reportError(`export failed: ${e}`);
    }
  }
}

// -----------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------

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

function makeIconButton(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  b.textContent = label;
  return b;
}

function iconForExt(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  switch (ext) {
    case "tex": case "sty": case "cls": case "bib": case "bst": case "bbl":
      return "📄";
    case "png": case "jpg": case "jpeg": case "gif": case "svg":
      return "🖼";
    case "pdf":
      return "📕";
    default:
      return "📄";
  }
}

function isEditableExtension(path: string): boolean {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return [
    "tex", "sty", "cls", "bib", "bst", "bbl",
    "txt", "md", "csv", "toml", "json", "yaml", "yml", "svg",
  ].includes(ext);
}

function stripExt(name: string): string {
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}

function guessArchiveCt(name: string): string {
  if (name.toLowerCase().endsWith(".zip")) return "application/zip";
  if (name.toLowerCase().endsWith(".tar.gz")) return "application/gzip";
  if (name.toLowerCase().endsWith(".tgz")) return "application/gzip";
  return "application/octet-stream";
}
