#!/bin/zsh
set -euo pipefail

repo_dir=${0:A:h:h}
app_name='ChatGPT - Coder'

cd "$repo_dir"

echo "Closing $app_name..."
osascript -e "tell application \"$app_name\" to quit" 2>/dev/null || true

for _ in {1..20}; do
  pgrep -x "$app_name" >/dev/null || break
  sleep 0.25
done

if pgrep -x "$app_name" >/dev/null; then
  echo "The app did not quit cleanly; stopping it now..."
  pkill -x "$app_name"
fi

echo 'Rebuilding...'
pnpm dist

app_path=$(find "$repo_dir/dist" -maxdepth 2 -type d -name "$app_name.app" -print -quit)
if [[ -z "$app_path" ]]; then
  echo "Could not find $app_name.app under $repo_dir/dist" >&2
  exit 1
fi

echo "Opening $app_path..."
open "$app_path"
