#!/bin/sh
# Syncs the unitedstates/congress-legislators YAML files to the shared volume.
# On first run it clones the repo; subsequent runs do a fast-forward pull.
# Output lands at /congress/data/legislators/*.yaml — the path ingest-legislators.js expects.

REPO_URL="https://github.com/unitedstates/congress-legislators.git"
TARGET_DIR="/congress/data/legislators"

if [ -d "$TARGET_DIR/.git" ]; then
    echo "$(date): Pulling legislators data..."
    git -C "$TARGET_DIR" pull --ff-only
else
    echo "$(date): Cloning legislators data (first run)..."
    mkdir -p "$(dirname "$TARGET_DIR")"
    git clone --depth=1 "$REPO_URL" "$TARGET_DIR"
fi

echo "$(date): Legislators sync complete."
