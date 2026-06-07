# Bundled examples

Each subdirectory is a self-contained example project surfaced in the
editor's example picker (`_index.json` is the catalog). The trees are
embedded into the server binary (`include_dir` in
`crates/ar5iv-editor-server`) and mirrored by the frontend's Vite glob,
so adding an example means adding a directory and a catalog entry —
no other wiring.

Examples are expected to convert *cleanly*: they showcase what the
engine does right, and conversion noise in one of them reads as a bug.

## Future work

- **Error-behavior showcase**: a dedicated example that deliberately
  triggers the engine's error classes (undefined control sequence,
  missing package, math-mode misuse, missing `\end{…}`, bad image
  path, …) so users can see how errors are surfaced in the preview —
  and how the generated HTML carries `ltx_ERROR` markup that the
  scholarly validation profile accepts. Until that exists, keep
  deliberate errors out of the other examples.
