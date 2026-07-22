#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
case $(uname -s) in
  CYGWIN*|MINGW*|MSYS*)
    echo "pui: install:local is for macOS and Linux; add $project_dir/dist/pui.exe to PATH on Windows" >&2
    exit 1
    ;;
esac

executable="$project_dir/dist/pui"
target_dir=${XDG_BIN_HOME:-"$HOME/.local/bin"}

if [ ! -x "$executable" ]; then
  echo "pui: build is missing; run 'bun run build' in $project_dir" >&2
  exit 1
fi

mkdir -p "$target_dir"
ln -sfn "$executable" "$target_dir/pui"
printf 'linked %s -> %s\n' "$target_dir/pui" "$executable"
