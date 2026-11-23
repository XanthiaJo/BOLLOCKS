#!/usr/bin/env bash
# Build the downloadable release artifacts for <tag> into <outdir>:
#
#   bollocks-<ver>-docker.zip — self-contained bundle: image tarball +
#     image-only compose + install.sh/.ps1. Works offline; no pull, no build.
#   bollocks-<ver>-source.zip — source snapshot whose compose has build:
#     already, so `docker compose up` just builds. .deploy-sha is stamped so
#     /api/version reports the released commit without a .git dir.
#
# Called by release.yml (stable tag) and beta.yml (prerelease tag) after the
# release exists; the workflow uploads dist/*.zip to the GitHub release.
set -euo pipefail

TAG="${1:?usage: make-artifacts.sh <tag> <outdir>}"
OUT="${2:-dist}"
VER="${TAG#v}"
SHA="$(git rev-parse --short HEAD)"
IMG="bollocks:${VER}"
ROOT="$(pwd)"

mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"   # absolute — mkzip writes from subshells
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bundle" "$work/source"

# zip(1) on GH runners; python fallback for local runs without it (python3
# may be a Windows Store shim — try it, then plain python).
mkzip() { # mkzip <srcdir> <outfile.zip>
    if command -v zip >/dev/null; then (cd "$1" && zip -q -r "$2" .); return; fi
    for p in python3 python; do
        command -v "$p" >/dev/null || continue
        "$p" -c "import shutil,sys; shutil.make_archive(sys.argv[1],'zip',sys.argv[2])" "${2%.zip}" "$1" && return
    done
    echo "mkzip: need zip or python" >&2; return 1
}

# --- A: docker bundle (offline) ------------------------------------------
docker build -t "$IMG" --build-arg "GIT_SHA=$SHA" "$ROOT"
docker save "$IMG" | gzip > "$work/bundle/bollocks-${VER}-image.tar.gz"

cat > "$work/bundle/docker-compose.yml" <<EOF
# BOLLOCKS ${TAG} — offline bundle compose.
# install.sh loads the image from the tarball — no build, no pull.
services:
  bollocks:
    image: ${IMG}
    container_name: bollocks
    restart: unless-stopped
    ports:
      - "8100:8100"
    environment:
      - PORT=8100
      - BOLLOCKS_SEED=0
    volumes:
      - bollocks-data:/app/data

volumes:
  bollocks-data:
EOF

cat > "$work/bundle/install.sh" <<EOF
#!/bin/sh
# BOLLOCKS ${TAG} — load the bundled image and start it.
set -e
cd "\$(dirname "\$0")"
echo "Loading BOLLOCKS image…"
docker load -i "bollocks-${VER}-image.tar.gz"
echo "Starting…"
docker compose up -d
echo "Done — http://localhost:8100"
EOF
chmod +x "$work/bundle/install.sh"

cat > "$work/bundle/install.ps1" <<EOF
# BOLLOCKS ${TAG} — load the bundled image and start it.
\$ErrorActionPreference = 'Stop'
Set-Location \$PSScriptRoot
docker load -i "bollocks-${VER}-image.tar.gz"
docker compose up -d
"Done — http://localhost:8100"
EOF

cat > "$work/bundle/README.txt" <<EOF
BOLLOCKS ${TAG} — self-contained docker bundle

No registry, no build — the image is inside this zip.

  1. Unzip somewhere
  2. ./install.sh        (Linux/macOS)
     .\\install.ps1      (Windows PowerShell)
  3. http://localhost:8100

Data persists in the 'bollocks-data' docker volume.
Upgrade: unzip the next release's bundle into a new folder and run its
installer — the volume carries your data forward.
EOF

mkzip "$work/bundle" "$OUT/bollocks-${VER}-docker.zip"

# --- B: source snapshot (compose builds it) -------------------------------
git -C "$ROOT" archive HEAD | tar -x -C "$work/source"
echo "$SHA" > "$work/source/.deploy-sha"
# Bake the sha into the staged compose too — .deploy-sha only helps bare
# `npm start`; the Dockerfile doesn't copy it into the image.
sed -i "s|\${GIT_SHA:-}|$SHA|g" "$work/source/docker-compose.yml"
mkzip "$work/source" "$OUT/bollocks-${VER}-source.zip"

echo "Built:"
ls -lh "$OUT"
