'use strict';
/**
 * scripts/install.js — 打包并安装到本机 VS Code
 *
 * 自动定位 code CLI（PATH 或 macOS /Applications 常见路径），
 * 这样即使 `code` 没加进 PATH 也能直接 `npm run install-ext`。
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const isWin = process.platform === 'win32';

const vsce = path.join(ROOT, 'node_modules', '.bin', isWin ? 'vsce.cmd' : 'vsce');
const vsix = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);

console.log(`📦 打包 ${pkg.name}@${pkg.version} …`);
execFileSync(vsce, ['package', '--allow-missing-repository', '--out', vsix], {
  stdio: 'inherit',
  cwd: ROOT,
});

const candidates = [
  process.env.CODE_BIN,
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
  '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  'code',
  'cursor',
].filter(Boolean);

let code = null;
for (const c of candidates) {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    code = c;
    break;
  } catch (_) { /* try next */ }
}

if (!code) {
  console.error('❌ 未找到 code CLI。请先安装 VS Code，或在 VS Code 里执行：');
  console.error('   Shell Command: Install \'code\' command in PATH');
  console.error(`   VSIX 已生成：${vsix}（也可在扩展面板「Install from VSIX…」手动安装）`);
  process.exit(1);
}

console.log(`🔧 使用 CLI：${code}`);
execFileSync(code, ['--install-extension', vsix, '--force'], { stdio: 'inherit' });

console.log(`\n✅ 已安装 ${pkg.publisher}.${pkg.name}@${pkg.version}`);
console.log('   若 VS Code 正开着：Cmd+Shift+P → Reload Window 让新版本生效。');
