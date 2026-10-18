---
name: toutiao-publisher
description: Publish or prepare articles for Toutiao/头条号 from Markdown. Use for requests like 发布到头条、发头条文章、填充头条草稿、检查头条登录, or explicitly authorized automatic Toutiao publishing. Handles title, HTML draft filling with inline images and covers via a persistent Chrome profile, and stops before the final publish unless explicitly authorized.
license: MIT
compatibility: opencode
metadata:
  platform: toutiao
  data_dir: ~/.smart-publisher/toutiao
---

# Toutiao Publisher

Use the scripts from this Skill directory. Resolve the directory containing this
`SKILL.md` first and set its absolute path as `SKILL_DIR`; do not assume the
caller's working directory is the Skill directory.

## Safety rules

- Default to `--mode manual`. Leave Chrome open for the user to review and
  click 发布.
- Use `--mode auto` only when the user explicitly authorizes final publishing
  (e.g. replies “确认发布到头条”).
- Run `clear --yes` or `reauth --yes` only after the user confirms that all
  local agents may lose the shared Toutiao session.
- Do not bypass input validation or treat an unconfirmed publish click as
  success.

## Preflight authentication

Check the protected Toutiao page before asking the user to scan a QR code:

```bash
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py status --verify --json
```

If the status is `not_authenticated`, open the interactive login flow:

```bash
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py setup --json
```

The shared profile lives under `~/.smart-publisher/toutiao/` (override with
the `PUBLISHER_DATA_DIR` environment variable).

## Prepare and publish an article

Validate inputs without opening Chrome:

```bash
python3 "$SKILL_DIR/scripts/run.py" publisher.py \
  --mode validate \
  --title "AI Trends 2026" \
  --content-file "/absolute/path/article.md" \
  --cover "/absolute/path/cover.jpg" \
  --json
```

After validation succeeds, fill the draft and wait for manual review:

```bash
python3 "$SKILL_DIR/scripts/run.py" publisher.py \
  --mode manual \
  --title "AI Trends 2026" \
  --content-file "/absolute/path/article.md" \
  --cover "/absolute/path/cover.jpg" \
  --json
```

Use direct text only through `--content-text`. `--content` remains an alias
for `--content-file`; a missing path is an error rather than literal article
text. Markdown supports headings, links, ordered and unordered lists, block
quotes, tables, fenced code, inline code, emphasis and local inline images;
relative image paths resolve from the Markdown file. If the body contains
images, skip the explicit cover upload (Toutiao picks the first inline image).
Use `--no-cover` only when the body has no image and no cover is supplied.

For explicitly authorized automatic publishing:

```bash
python3 "$SKILL_DIR/scripts/run.py" publisher.py \
  --mode auto \
  --title "AI Trends 2026" \
  --content-file "/absolute/path/article.md" \
  --headless \
  --json
```

Automatic publishing succeeds only after Toutiao displays a recognized success
indicator (“发布成功” / “主页查看”). A final-button click without confirmation
returns `publish_unconfirmed`.

## Result contract

With `--json`, authentication commands write one JSON result to stdout.
Publisher commands write newline-delimited JSON events; manual mode emits
`awaiting_manual_review` before waiting for the user.

- Exit `0`: authenticated, input valid, manual review completed, or publish
  confirmed.
- Exit `1`: runtime, browser interaction, draft, upload, or publish failure.
- Exit `2`: invalid input, missing authentication, or clear confirmation
  required.

Treat stderr as human-readable diagnostics. Do not parse emojis or prose to
determine success.

## Session management

```bash
# Read local state only
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py status --json

# Verify against Toutiao and refresh state
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py validate --json

# Destructive: require explicit user confirmation first
python3 "$SKILL_DIR/scripts/run.py" auth_manager.py clear --yes --json
```

## Environment

Requires Python 3.9+, Google Chrome and local network access.
`scripts/run.py` bootstraps `scripts/setup_environment.py` and executes the
target with the Skill-local `.venv` Python. The shared state directory uses
owner-only permissions. Avoid starting concurrent browser operations against
the same persistent Chrome profile. Enable `--debug-screenshots` only when
troubleshooting; screenshots are written under `output/toutiao-publisher-debug/`
by default.
