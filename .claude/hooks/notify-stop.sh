#!/bin/sh
# Fires when Claude Code stops responding (see .claude/settings.json, Stop hook).
#
# Only local desktop notifiers are attempted here. A cloud/remote session has
# no display for osascript/notify-send to reach, and this project's network
# egress policy blocks third-party push services (verified: ntfy.sh gets a
# 403 policy denial) — so this script can't reach the user there. Remote
# sessions instead rely on Claude calling the PushNotification tool itself;
# see the note in CLAUDE.md.
#
# The systemMessage line below is the one thing that works everywhere: it's
# read directly by the Claude Code UI, not delivered over the network.

msg="Claude Code finished responding - promanage-nz"

if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"$msg\" with title \"Claude Code\" sound name \"Glass\"" >/dev/null 2>&1
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "Claude Code" "$msg" >/dev/null 2>&1
elif command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; \$n=New-Object System.Windows.Forms.NotifyIcon; \$n.Icon=[System.Drawing.SystemIcons]::Information; \$n.Visible=\$true; \$n.ShowBalloonTip(5000,'Claude Code','$msg','Info')" >/dev/null 2>&1
fi

printf '{"systemMessage": "%s"}\n' "$msg"
exit 0
