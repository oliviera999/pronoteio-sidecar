#!/bin/bash
# Updates the sidecar from GitHub on a cPanel host, then restarts the Node.js app (Passenger).
#
# Cron (every 15 minutes), the application being a clone of the repository:
#   /bin/bash <app>/tools/cpanel-update.sh https://sidecar.example.org >> ~/logs/pronoteio-sidecar-update.log 2>&1
#
# The optional argument is the public URL of the sidecar, used for a health check after the restart.
# The whole script is a function called on the last line: bash reads it entirely before running,
# so the "git merge" below can safely replace this file.

main() {
  set -eu
  export PATH="/usr/local/cpanel/3rdparty/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

  local app health local_rev remote_rev changed venv status
  app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  health="${1:-}"
  cd "$app"

  git fetch --quiet origin main
  local_rev=$(git rev-parse HEAD)
  remote_rev=$(git rev-parse origin/main)
  [ "$local_rev" = "$remote_rev" ] && return 0

  changed=$(git diff --name-only "$local_rev" "$remote_rev")
  git merge --ff-only --quiet origin/main

  if echo "$changed" | grep -qE '^package(-lock)?\.json$'; then
    # cPanel keeps node_modules in ~/nodevenv/<app path>/<node version>/: take the newest version.
    venv=$(ls -d "$HOME/nodevenv/${app#"$HOME"/}"/*/ 2>/dev/null | sort -V | tail -n 1)
    if [ -z "$venv" ]; then
      echo "$(date '+%F %T') Node.js environment not found for $app: run NPM Install from cPanel." >&2
      return 1
    fi
    # shellcheck disable=SC1091
    source "${venv}bin/activate"
    npm install --omit=dev --no-audit --no-fund
  fi

  mkdir -p tmp && touch tmp/restart.txt

  status="not checked"
  if [ -n "$health" ]; then
    sleep 5
    status=$(curl -fsS --max-time 30 "${health%/}/health" 2>&1 || true)
  fi
  echo "$(date '+%F %T') ${local_rev:0:7} -> ${remote_rev:0:7} health=${status}"
}

main "$@"
exit
