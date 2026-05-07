/// <reference types="vite/client" />
// Examples loaded from the top-level `examples/` directory, the single
// source of truth shared with the Rust server (which embeds the same
// tree via `include_dir!`). The order, display names, and entry files
// come from `examples/_index.json`; the source for plain examples comes
// from `examples/<slug>/<entry>` via Vite's `import.meta.glob`. Examples
// declared with an `archive` field (a `.zip` or `.tar.gz` shipped under
// `examples/<slug>/`) are *not* eagerly inlined — they are seeded into a
// session by the server at slot-create time, and only their metadata is
// surfaced to the frontend.

import indexJson from "@examples/_index.json";

export interface ExampleManifestEntry {
  name: string;
  slug: string;
  entry: string;
  /** Optional: a `.zip` or `.tar.gz` filename under `examples/<slug>/`
   *  that the server unpacks into the session at slot-create time. */
  archive?: string;
  /** Soft-hide for examples we want to keep in the tree but not show
   *  in the dropdown — filtered out before `EXAMPLES_LIST` is built. */
  disabled?: boolean;
}

interface ExampleManifest {
  examples: ExampleManifestEntry[];
}

const manifest = indexJson as ExampleManifest;

// Eager-glob every plain `.tex` source. Archive-bearing examples don't
// match this pattern and are intentionally excluded — their content
// lives only on the server until the slot is created.
const sources = import.meta.glob("@examples/**/*.tex", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function lookup(slug: string, entry: string): string | null {
  const suffix = `/examples/${slug}/${entry}`;
  for (const [k, v] of Object.entries(sources)) {
    if (k.endsWith(suffix)) return v;
  }
  return null;
}

export interface ExampleEntry extends ExampleManifestEntry {
  /** Eagerly-loaded TeX source for plain (non-archive) examples;
   *  `null` for archive-bearing ones. The dropdown uses this for
   *  the v1.1-shim direct-load path; v1.2 routes everything through
   *  the slot/session API regardless. */
  source: string | null;
}

export const EXAMPLES_LIST: ExampleEntry[] = manifest.examples
  .filter((e) => !e.disabled)
  .map((e) => {
    // Three flavours surface here:
    //  - archive-bearing entries: server unpacks at slot-create, no
    //    client-side body needed.
    //  - empty-entry pseudo-slots (e.g. "new"): seed nothing on the
    //    server; the dropdown just routes the slot switch.
    //  - everything else: eagerly inline the .tex source so the
    //    legacy direct-load shim still works.
    const isPseudo = !e.archive && e.entry === "";
    const source = e.archive || isPseudo ? null : lookup(e.slug, e.entry);
    if (source === null && !e.archive && !isPseudo) {
      throw new Error(`example source not found: ${e.slug}/${e.entry}`);
    }
    return { ...e, source };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// Back-compat shim for the legacy `EXAMPLES` map indexed by display name.
// Archive-bearing examples are omitted (no client-side body to inline);
// once the file panel and session model land, the dropdown will route
// through the slot API and this shim goes away entirely.
export const EXAMPLES: Record<string, string> = Object.fromEntries(
  EXAMPLES_LIST.filter((e) => e.source !== null).map((e) => [e.name, e.source as string]),
);
