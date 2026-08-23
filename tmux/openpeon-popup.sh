#!/bin/bash
# openpeon-popup: popup to control OpenPeon volume and preset for the
# Claude Code session running in the current window, from tmux or Herdr.
# In tmux, bind a key to `popup`:
#
#   bind-key -n C-n run-shell -b "$HOME/.claude/openpeon/tmux/openpeon-popup.sh popup '#{client_name}' '#{pane_id}'"
#
# In Herdr, static popup sizes cannot fit a preset list that varies, so the
# integration is a plugin (herdr/ in the repo): its action resolves and sizes
# the popup like run_popup does for tmux, then opens the plugin pane
# entrypoint. Link it once per machine and bind the action:
#
#   herdr plugin link <repo>/herdr
#
#   [[keys.command]]
#   key = "ctrl+n"
#   type = "plugin_action"
#   command = "openpeon.popup"
#
# Subcommands:
#   popup [client] [pane]  resolve the window's session, size and open the TUI
#   popup-herdr            the plugin action: resolve via the herdr CLI, size
#                          the popup to its content, open the pane entrypoint
#   popup-herdr-pane       the popup body: run the TUI (or the error message)
#                          passed through OPENPEON_POPUP_SID/_MSG
#   tui <session-id>       the interactive popup body (volume bar + presets)
#   resolve <pane-id>      print the resolution for a pane (ok/err, tab-sep)
#   resolve-herdr          same, for the pane under Herdr's focused agent
#   resolve-cwd <cwd>      pure file-based resolution half, used by tests
#   msg <w> <text...>      print a message wrapped at w columns, wait for a key
#
# Session resolution. tmux: the window's active pane -> its tty -> the claude
# process on it (ps -t) -> its cwd (lsof). Herdr: the focused agent's kind and
# cwd from `herdr agent list`. Both halves end in resolve_cwd:
# ~/.claude/projects/<cwd-slug>/ transcript ids intersected with live state
# files under $ROOT/state/. With several live sessions from the same
# directory, the newest transcript wins.
#
# Volume changes persist to the session state file AND the base openpeon.json
# (so new sessions inherit them until the next deploy); preset and whisper
# changes are session-scoped only, so randomPreset keeps rolling fresh
# sessions and whisper resets to on. Every change plays a feedback sound so
# you hear what you set. Requires jq.
#
# OpenCode sessions cannot be controlled from outside (the plugin holds its
# config in memory); the popup explains that instead.

set -u

ROOT="${OPENPEON_ROOT:-$HOME/.claude/openpeon}"
PROJECTS_DIR="${OPENPEON_PROJECTS_DIR:-$HOME/.claude/projects}"
# afplay on macOS, pw-play (PipeWire) on Linux; previews stay silent elsewhere.
if [[ "$(uname)" == "Darwin" ]]; then
  PLAYER="/usr/bin/afplay" VOL_FLAG="-v"
else
  PLAYER="/usr/bin/pw-play" VOL_FLAG="--volume"
fi
TAB=$'\t'

CMD="${1:-}"

