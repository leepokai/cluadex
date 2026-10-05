#!/bin/sh
# Tell this session's cluadex relay that the turn is over, so the runtime can clean up.
# The relay listens on a socket named after the Claude Code process that started it; find
# that process among our ancestors. Never blocks or fails the session.
dir="$HOME/Library/Caches/cluadex"
pid=$PPID
for _ in 1 2 3 4 5 6; do
  if [ -S "$dir/$pid.sock" ]; then
    printf '%s\n' "${1:-Stop}" | nc -U -w 1 "$dir/$pid.sock" >/dev/null 2>&1
    break
  fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$pid" ] && [ "$pid" -gt 1 ] || break
done
exit 0
