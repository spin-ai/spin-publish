---
name: zhihu-publisher
description: Publish or prepare Zhihu 专栏/知乎文章 from Markdown. Use for requests like 发布到知乎、发知乎文章、填充知乎草稿、检查知乎登录, or explicitly authorized automatic Zhihu publishing. Handles title, heading-level promotion, Draft.js document import, anchor-based inline images, cover re-upload and column selection, with a mandatory human gate before the final publish.
license: MIT
compatibility: opencode
metadata:
  platform: zhihu
  data_dir: ~/.smart-publisher/zhihu
---

# Zhihu Publisher

Use the scripts in this Skill directory. Resolve the directory containing this
`SKILL.md` first and set its absolute path as `SKILL_DIR`; do not assume the
caller's working directory is the Skill directory.

## Safety rules

- Default to `--mode manual`. Everything is filled and saved as a draft; the
  user clicks 发布 in Chrome.
- Use `--mode auto` only after the user explicitly authorizes final publishing
  (e.g. replies “确认发布到知乎”).
- Never automate login credentials, CAPTCHA or security verification. The login
  flow only opens Chrome and waits for the user to scan a QR code.
- Treat an unconfirmed publish click as failure, never as success.

## Preflight authentication

Check the stored session before asking the user to scan a QR code:

```bash
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py status --verify --json
```

If the status is `not_authenticated`, open the interactive login flow:

```bash
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py setup --json
```

The shared profile lives under `~/.smart-publisher/zhihu/` (override with
the `PUBLISHER_DATA_DIR` environment variable).

## Prepare and publish an article

Validate inputs without opening Chrome:

```bash
python3 "$SKILL_DIR/scripts/run.py" publisher.py \
  --mode validate \
  --title "文章标题" \
  --content-file "/absolute/path/article.md" \
  --json
```

The title may be omitted when the article starts with a `# 标题` line. Inline
images must be local files (relative paths resolve from the Markdown file).

Fill the draft and stop before publishing (default, recommended):

```bash
python3 "$SKILL_DIR/scripts/run.py" publisher.py \
  --mode manual \
  --content-file "/absolute/path/article.md" \
  --cover "/absolute/path/cover.png" \
  --column "目标专栏名" \
  --json
```

For explicitly authorized automatic publishing:

```bash
python3 "$SKILL_DIR/scripts/run.py" publisher.py \
  --mode auto \
  --content-file "/absolute/path/article.md" \
  --headless \
  --json
```

Automatic publishing succeeds only after the browser lands on the published
article URL (`zhuanlan.zhihu.com/p/...`). Any other outcome reports
`publish_unconfirmed`.

## What the script handles automatically

- Strips the leading `# 标题` into the Zhihu title input.
- Promotes heading levels (`##`→`#`, `###`→`##`) because Zhihu renders
  imported `#` as H2 and `##` as H3.
- Imports the image-free body via 导入 → 导入文档 (pasting never parses
  Markdown in the Draft.js editor) and verifies H2/H3/image counts.
- Re-inserts each image at its anchor paragraph through the editor's resident
  hidden file input, verifying the count after every upload.
- Re-uploads the cover in the publish panel (re-import resets it) and selects
  the requested column.
- Waits for the draft autosave indicator before the publish panel.

## Result contract

With `--json`, commands write JSON to stdout (publisher emits
newline-delimited events; manual mode emits `awaiting_manual_review` before
waiting for the user).

- Exit `0`: authenticated, input valid, manual review finished, or publish
  confirmed by article URL.
- Exit `1`: runtime, browser, import, image or publish failure.
- Exit `2`: invalid input or missing authentication.

stderr is human-readable diagnostics. Do not parse emojis or prose to decide
success; use the JSON `status` field.

## Session management

```bash
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py status --json
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py validate --json
# Destructive: require explicit user confirmation first
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py clear --yes --json
```

## Environment

Requires Python 3.9+, Google Chrome and network access. `scripts/run.py`
creates a Skill-local `.venv` on first use and installs pinned dependencies
automatically. Avoid running two browser operations against the same profile
concurrently. Enable `--debug-screenshots` only when troubleshooting.
