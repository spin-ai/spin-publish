#!/usr/bin/env bash
# Run the Markdown-processing unit tests with each skill's virtualenv.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for skill in zhihu-publisher toutiao-publisher; do
  skill_dir="${REPO_DIR}/${skill}"
  if [[ ! -x "${skill_dir}/.venv/bin/python" ]]; then
    echo "Preparing ${skill} environment..."
    python3 "${skill_dir}/scripts/setup_environment.py"
  fi
done

echo "== zhihu_markdown tests =="
"${REPO_DIR}/toutiao-publisher/.venv/bin/python" \
  -m unittest discover -s "${REPO_DIR}/tests" -p "test_zhihu_markdown.py" -v

echo "== md2html tests =="
"${REPO_DIR}/toutiao-publisher/.venv/bin/python" \
  -m unittest discover -s "${REPO_DIR}/tests" -p "test_md2html.py" -v

echo "== humanize detector tests =="
python3 -m unittest discover -s "${REPO_DIR}/tests" -p "test_detector.py" -v

echo "All tests passed."
