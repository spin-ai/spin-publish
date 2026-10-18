'use strict';

/**
 * lib/publishers.js — 知乎 / 今日头条浏览器自动发布的宿主侧适配
 *
 * 自动化脚本来自 opencode-publisher（MIT）的 zhihu-publisher /
 * toutiao-publisher 技能，现已内置在本扩展的 publishers/ 目录：
 *
 *   publishers/zhihu-publisher/      Markdown → 知乎专栏（Draft.js 导入）
 *   publishers/toutiao-publisher/    Markdown → 头条号（ProseMirror 填充）
 *
 * 这里只负责：
 *   - 定位内置技能与 Python 解释器
 *   - 拼装可在 VS Code 终端里执行的命令（跨平台引号处理）
 *   - 发布前检查脚本/解释器是否存在
 *
 * 真正的浏览器操作全部在 Python 脚本里完成；登录态保存在
 * `~/.smart-publisher/<platform>/`（可用 PUBLISHER_DATA_DIR 覆盖）。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const PUBLISHERS = {
  zhihu: {
    id: 'zhihu',
    name: '知乎',
    dir: 'zhihu-publisher',
    script: 'publisher.py',
    supportsColumn: true,
    titleLimit: 100,
  },
  toutiao: {
    id: 'toutiao',
    name: '今日头条',
    dir: 'toutiao-publisher',
    script: 'publisher.py',
    supportsColumn: false,
    titleLimit: 30,
  },
};

function getPublisher(id) {
  return PUBLISHERS[id] || null;
}

function publishersRoot(extensionUri) {
  return path.join(extensionUri.fsPath, 'publishers');
}

function skillDir(extensionUri, platform) {
  const pub = getPublisher(platform);
  if (!pub) throw new Error('未知发布平台：' + platform);
  return path.join(publishersRoot(extensionUri), pub.dir);
}

function runPyPath(extensionUri, platform) {
  return path.join(skillDir(extensionUri, platform), 'scripts', 'run.py');
}

/** 读取用户配置的 Python；默认 macOS/Linux 用 python3，Windows 用 python */
function resolvePython(vscode) {
  const cfg = vscode.workspace.getConfiguration('smart-publisher');
  const configured = (cfg.get('publisher.pythonPath', '') || '').trim();
  if (configured) return configured.replace(/^~(?=$|[\\/])/, os.homedir());
  return process.platform === 'win32' ? 'python' : 'python3';
}

function resolveDataDir(vscode) {
  const cfg = vscode.workspace.getConfiguration('smart-publisher');
  return (cfg.get('publisher.dataDir', '') || '').trim();
}

/** 检查内置技能文件是否齐全 */
function checkSkillFiles(extensionUri, platform) {
  const pub = getPublisher(platform);
  if (!pub) return { ok: false, missing: ['unknown platform'] };
  const root = skillDir(extensionUri, platform);
  const required = [
    path.join(root, 'SKILL.md'),
    path.join(root, 'requirements.txt'),
    path.join(root, 'scripts', 'run.py'),
    path.join(root, 'scripts', pub.script),
  ];
  const missing = required.filter((f) => !fs.existsSync(f));
  return { ok: missing.length === 0, missing, root };
}

/** 检查 Python 是否可用（只跑 --version，不安装任何东西） */
function checkPython(python) {
  try {
    const res = spawnSync(python, ['--version'], { encoding: 'utf8', timeout: 8000 });
    if (res.error) return { ok: false, error: res.error.message };
    if (res.status !== 0) {
      return { ok: false, error: (res.stderr || res.stdout || '').trim() || `exit ${res.status}` };
    }
    const version = ((res.stdout || '') + (res.stderr || '')).trim().split('\n')[0];
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** POSIX shell 单引号转义 */
function quotePosix(value) {
  const s = String(value);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 单引号转义 */
function quotePowerShell(value) {
  const s = String(value);
  return `'${s.replace(/'/g, `''`)}'`;
}

function shellQuote(value, platform) {
  return (platform || process.platform) === 'win32'
    ? quotePowerShell(value)
    : quotePosix(value);
}

/** 拼一条终端命令：<python> <run.py> <script> [args...] */
function buildRunCommand({ python, runPy, script, args, platform }) {
  return [
    shellQuote(python, platform),
    shellQuote(runPy, platform),
    shellQuote(script, platform),
    ...(args || []).map((arg) => shellQuote(arg, platform)),
  ].join(' ');
}

function buildPublisherArgs(platform, options) {
  const opts = options || {};
  const args = [
    '--mode', opts.mode || 'manual',
    '--content-file', opts.contentFile,
    '--json',
  ];
  if (opts.title) args.push('--title', opts.title);
  if (opts.cover) args.push('--cover', opts.cover);
  if (opts.column && platform === 'zhihu') args.push('--column', opts.column);
  if (opts.headless && opts.mode === 'auto') args.push('--headless');
  if (platform === 'toutiao' && opts.noCover) args.push('--no-cover');
  if (platform === 'toutiao' && opts.raw) args.push('--raw');
  return args;
}

/** 命令构造：登录 / 状态 / 校验 / 填充草稿 / 自动发布 */
function buildPublisherCommand({ extensionUri, platform, python, action, options }) {
  const pub = getPublisher(platform);
  if (!pub) throw new Error('未知发布平台：' + platform);
  const runPy = runPyPath(extensionUri, platform);
  const py = python || (process.platform === 'win32' ? 'python' : 'python3');

  if (action === 'login') {
    return buildRunCommand({ python: py, runPy, script: 'auth_manager.py', args: ['setup', '--json'], platform: process.platform });
  }
  if (action === 'status') {
    return buildRunCommand({ python: py, runPy, script: 'auth_manager.py', args: ['status', '--verify', '--json'], platform: process.platform });
  }

  const opts = { ...(options || {}) };
  if (action === 'validate') opts.mode = 'validate';
  if (action === 'auto') opts.mode = 'auto';
  if (action === 'manual') opts.mode = 'manual';

  if (!opts.contentFile) throw new Error('缺少要发布的 Markdown 文件');
  const args = buildPublisherArgs(platform, opts);
  return buildRunCommand({ python: py, runPy, script: pub.script, args, platform: process.platform });
}

function terminalEnv(vscode, baseEnv) {
  const dir = resolveDataDir(vscode);
  if (!dir) return baseEnv || process.env;
  const expanded = dir.replace(/^~(?=$|[\\/])/, os.homedir());
  return { ...(baseEnv || process.env), PUBLISHER_DATA_DIR: expanded };
}

module.exports = {
  PUBLISHERS,
  getPublisher,
  publishersRoot,
  skillDir,
  runPyPath,
  resolvePython,
  resolveDataDir,
  checkSkillFiles,
  checkPython,
  shellQuote,
  buildRunCommand,
  buildPublisherArgs,
  buildPublisherCommand,
  terminalEnv,
};
