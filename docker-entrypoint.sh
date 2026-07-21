#!/bin/sh
# Ensure the data volume is writable by the app user, then drop privileges.
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  # Bind mounts (./data:/data) keep host ownership and often aren't writable by
  # uid 1001. Fix that before starting Node.
  need_fix=0
  if ! su-exec app:app test -w "$DATA_DIR" 2>/dev/null; then
    need_fix=1
  elif [ -e "$DATA_DIR/db.json" ] && ! su-exec app:app test -w "$DATA_DIR/db.json" 2>/dev/null; then
    need_fix=1
  fi

  if [ "$need_fix" = "1" ]; then
    echo "[entrypoint] fixing ownership of ${DATA_DIR} for app (uid 1001)"
    chown -R app:app "$DATA_DIR" || {
      echo "[entrypoint] WARNING: could not chown ${DATA_DIR} — writes may fail" >&2
    }
  else
    # Still ensure the directory itself is owned (cheap; avoids empty-dir edge cases)
    chown app:app "$DATA_DIR" 2>/dev/null || true
  fi

  exec su-exec app:app "$@"
fi

exec "$@"
