#!/usr/bin/env bash
# Build a prebuilt-binary release of the self-contained `ar5iv-editor` server
# for the VS Code extension to download on first activation.
#
# Produces in target/server-release/:
#   ar5iv-editor-<version>-<triple>.tar.gz         — staged binary (dir/ar5iv-editor)
#   ar5iv-editor-<version>-<triple>.tar.gz.sha256  — sha256sum sidecar
#
# The binary dynamically links libxml2/libxslt/libkpathsea and resolves
# unbound packages via system TeX Live (see docs/VSCODE_PREVIEW.md, "Plug-And-
# Play Distribution Roadmap"). For broad glibc compatibility build on an older
# LTS (the latexml-oxide release CI uses ubuntu-22.04 / glibc 2.35).
#
# Local use (latexml-oxide checked out as a sibling, matching the path dep):
#   bash tools/make-server-release.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

version="$(grep -m1 -E '^version = "' Cargo.toml | sed -E 's/^version = "(.+)"$/\1/')"
triple="${TARGET_TRIPLE:-x86_64-unknown-linux-gnu}"
stage_name="ar5iv-editor-${version}-${triple}"
out_dir="target/server-release"
stage_dir="${out_dir}/${stage_name}"

echo "make-server-release: version=${version} triple=${triple}"
rm -rf "${out_dir}"
mkdir -p "${stage_dir}"

cargo build --release -p ar5iv-editor-server
bin="target/release/ar5iv-editor"
[[ -x "${bin}" ]] || { echo "build did not produce ${bin}" >&2; exit 1; }
strip --strip-all "${bin}" 2>/dev/null || true

cp "${bin}" "${stage_dir}/ar5iv-editor"
tar -czf "${out_dir}/${stage_name}.tar.gz" -C "${out_dir}" "${stage_name}"
( cd "${out_dir}" && sha256sum "${stage_name}.tar.gz" > "${stage_name}.tar.gz.sha256" )

echo "make-server-release: wrote"
ls -lh "${out_dir}/${stage_name}.tar.gz" "${out_dir}/${stage_name}.tar.gz.sha256"
echo "Publish with: gh release create ${version} ${out_dir}/${stage_name}.tar.gz* -R dginev/ar5iv-editor"
