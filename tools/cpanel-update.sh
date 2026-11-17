#!/bin/bash
# Updates the sidecar from GitHub on a cPanel host, restarts the Node.js app (Passenger), checks that the NEW version
# answers, and goes back to the previous commit when it does not (0.9.0, P9).
#
# Cron (every 5 minutes), the application being a clone of the repository:
#   */5 * * * * /bin/bash <app>/tools/cpanel-update.sh https://sidecar.example.org >/dev/null 2>&1
# The script writes its own log: ~/logs/pronoteio-sidecar-update.log (PRONOTEIO_UPDATE_LOG), one line per update with
# the old and new commits and the result, and keeps the result of the last run in var/update-result.json (read by
# POST/GET /admin/update). When there is nothing to update, it only calls /health/public: this keeps the Passenger
# process alive (P5: no stop when idle, the queue and the session live in its memory).
#
# Argument (or PRONOTEIO_PUBLIC_URL): public URL of the sidecar, for the health checks. Without it nothing is checked
# and no rollback is possible.
# Settings for tests and special hosts: PRONOTEIO_UPDATE_BRANCH (main), PRONOTEIO_UPDATE_WAIT (seconds to wait for the
# new version, 90), PRONOTEIO_UPDATE_LOCK (~/tmp/pronoteio-sidecar-update.lock), GIT, NPM, CURL (commands).
# The whole script is a function called on the last line: bash reads it entirely before running, so the merge below
# can safely replace this file.

