#!/bin/sh
# Measures wall-clock time from process spawn to the transcript's ready marker
# appearing in a tmux pane. Usage: scripts/measure-startup.sh [runs] [command...]
set -eu

runs=${1:-5}
shift 2>/dev/null || true
cmd=${*:-/Users/jer/dev/pui/dist/pui --no-session}
marker='press Ctrl+K for commands'
window=pui-bench

now() { perl -MTime::HiRes -e 'printf "%.3f\n", Time::HiRes::time()'; }

run_once() {
  start_file=$(mktemp)
  tmux kill-window -t "$window" 2>/dev/null || true
  tmux new-window -d -n "$window" -c /Users/jer/dev/pui \
    "perl -MTime::HiRes -e 'printf \"%.3f\n\", Time::HiRes::time()' > $start_file; exec $cmd"

  deadline=$(perl -e 'print time() + 30')
  while [ "$(perl -e 'print time()')" -lt "$deadline" ]; do
    if tmux capture-pane -p -t "$window" 2>/dev/null | grep -q "$marker"; then
      end=$(now)
      start=$(cat "$start_file")
      perl -e "printf \"%.0f\n\", ($end - $start) * 1000"
      tmux kill-window -t "$window" 2>/dev/null || true
      rm -f "$start_file"
      return 0
    fi
  done
  echo "TIMEOUT" >&2
  tmux capture-pane -p -t "$window" >&2 2>/dev/null || true
  tmux kill-window -t "$window" 2>/dev/null || true
  rm -f "$start_file"
  return 1
}

i=0
while [ "$i" -lt "$runs" ]; do
  run_once
  i=$((i + 1))
done
