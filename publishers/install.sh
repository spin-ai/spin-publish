#!/usr/bin/env bash
# Install / uninstall smart-publisher skills into the global OpenCode config.
#
# 这些技能已经内置在 VS Code 扩展里（命令面板搜索 smart-publisher），
# 这个脚本只用于「同时想在 OpenCode 里直接对话使用」的场景。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_SKILLS_DIR="${HOME}/.config/opencode/skills"
SKILLS=(zhihu-publisher toutiao-publisher humanize-writing)

remove=0
if [[ "${1:-}" == "--remove" ]]; then
  remove=1
fi

if [[ $remove -eq 1 ]]; then
  for skill in "${SKILLS[@]}"; do
    target="${GLOBAL_SKILLS_DIR}/${skill}"
    if [[ -L "$target" ]]; then
      rm "$target"
      echo "Removed ${target}"
    else
      echo "Skip (not a symlink): ${target}"
    fi
  done
  exit 0
fi

mkdir -p "${GLOBAL_SKILLS_DIR}"
for skill in "${SKILLS[@]}"; do
  source="${REPO_DIR}/${skill}"
  target="${GLOBAL_SKILLS_DIR}/${skill}"
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "Refusing to overwrite non-symlink: ${target}" >&2
    exit 1
  fi
  ln -sfn "${source}" "${target}"
  echo "Installed ${skill} -> ${target}"
done

echo "Done. Restart OpenCode to pick up the skills."
