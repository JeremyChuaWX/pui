#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
target_dir=${XDG_BIN_HOME:-"$HOME/.local/bin"}
mkdir -p "$target_dir"
ln -sfn "$project_dir/bin/pui" "$target_dir/pui"
printf 'linked %s -> %s\n' "$target_dir/pui" "$project_dir/bin/pui"