main() {
  set -u
  export PATH="/usr/local/cpanel/3rdparty/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

  local app health branch wait_s log_file lock_file result_file
  app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  health="${1:-${PRONOTEIO_PUBLIC_URL:-}}"
  health="${health%/}"
  branch="${PRONOTEIO_UPDATE_BRANCH:-main}"
  wait_s="${PRONOTEIO_UPDATE_WAIT:-90}"
  log_file="${PRONOTEIO_UPDATE_LOG:-$HOME/logs/pronoteio-sidecar-update.log}"
  lock_file="${PRONOTEIO_UPDATE_LOCK:-$HOME/tmp/pronoteio-sidecar-update.lock}"
  result_file="$app/var/update-result.json"
  local git_cmd="${GIT:-git}" npm_cmd="${NPM:-npm}" curl_cmd="${CURL:-curl}"
  mkdir -p "$(dirname "$log_file")" "$(dirname "$lock_file")" "$app/var" "$app/tmp"
  cd "$app" || return 1

  log() { echo "$(date '+%F %T') $*" | tee -a "$log_file"; }

  # One update at a time (cron and POST /admin/update): flock when available, else an atomic directory.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock_file"
    if ! flock -n 9; then
      log "update already running: skipped"
      return 75
    fi
  else
    if ! mkdir "$lock_file.d" 2>/dev/null; then
      log "update already running: skipped"
      return 75
    fi
    trap 'rmdir "$lock_file.d" 2>/dev/null' RETURN
  fi

  # Version and commit answered by /health/public ("0.9.0@abc1234", "" when it does not answer).
  answered_version() {
    [ -z "$health" ] && return 0
    local body version commit
    body="$("$curl_cmd" -fsS --max-time 15 "$health/health/public" 2>/dev/null)" || return 0
    version="$(echo "$body" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')"
    commit="$(echo "$body" | sed -n 's/.*"commit" *: *"\([^"]*\)".*/\1/p')"
    [ -n "$version" ] && echo "${version}@${commit}"
  }

  # Waits until /health/public answers the given version and commit (Passenger restarts lazily: the first call
  # triggers it). The commit tells the new code from the old one even when the version did not change.
  wait_for_version() {
    local wanted="$1" deadline seen
    deadline=$(( $(date +%s) + wait_s ))
    while :; do
      seen="$(answered_version)"
      [ "$seen" = "$wanted" ] && return 0
      if [ "$(date +%s)" -ge "$deadline" ]; then
        last_seen="$seen"
        return 1
      fi
      sleep "${PRONOTEIO_UPDATE_POLL:-3}"
    done
  }

  pkg_version() { sed -n 's/^ *"version" *: *"\([^"]*\)".*/\1/p' package.json | head -n 1; }
  expected() { echo "$(pkg_version)@$("$git_cmd" rev-parse --short=7 HEAD)"; }

  install_dependencies() {
    # cPanel keeps node_modules in ~/nodevenv/<app path>/<node version>/: take the newest version.
    local venv
    venv=$(ls -d "$HOME/nodevenv/${app#"$HOME"/}"/*/ 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$venv" ] && [ -f "${venv}bin/activate" ]; then
      # shellcheck disable=SC1091
      source "${venv}bin/activate"
    fi
    "$npm_cmd" ci --omit=dev --no-audit --no-fund >>"$log_file" 2>&1 \
      || "$npm_cmd" install --omit=dev --no-audit --no-fund >>"$log_file" 2>&1
  }

  restart() { touch tmp/restart.txt; }

  write_result() {
    printf '{"at":"%s","old":{"commit":"%s","version":"%s"},"new":{"commit":"%s","version":"%s"},"result":"%s","health":"%s"}\n' \
      "$(date -u '+%FT%TZ')" "$1" "$2" "$3" "$4" "$5" "$6" >"$result_file.tmp" && mv "$result_file.tmp" "$result_file"
  }

  local local_rev remote_rev old_version new_version changed status last_seen=""
  if ! "$git_cmd" fetch --quiet origin "$branch"; then
    log "git fetch failed"
    write_result "" "" "" "" "fetch_failed" ""
    return 1
  fi
  local_rev=$("$git_cmd" rev-parse HEAD)
  remote_rev=$("$git_cmd" rev-parse "origin/$branch")
  old_version="$(pkg_version)"
  if [ "$local_rev" = "$remote_rev" ]; then
    # Nothing to update: keep the process alive (and started after a stop) with a call of /health/public.
    [ -n "$health" ] && "$curl_cmd" -fsS --max-time 15 "$health/health/public" >/dev/null 2>&1
    if [ "${PRONOTEIO_UPDATE_RESULT_WHEN_UP_TO_DATE:-0}" = "1" ]; then
      write_result "$local_rev" "$old_version" "$local_rev" "$old_version" "up_to_date" "$(answered_version)"
    fi
    return 0
  fi

  changed=$("$git_cmd" diff --name-only "$local_rev" "$remote_rev")
  if ! "$git_cmd" merge --ff-only --quiet "origin/$branch"; then
    log "${local_rev:0:7} -> ${remote_rev:0:7} merge refused (local changes?): nothing changed"
    write_result "$local_rev" "$old_version" "$remote_rev" "" "merge_failed" ""
    return 1
  fi
  new_version="$(pkg_version)"
  if echo "$changed" | grep -qE '^package(-lock)?\.json$'; then
    install_dependencies || log "npm ci failed"
  fi
  restart

  if [ -z "$health" ]; then
    log "${local_rev:0:7} -> ${remote_rev:0:7} ($old_version -> $new_version) restarted, health not checked (no URL)"
    write_result "$local_rev" "$old_version" "$remote_rev" "$new_version" "not_checked" ""
    return 0
  fi

  if wait_for_version "$(expected)"; then
    log "${local_rev:0:7} -> ${remote_rev:0:7} ($old_version -> $new_version) ok"
    write_result "$local_rev" "$old_version" "$remote_rev" "$new_version" "ok" "$(expected)"
    return 0
  fi

  # The new version does not answer: back to the previous commit (code only: var/ and .env are not versioned).
  status="${last_seen:-no answer}"
  log "${local_rev:0:7} -> ${remote_rev:0:7} ($old_version -> $new_version) health failed ($status): rollback"
  "$git_cmd" reset --hard --quiet "$local_rev"
  if echo "$changed" | grep -qE '^package(-lock)?\.json$'; then
    install_dependencies || log "npm ci failed during rollback"
  fi
  restart
  last_seen=""
  if wait_for_version "$(expected)"; then
    log "rollback to ${local_rev:0:7} ($old_version) ok"
    write_result "$local_rev" "$old_version" "$remote_rev" "$new_version" "rolled_back" "$(expected)"
  else
    log "rollback to ${local_rev:0:7} ($old_version) FAILED (${last_seen:-no answer})"
    write_result "$local_rev" "$old_version" "$remote_rev" "$new_version" "rollback_failed" "${last_seen:-}"
  fi
  return 2
}

main "$@"
exit