self_path() {
  case "$0" in
    /*) printf '%s' "$0" ;;
    *) printf '%s/%s' "$(pwd)" "$0" ;;
  esac
}

# GNU stat spells mtime -c %Y, BSD stat -f %m.
mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# ------------------------------------------------------------ resolution

# Pure file-based half: cwd -> project slug -> transcript ids ∩ live state.
# Prints "ok<TAB>session-id<TAB>candidate-count" or "err<TAB>message".
resolve_cwd() {
  local cwd="$1" slug dir sfile id m count best_id best_m
  slug=$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9-]/-/g')
  dir="$PROJECTS_DIR/$slug"
  count=0; best_id=""; best_m=0
  for sfile in "$ROOT/state/"*.json; do
    [[ -e "$sfile" ]] || continue
    id=$(basename "$sfile" .json)
    [[ -f "$dir/$id.jsonl" ]] || continue
    m=$(mtime "$dir/$id.jsonl") || m=0
    count=$((count + 1))
    if [[ "$m" -gt "$best_m" ]]; then
      best_m="$m"
      best_id="$id"
    fi
  done
  if [[ "$count" -eq 0 ]]; then
    printf 'err%scould not match this window to a live session\n' "$TAB"
  else
    printf 'ok%s%s%s%s\n' "$TAB" "$best_id" "$TAB" "$count"
  fi
}

resolve_pane() {
  local pane="$1" cmd tty pid cwd
  cmd=$(tmux display-message -p -t "$pane" '#{pane_current_command}' 2>/dev/null) || cmd=""
  case "$cmd" in
    opencode*)
      printf 'err%sOpenCode holds its sound config in memory: ask in chat (peon_set_volume, peon_switch_preset)\n' "$TAB"
      return 0
      ;;
    claude*) ;;
    *)
      printf 'err%sno Claude Code session in this window\n' "$TAB"
      return 0
      ;;
  esac
  tty=$(tmux display-message -p -t "$pane" '#{pane_tty}')
  pid=$(ps -t "${tty#/dev/}" -o pid=,comm= 2>/dev/null |
    awk 'tolower($0) ~ /claude/ && $0 !~ /defunct/ {print $1; exit}')
  if [[ -z "$pid" ]]; then
    printf 'err%scould not find the claude process in this window\n' "$TAB"
    return 0
  fi
  # Linux: /proc has it directly. macOS: lsof, whose -F n prints the path on
  # its own "n"-prefixed line (awk $NF breaks on spaces).
  if [[ -e "/proc/$pid/cwd" ]]; then
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
  else
    cwd=$(lsof -a -d cwd -p "$pid" -F n 2>/dev/null | sed -n 's/^n//p' | head -1)
  fi
  if [[ -z "$cwd" ]]; then
    printf 'err%scould not read the claude process working directory\n' "$TAB"
    return 0
  fi
  resolve_cwd "$cwd"
}

# Herdr half: the focused agent's kind and cwd from `herdr agent list`.
# Herdr popups overlay the panes without taking pane focus, so the agent
# focused when the popup key was pressed is still the focused one here.
resolve_herdr() {
  local agent kind cwd
  command -v herdr >/dev/null 2>&1 || {
    printf 'err%sherdr CLI not found\n' "$TAB"
    return 0
  }
  agent=$(herdr agent list 2>/dev/null |
    jq -c '[.result.agents[] | select(.focused)] | first // empty' 2>/dev/null)
  if [[ -z "$agent" ]]; then
    printf 'err%sno Claude Code session in the focused pane\n' "$TAB"
    return 0
  fi
  kind=$(printf '%s' "$agent" | jq -r '.agent // empty')
  case "$kind" in
    opencode)
      printf 'err%sOpenCode holds its sound config in memory: ask in chat (peon_set_volume, peon_switch_preset)\n' "$TAB"
      return 0
      ;;
    claude) ;;
    *)
      printf 'err%sno Claude Code session in the focused pane\n' "$TAB"
      return 0
      ;;
  esac
  cwd=$(printf '%s' "$agent" | jq -r '.foreground_cwd // .cwd // empty')
  if [[ -z "$cwd" ]]; then
    printf 'err%scould not read the claude pane working directory\n' "$TAB"
    return 0
  fi
  resolve_cwd "$cwd"
}

# ------------------------------------------------------------------- tui

# Effective volume for the session: state > preset > base config > 5.
effective_volume() { # effective_volume <state-file> <preset-name-or-empty>
  local v
  v=$(jq -r '.volume // empty' "$1" 2>/dev/null)
  if [[ -z "$v" && -n "$2" ]]; then
    v=$(jq -r '.volume // empty' "$ROOT/presets/$2.json" 2>/dev/null)
  fi
  if [[ -z "$v" ]]; then
    v=$(jq -r '.volume // empty' "$ROOT/openpeon.json" 2>/dev/null)
  fi
  [[ "$v" =~ ^[0-9]+$ ]] || v=5
  (( v > 10 )) && v=10
  printf '%s' "$v"
}

# Merge a key into the session state file without clobbering other keys.
write_state() { # write_state <state-file> <jq-program>
  local tmp="$1.tmp"
  if [[ -f "$1" ]]; then
    jq "$2" "$1" > "$tmp" 2>/dev/null && mv "$tmp" "$1"
  else
    printf '{}' | jq "$2" > "$tmp" 2>/dev/null && mv "$tmp" "$1"
  fi
}

# Play a short sample at the current settings so the change is audible.
# Uses the first mapping's sounds from the active preset (or base config),
# or the sounds selected by the optional jq filter argument.
FEEDBACK_PID=""
play_feedback() { # play_feedback <preset-or-empty> <volume> [jq-sounds-filter]
  local src sounds n sound afv
  (( $2 > 0 )) || return 0
  if [[ -n "$1" ]]; then src="$ROOT/presets/$1.json"; else src="$ROOT/openpeon.json"; fi
  sounds=$(jq -r "${3:-.mappings[0].sounds[]}" "$src" 2>/dev/null)
  [[ -n "$sounds" ]] || return 0
  n=$(printf '%s\n' "$sounds" | grep -c .)
  sound=$(printf '%s\n' "$sounds" | sed -n "$(( (RANDOM % n) + 1 ))p")
  [[ -f "$ROOT/sounds/$sound" && -x "$PLAYER" ]] || return 0
  # Same perceptual curve as lib/core.js computeAfplayVolume
  afv=$(awk -v v="$2" 'BEGIN{printf "%.3f", (v/10)^2}')
  if [[ -n "$FEEDBACK_PID" ]]; then kill "$FEEDBACK_PID" 2>/dev/null; fi
  "$PLAYER" "$VOL_FLAG" "$afv" "$ROOT/sounds/$sound" >/dev/null 2>&1 &
  FEEDBACK_PID=$!
}

draw_tui() { # uses caller's locals (dynamic scoping)
  local i bar n row last
  # Popups are sized to the list, but a small terminal clamps them (tmux and
  # herdr both); then the list scrolls: keep the selection inside the LIST_H
  # rows that fit between the fixed lines.
  (( SEL < TOP )) && TOP=$SEL
  (( SEL >= TOP + LIST_H )) && TOP=$((SEL - LIST_H + 1))
  last=$((TOP + LIST_H - 1))
  (( last >= ${#ROWS[@]} )) && last=$(( ${#ROWS[@]} - 1 ))
  printf '\033[H\033[2J'
  bar=""
  # ${bar} braces are required: bash 3.2 would otherwise parse "$bar▓" as a
  # variable named bar▓ under a UTF-8 locale.
  for (( i = 1; i <= 10; i++ )); do
    if (( i <= VOL )); then bar="${bar}▓"; else bar="${bar}░"; fi
  done
  printf ' volume  %s %s\n' "$bar" "$VOL"
  printf ' whisper %s\n' "$WHIS"
  for (( i = TOP; i <= last; i++ )); do
    row="${ROWS[i]}"
    n=""
    [[ "$row" == "$CUR" ]] && n=" ●"
    if (( i == SEL )); then
      printf ' \033[7m%s%s\033[0m\n' "${row:-(base config)}" "$n"
    else
      printf ' %s%s\n' "${row:-(base config)}" "$n"
    fi
  done
  printf '\033[2m ⏎ preset  ←/→ vol  m mute  w whisper  q quit\033[0m'
}

# Sounds of whispered mappings, for whisper-toggle feedback.
WHISPER_SOUNDS_FILTER='[.mappings[]? | select(.whisper == true) | .sounds[]] | .[]'

run_tui() {
  local SID="$1" STATE CUR VOL WHIS SEL ROWS TOP LIST_H
  local k k2 k3 i p fbv
  STATE="$ROOT/state/$SID.json"
  command -v jq >/dev/null 2>&1 || { printf ' jq is required'; IFS= read -rsn1 k; exit 0; }

  TOP=0
  LIST_H=$(tput lines 2>/dev/null)
  [[ "$LIST_H" =~ ^[0-9]+$ ]] || LIST_H="${LINES:-24}"
  # The volume, whisper, and help lines are always drawn.
  LIST_H=$((LIST_H - 3))
  (( LIST_H < 1 )) && LIST_H=1

  # Row 0 is "apply the base config" (preset null); the rest are preset names.
  ROWS=("")
  for p in "$ROOT/presets/"*.json; do
    [[ -e "$p" ]] || continue
    ROWS+=("$(basename "$p" .json)")
  done

  CUR=$(jq -r '.preset // empty' "$STATE" 2>/dev/null)
  VOL=$(effective_volume "$STATE" "$CUR")
  WHIS=on
  [[ "$(jq -r '.whisper' "$STATE" 2>/dev/null)" == "false" ]] && WHIS=off
  SEL=0
  for (( i = 0; i < ${#ROWS[@]}; i++ )); do
    [[ -n "$CUR" && "${ROWS[i]}" == "$CUR" ]] && SEL=$i
  done

  printf '\033[?25l'
  trap 'printf "\033[?25h"' EXIT
  draw_tui
  while :; do
    IFS= read -rsn1 k || break
    case "$k" in
      $'\e')
        k2=""
        IFS= read -rsn1 -t 1 k2 || exit 0
        [[ "$k2" == "[" || "$k2" == "O" ]] || continue
        IFS= read -rsn1 k3 || continue
        case "$k3" in
          A) (( SEL > 0 )) && SEL=$((SEL - 1)); draw_tui ;;
          B) (( SEL < ${#ROWS[@]} - 1 )) && SEL=$((SEL + 1)); draw_tui ;;
          D) k="h" ;;  # left arrow falls through to volume down
          C) k="l" ;;  # right arrow falls through to volume up
        esac
        ;;
    esac
    case "$k" in
      k) (( SEL > 0 )) && SEL=$((SEL - 1)); draw_tui ;;
      j) (( SEL < ${#ROWS[@]} - 1 )) && SEL=$((SEL + 1)); draw_tui ;;
      h|-) (( VOL > 0 )) && VOL=$((VOL - 1))
        write_state "$STATE" ".volume = $VOL"
        write_state "$ROOT/openpeon.json" ".volume = $VOL"
        draw_tui; play_feedback "$CUR" "$VOL" ;;
      l|+|=) (( VOL < 10 )) && VOL=$((VOL + 1))
        write_state "$STATE" ".volume = $VOL"
        write_state "$ROOT/openpeon.json" ".volume = $VOL"
        draw_tui; play_feedback "$CUR" "$VOL" ;;
      m) VOL=0
        write_state "$STATE" ".volume = 0"
        write_state "$ROOT/openpeon.json" ".volume = 0"
        draw_tui ;;
      w) # Session-only: whispered mappings play quietly (on) or at full volume (off)
        if [[ "$WHIS" == "on" ]]; then WHIS=off; else WHIS=on; fi
        write_state "$STATE" ".whisper = $([[ "$WHIS" == "on" ]] && printf true || printf false)"
        # Feedback with a whispered-mapping sound at its new effective volume
        # (1 = WHISPER_VOLUME in lib/core.js)
        fbv=$VOL; [[ "$WHIS" == "on" ]] && fbv=1
        draw_tui; play_feedback "$CUR" "$fbv" "$WHISPER_SOUNDS_FILTER" ;;
      "") # Enter: apply the selected preset (row 0 = back to base config)
        CUR="${ROWS[SEL]}"
        if [[ -n "$CUR" ]]; then
          write_state "$STATE" ".preset = \"$CUR\""
        else
          write_state "$STATE" ".preset = null"
        fi
        # Without a session volume override, the preset's own volume now
        # applies; refresh the bar so it shows what will actually play.
        if [[ -z "$(jq -r '.volume // empty' "$STATE" 2>/dev/null)" ]]; then
          VOL=$(effective_volume "$STATE" "$CUR")
        fi
        draw_tui; play_feedback "$CUR" "$VOL" ;;
      q) exit 0 ;;
    esac
  done
}

# ----------------------------------------------------------------- popup

show_msg() { # show_msg <width> <text>
  local out k
  # No trailing newline: with exactly enough rows it would scroll line 1 away.
  out=$(printf '%s\n' "$2" | fold -s -w "$1" | sed 's/^/ /')
  printf '%s' "$out"
  IFS= read -rsn1 k
}

run_popup() {
  local client="${2:-}" pane="${3:-}" res status rest sid n w h self
  command -v tmux >/dev/null 2>&1 || exit 0
  self=$(self_path)
  res=$(resolve_pane "$pane")
  status="${res%%$TAB*}"
  rest="${res#*$TAB}"
  if [[ "$status" != "ok" ]]; then
    w=$(( ${#rest} + 4 )); (( w > 78 )) && w=78
    # msg word-wraps at w-4 columns; size the height to the folded line count
    h=$(( $(printf '%s\n' "$rest" | fold -s -w $((w - 4)) | wc -l) + 2 ))
    exec tmux display-popup ${client:+-c "$client"} -x R -y 0 -w "$w" -h "$h" \
      -T ' openpeon ' -E "$(printf '%q msg %q %q' "$self" "$((w - 4))" "$rest")"
  fi
  sid="${rest%%$TAB*}"
  n=0
  for p in "$ROOT/presets/"*.json; do
    [[ -e "$p" ]] && n=$((n + 1))
  done
  h=$((n + 6))   # volume + whisper + base row + n presets + help + border
  w=48
  exec tmux display-popup ${client:+-c "$client"} -x R -y 0 -w "$w" -h "$h" \
    -T ' openpeon ' -E "$(printf '%q tui %q' "$self" "$sid")"
}

# The plugin action: mirror run_popup for Herdr. Resolve outside the popup,
# size the popup to its content, then open the plugin pane entrypoint with
# the result passed through the environment (popup sizes in config.toml are
# static, only a plugin can size a popup at open time).
run_popup_herdr() {
  local res status rest sid n w h p
  res=$(resolve_herdr)
  status="${res%%$TAB*}"
  rest="${res#*$TAB}"
  if [[ "$status" != "ok" ]]; then
    w=$(( ${#rest} + 4 )); (( w > 78 )) && w=78
    h=$(( $(printf '%s\n' "$rest" | fold -s -w $((w - 4)) | wc -l) + 2 ))
    exec herdr plugin pane open --plugin openpeon --entrypoint popup \
      --placement popup --width "$w" --height "$h" --focus \
      --env "OPENPEON_POPUP_MSG=$rest"
  fi
  sid="${rest%%$TAB*}"
  n=0
  for p in "$ROOT/presets/"*.json; do
    [[ -e "$p" ]] && n=$((n + 1))
  done
  h=$((n + 6))   # volume + whisper + base row + n presets + help + border
  exec herdr plugin pane open --plugin openpeon --entrypoint popup \
    --placement popup --width 48 --height "$h" --focus \
    --env "OPENPEON_POPUP_SID=$sid"
}

# The popup body Herdr opens for run_popup_herdr's pane entrypoint.
run_popup_herdr_pane() {
  local cols
  if [[ -n "${OPENPEON_POPUP_MSG:-}" ]]; then
    cols=$(tput cols 2>/dev/null)
    [[ "$cols" =~ ^[0-9]+$ ]] || cols="${COLUMNS:-48}"
    show_msg $((cols - 2)) "$OPENPEON_POPUP_MSG"
    exit 0
  fi
  if [[ -z "${OPENPEON_POPUP_SID:-}" ]]; then
    show_msg 44 "missing OPENPEON_POPUP_SID: open this through the openpeon.popup plugin action"
    exit 0
  fi
  run_tui "$OPENPEON_POPUP_SID"
}

case "$CMD" in
  resolve) resolve_pane "${2:-}" ;;
  resolve-herdr) resolve_herdr ;;
  resolve-cwd) resolve_cwd "${2:-}" ;;
  popup) run_popup "$@" ;;
  popup-herdr) run_popup_herdr ;;
  popup-herdr-pane) run_popup_herdr_pane ;;
  tui) run_tui "${2:-}" ;;
  msg) shift; fw="${1:-74}"; shift; show_msg "$fw" "$*" ;;
  *) exit 0 ;;
esac
