#!/usr/bin/env bash
# Downloads ONE heart of the Strocchi et al. virtual cohort (Zenodo record 3890034,
# CC BY 4.0) into ~/heart-data (outside the repo) and extracts it.
# Raw data is never committed. Usage: tools/fetch_heart.sh [archive]   (default: 23.tar.gz,
# the smallest of the 24 archives at the time of writing, ~700 MB)
#
# The archive is checked against its md5 before anything is unpacked, and the script stops if it does not match.
# The md5 of 23.tar.gz is built in (the one tools/README.md gives). For another archive, set HEART_MD5 to the md5 in
# the Zenodo file list; without one the script stops before it downloads anything.
set -euo pipefail

ARCHIVE="${1:-23.tar.gz}"
DEST="${HEART_DATA_DIR:-$HOME/heart-data}"
URL="https://zenodo.org/api/records/3890034/files/${ARCHIVE}/content"

case "$ARCHIVE" in
  23.tar.gz) KNOWN_MD5="880a642341f66700986dee7d58891c2d" ;;
  *) KNOWN_MD5="" ;;
esac
WANT_MD5="$(printf '%s' "${HEART_MD5:-$KNOWN_MD5}" | tr '[:upper:]' '[:lower:]')"
if [ -z "$WANT_MD5" ]; then
  echo "fetch_heart.sh: no md5 is known for $ARCHIVE, so it cannot be checked. Set HEART_MD5 to the md5 in the Zenodo file list (https://zenodo.org/records/3890034) and run this again." >&2
  exit 1
fi

# The md5 of a file: macOS has md5, Linux has md5sum.
md5_of() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$1"
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | cut -d ' ' -f 1
  else
    echo "fetch_heart.sh: neither md5 nor md5sum is installed, so the download cannot be checked." >&2
    return 1
  fi
}

mkdir -p "$DEST"
cd "$DEST"

# -C - resumes a partial download, -L follows redirects
curl -L -C - --fail --retry 5 -o "$ARCHIVE" "$URL"

GOT_MD5="$(md5_of "$ARCHIVE")"
if [ "$GOT_MD5" != "$WANT_MD5" ]; then
  echo "fetch_heart.sh: $DEST/$ARCHIVE has the wrong md5: wanted $WANT_MD5, got $GOT_MD5. Nothing was unpacked." >&2
  echo "A broken download is the likely cause: delete the file and run this again. If it keeps failing, the file on Zenodo may have changed." >&2
  exit 1
fi
echo "md5 ok: $GOT_MD5"

DIR="${ARCHIVE%.tar.gz}"
mkdir -p "$DIR"
tar -xzf "$ARCHIVE" -C "$DIR"

echo "Extracted into $DEST/$DIR:"
find "$DIR" -type f -exec ls -l {} \; | awk '{print $5, $9}'
