'use strict';
/**
 * scripts/build.js — 用 esbuild 把扩展宿主打成单文件 dist/extension.js
 *
 * 策略：
 *   - 内联：本项目源码 + marked / cheerio / juice / gray-matter 等纯 JS 依赖
 *   - external：
 *       vscode      —— 由宿主提供
 *       katex       —— 运行时需要 dist CSS / 字体文件（require.resolve）
 *   - mathjax-full：通过 define(PACKAGE_VERSION) 旁路后安全内联
 *   - html2canvas：由 webview 以静态资源加载（不进 Node bundle）
 */
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const MATHJAX_VERSION = require('mathjax-full/package.json').version;

esbuild.build({
  entryPoints: [path.join(ROOT, 'extension.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(ROOT, 'dist', 'extension.js'),
  external: [
    'vscode',
    // katex 需要运行时读取 dist CSS 与字体文件（require.resolve），必须保持 external
    'katex',
    'katex/*',
  ],
  // mathjax 的 version.js 用 eval('__dirname') 去找 package.json，bundle 后会失效；
  // 定义 PACKAGE_VERSION 走它的官方旁路，即可安全内联 mathjax-full。
  define: { PACKAGE_VERSION: JSON.stringify(MATHJAX_VERSION) },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
}).then(() => {
  console.log('✅ dist/extension.js 构建完成');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
