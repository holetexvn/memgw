#!/usr/bin/env bash
# Build the self-extracting server installer that the README and docs refer to:
# the installer header script with a base64-encoded tarball of the source tree
# appended after the __ARCHIVE__ marker (that is what the header extracts).
#
#   bash scripts/build-installer.sh          # writes ./memgw-installer.run
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=memgw-installer.run
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The header extracts with `tar xz -C /opt` and expects everything under
# /opt/memgw -- so the archive MUST carry a single memgw/ top-level directory.
# Stage into one (portable across BSD and GNU tar) rather than relying on
# --transform / -s flags.
STAGE="$TMP/memgw"
mkdir -p "$STAGE"
cp -R bin src agents hooks hermes-plugin deploy docs scripts test "$STAGE/"
cp package.json package-lock.json README.md README_VI.md LICENSE CHANGELOG.md .env.example "$STAGE/"
rm -rf "$STAGE"/*/node_modules "$STAGE"/data
tar czf "$TMP/memgw.tgz" -C "$TMP" memgw

cat deploy/installer-header.sh > "$OUT"
base64 -i "$TMP/memgw.tgz" >> "$OUT"
chmod +x "$OUT"

# self-check: the layout the header depends on must actually be in the archive.
# List into a file first: `grep -q` closing the pipe early gives tar an EPIPE,
# which pipefail turns into a bogus failure.
ARCHIVE_LINE=$(awk '/^__ARCHIVE__$/{print NR+1; exit}' "$OUT")
tail -n +"$ARCHIVE_LINE" "$OUT" | base64 -d | tar tz > "$TMP/contents.txt"
if ! grep -q "^memgw/package.json$" "$TMP/contents.txt"; then
  echo "BUILD BROKEN: archive does not contain memgw/package.json" >&2
  exit 1
fi
SIZE=$(du -h "$OUT" | cut -f1)
echo "built $OUT ($SIZE) -- archive layout verified (memgw/ top-level)"
