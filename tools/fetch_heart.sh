#!/usr/bin/env bash
# Downloads ONE heart of the Strocchi et al. virtual cohort (Zenodo record 3890034,
# CC BY 4.0) into ~/heart-data (outside the repo) and extracts it.
# Raw data is never committed. Usage: tools/fetch_heart.sh [archive]   (default: 23.tar.gz,
# the smallest of the 24 archives at the time of writing, ~700 MB)
set -euo pipefail

ARCHIVE="${1:-23.tar.gz}"
DEST="${HEART_DATA_DIR:-$HOME/heart-data}"
URL="https://zenodo.org/api/records/3890034/files/${ARCHIVE}/content"

mkdir -p "$DEST"
cd "$DEST"

# -C - resumes a partial download, -L follows redirects
curl -L -C - --fail --retry 5 -o "$ARCHIVE" "$URL"

DIR="${ARCHIVE%.tar.gz}"
mkdir -p "$DIR"
tar -xzf "$ARCHIVE" -C "$DIR"

echo "Extracted into $DEST/$DIR:"
find "$DIR" -type f -exec ls -l {} \; | awk '{print $5, $9}'
