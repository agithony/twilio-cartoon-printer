#!/bin/sh
set -e

# If an Azure Files mount is present, symlink app directories to persistent storage.
# This lets the app use normal fs calls while data survives container restarts.
DATA_MOUNT="${DATA_MOUNT:-/app/appdata}"

if [ -d "$DATA_MOUNT" ]; then
  echo "Persistent storage detected at $DATA_MOUNT"
  # Only directories that hold runtime-mutable state (uploads, jobs, user
  # uploads, per-event config) belong on the persistent share. Directories
  # shipped in the image — like assets/ — MUST NOT be included: the seed
  # step uses "cp -rn" which refuses to overwrite, so once a file lands
  # on the share it sticks forever and newer image versions are never
  # picked up. (assets/ previously was in this list; a stale
  # twilio-brand.css from early April masked every CSS change shipped
  # since then.)
  for dir in data queue downloads brand-references style-references background-references templates booth-uploads; do
    mkdir -p "$DATA_MOUNT/$dir"
    # Queue has subdirectories
    if [ "$dir" = "queue" ]; then
      for sub in pending generating review ready printing done failed; do
        mkdir -p "$DATA_MOUNT/$dir/$sub"
      done
    fi
    # Seed persistent storage with built-in defaults (won't overwrite existing)
    if [ -d "/app/$dir" ]; then
      cp -rn /app/$dir/. "$DATA_MOUNT/$dir/" 2>/dev/null || true
    fi
    rm -rf "/app/$dir"
    ln -sf "$DATA_MOUNT/$dir" "/app/$dir"
    echo "  Linked /app/$dir -> $DATA_MOUNT/$dir"
  done
  echo "Persistent storage linked successfully."
else
  echo "No persistent mount at $DATA_MOUNT -- using ephemeral container storage."
fi

exec node index.js
