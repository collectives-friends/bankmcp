#!/bin/sh
# Platform volumes (Railway, Fly, Docker named volumes) are usually mounted
# owned by root. If we start as root, hand the data directory to the
# unprivileged user and continue as that user.
set -e
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
