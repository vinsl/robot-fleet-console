#!/usr/bin/env bash
# Vendors the browser bundle of the Kinesis Video Streams WebRTC SDK into public/vendor (ADR 0026).
# Usage: bash scripts/vendor-kvs-webrtc.sh <major.minor.patch>
#        (or pnpm --filter @mfc/robot-video vendor:kvs)
# Downloads the registry metadata and the tarball into a fresh temporary directory, refuses a version
# published less than 14 days ago or whose tarball does not match the npm integrity, then installs four
# files: the minified bundle and its licence files. Nothing from the tarball is executed.
set -euo pipefail

package="amazon-kinesis-video-streams-webrtc"
registry="https://registry.npmjs.org"
min_age_seconds=$((14 * 24 * 60 * 60))

version="${1:-}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch>" >&2
  exit 2
fi

for tool in curl jq openssl base64 tar install sha256sum date; do
  command -v "$tool" >/dev/null || { echo "vendor: $tool is required" >&2; exit 1; }
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$(dirname "$script_dir")/public/vendor"

# Downloads are kept in a directory that this script creates and deletes; the repository is never a
# download location.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

metadata="$work/metadata.json"
curl -fsS --proto '=https' --tlsv1.2 -o "$metadata" "$registry/$package"

if ! jq -e --arg v "$version" '.versions[$v] != null' "$metadata" >/dev/null; then
  echo "vendor: version $version is not published for $package" >&2
  exit 1
fi
integrity="$(jq -er --arg v "$version" '.versions[$v].dist.integrity' "$metadata")"
tarball="$(jq -er --arg v "$version" '.versions[$v].dist.tarball' "$metadata")"
published="$(jq -er --arg v "$version" '.time[$v]' "$metadata")"

case "$tarball" in
  "$registry/"*) ;;
  *) echo "vendor: the tarball of $version is not on $registry; refusing" >&2; exit 1 ;;
esac

published_epoch="$(date -u -d "$published" +%s)"
now_epoch="$(date -u +%s)"
if (( now_epoch - published_epoch < min_age_seconds )); then
  echo "vendor: $version was published less than 14 days ago ($published); refusing" >&2
  exit 1
fi

archive="$work/package.tgz"
curl -fsS --proto '=https' --tlsv1.2 -o "$archive" "$tarball"
actual_integrity="sha512-$(openssl dgst -sha512 -binary "$archive" | base64 -w0)"
if [[ "$actual_integrity" != "$integrity" ]]; then
  echo "vendor: the tarball of $version does not match its npm integrity; refusing" >&2
  exit 1
fi

# Only the four members named here are extracted. A member that is a symlink or not a regular file is
# refused, so that a link cannot redirect the copy to another file.
members=(
  "package/dist/kvs-webrtc.min.js"
  "package/dist/kvs-webrtc.LICENSE"
  "package/LICENSE.txt"
  "package/NOTICE.txt"
)
extracted="$work/extracted"
mkdir "$extracted"
tar -xzf "$archive" -C "$extracted" "${members[@]}"
for member in "${members[@]}"; do
  path="$extracted/$member"
  if [[ -L "$path" || ! -f "$path" ]]; then
    echo "vendor: $member is not a regular file in the tarball; refusing" >&2
    exit 1
  fi
done

mkdir -p "$target"
install -m 644 "$extracted/package/dist/kvs-webrtc.min.js" "$target/kvs-webrtc.min.js"
install -m 644 "$extracted/package/dist/kvs-webrtc.LICENSE" "$target/kvs-webrtc.LICENSE"
install -m 644 "$extracted/package/LICENSE.txt" "$target/LICENSE.txt"
install -m 644 "$extracted/package/NOTICE.txt" "$target/NOTICE.txt"

file_sha256="$(sha256sum "$target/kvs-webrtc.min.js" | cut -d' ' -f1)"
printf 'vendored %s %s into public/vendor\n' "$package" "$version"
printf 'publishedAt: %s\n' "$published"
printf 'npmIntegrity: %s\n' "$integrity"
printf 'fileSha256: %s\n' "$file_sha256"
