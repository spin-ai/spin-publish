'use strict';
/**
 * scripts/verify-package.js — 打包并验证「发布产物」本身
 *
 * 仅验证源码树是不够的：.vscodeignore 误删运行时资源（katex CSS/字体、
 * highlight.js 主题、html2canvas、media 等）只有在对打包后的目录跑测试时才会暴露。
 *
 * 流程：vsce package → 解压 vsix → 以解压目录为扩展根跑 test/host.test.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-verify-'));

function run(cmd, args, opts) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

const isWin = process.platform === 'win32';
const vsce = path.join(ROOT, 'node_modules', '.bin', isWin ? 'vsce.cmd' : 'vsce');
const vsix = path.join(tmp, 'smart-publisher.vsix');

console.log('📦 打包 VSIX…');
run(vsce, ['package', '--allow-missing-repository', '--out', vsix]);

console.log('🗂  解压 VSIX…');
const out = path.join(tmp, 'x');
if (isWin) {
  run('powershell', ['-Command', `Expand-Archive -Path "${vsix}" -DestinationPath "${out}" -Force`]);
} else {
  run('unzip', ['-q', '-o', vsix, '-d', out]);
}

const extRoot = path.join(out, 'extension');
if (!fs.existsSync(path.join(extRoot, 'dist', 'extension.js'))) {
  console.error('❌ 解压后的扩展缺少 dist/extension.js');
  process.exit(1);
}

console.log('🧪 对「打包后」的扩展跑宿主测试…\n');
execFileSync(process.execPath, [path.join(ROOT, 'test', 'host.test.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SP_EXT_ROOT: extRoot,
    SP_EXT_ENTRY: path.join(extRoot, 'dist', 'extension.js'),
  },
});

console.log('\n✅ 发布产物验证通过');
