#!/usr/bin/env bash
# One-time setup of the Codespace: package managers, scanners and git hooks.
# Every scanner is pinned to the version CI uses; binaries downloaded from GitHub are checked
# against a SHA-256 digest committed here, so a tampered or re-tagged release fails the setup.
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq jq >/dev/null
corepack enable && corepack install
mkdir -p "$HOME/.local/bin"
UV_TMP="$(mktemp -d)"
curl -sSfL -o "$UV_TMP/uv.tar.gz" https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-gnu.tar.gz
echo "f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645  $UV_TMP/uv.tar.gz" | sha256sum --check --strict
tar -xzf "$UV_TMP/uv.tar.gz" -C "$HOME/.local/bin" --strip-components=1 uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx
rm -rf "$UV_TMP"
export PATH="$HOME/.local/bin:$PATH"
uv tool install pre-commit==4.7.0
uv tool install checkov==3.3.29
uv tool install semgrep==1.181.0
uv tool install zizmor==1.31.1

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

GITLEAKS_VERSION=8.30.1
GITLEAKS_ASSET="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
curl -sSfL -o "$WORK_DIR/$GITLEAKS_ASSET" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ASSET}"
echo "${GITLEAKS_SHA256}  $WORK_DIR/$GITLEAKS_ASSET" | sha256sum --check --strict
sudo tar -xz -C /usr/local/bin -f "$WORK_DIR/$GITLEAKS_ASSET" gitleaks

TRIVY_VERSION=0.70.0
TRIVY_ASSET="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
TRIVY_SHA256=8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9
curl -sSfL -o "$WORK_DIR/$TRIVY_ASSET" \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${TRIVY_ASSET}"
echo "${TRIVY_SHA256}  $WORK_DIR/$TRIVY_ASSET" | sha256sum --check --strict
sudo tar -xz -C /usr/local/bin -f "$WORK_DIR/$TRIVY_ASSET" trivy

if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; fi
if [ -f agent/uv.lock ]; then (cd agent && uv sync --frozen --all-extras); fi
pre-commit install --hook-type pre-commit --hook-type pre-push
echo "Codespace ready. Next: aws configure sso (once), then aws sso login --use-device-code."
