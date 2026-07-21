#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
target_dir=${XDG_BIN_HOME:-"$HOME/.local/bin"}
mkdir -p "$target_dir"
ln -sfn "$project_dir/bin/pi-tui" "$target_dir/pi-tui"
printf 'linked %s -> %s\n' "$target_dir/pi-tui" "$project_dir/bin/pi-tui"
