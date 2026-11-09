#!/bin/bash
# Install or update Restless on macOS:
#   curl -fsSL https://raw.githubusercontent.com/Shivendra-99/restless/main/scripts/install-mac.sh | bash
#
# Restless is open source and not notarized by Apple (that needs a paid Apple account). A browser
# marks what it downloads as "from the internet", and macOS then refuses to open the app until you
# allow it in System Settings. curl doesn't add that mark, so the app installed by this script opens
# normally. It downloads the latest release from GitHub, checks its SHA-256 against the release's
# SHA256SUMS.txt, and copies Restless.app into /Applications (or ~/Applications if that isn't writable).
set -euo pipefail

REPO="${RESTLESS_REPO:-Shivendra-99/restless}"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '%s\n' "$*"; }
fail() { printf 'Restless install failed: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this script is for macOS."

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *) fail "unsupported Mac processor: $(uname -m)" ;;
esac
# An Intel shell under Rosetta still reports x86_64; prefer the native build on Apple silicon.
if [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then arch="arm64"; fi

say "Finding the latest Restless release…"
release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || fail "could not reach GitHub."

asset_url() {
  # Print the download URL of the asset whose name matches $1 (a grep -E pattern).
  printf '%s\n' "$release_json" | grep -Eo '"browser_download_url": *"[^"]+"' | sed -E 's/.*"(https[^"]+)"/\1/' | grep -E "$1" | head -n 1
}

dmg_url="$(asset_url "/Restless-[^/]*-${arch}\\.dmg$")"
[ -n "$dmg_url" ] || fail "no ${arch} build in the latest release."
sums_url="$(asset_url '/SHA256SUMS\.txt$')"
dmg_name="${dmg_url##*/}"

tmp="$(mktemp -d)"
mnt="$tmp/mount"
cleanup() {
  hdiutil detach "$mnt" -quiet 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

say "Downloading $dmg_name…"
curl -fL --progress-bar -o "$tmp/$dmg_name" "$dmg_url" || fail "download failed."

if [ -n "$sums_url" ]; then
  expected="$(curl -fsSL "$sums_url" | grep -F " $dmg_name" | awk '{print $1}')"
  actual="$(shasum -a 256 "$tmp/$dmg_name" | awk '{print $1}')"
  [ -n "$expected" ] || fail "$dmg_name is not listed in SHA256SUMS.txt."
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $dmg_name."
  say "Checksum OK."
fi

mkdir -p "$mnt"
hdiutil attach "$tmp/$dmg_name" -nobrowse -readonly -quiet -mountpoint "$mnt" || fail "could not open the disk image."
[ -d "$mnt/Restless.app" ] || fail "Restless.app not found in the disk image."

dest="/Applications"
if [ ! -w "$dest" ]; then
  dest="$HOME/Applications"
  mkdir -p "$dest"
fi

if pgrep -xq Restless; then
  say "Closing the running Restless…"
  osascript -e 'quit app "Restless"' >/dev/null 2>&1 || true
  sleep 2
fi

rm -rf "$dest/Restless.app"
ditto "$mnt/Restless.app" "$dest/Restless.app"

say "Restless is installed in $dest. Opening it…"
open "$dest/Restless.app"
