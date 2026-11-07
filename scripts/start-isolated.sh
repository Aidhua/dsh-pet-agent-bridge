#!/usr/bin/env bash
# Start an ISOLATED DSH host for testing the bridge (never touches ~/.dsh).
#
#   DSH_BIN=... DSH_HOME=... DSH_PROFILE=petlab DSH_PORT=39190 ./start-isolated.sh
set -euo pipefail

DSH_BIN="${DSH_BIN:-dsh}"
DSH_HOME="${DSH_HOME:-$(cd "$(dirname "$0")/../.." && pwd)/petlab-dsh-home}"
DSH_PROFILE="${DSH_PROFILE:-petlab}"
DSH_PORT="${DSH_PORT:-39190}"

mkdir -p "$DSH_HOME"

echo "[petlab] DSH_BIN     = $DSH_BIN"
echo "[petlab] DSH_HOME    = $DSH_HOME"
echo "[petlab] DSH_PROFILE = $DSH_PROFILE"
echo "[petlab] port        = $DSH_PORT"
echo
echo "Copy the 'dsh web: http://127.0.0.1:$DSH_PORT/?token=...' line into your browser."
echo "Ctrl-C to stop."
echo

DSH_HOME="$DSH_HOME" "$DSH_BIN" --profile "$DSH_PROFILE" --no-open --port "$DSH_PORT"
