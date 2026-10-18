'use strict';
/**
 * 扩展宿主逻辑测试（用 mock vscode 驱动 extension.js）：
 *   node test/host.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const Module = require('module');

const ROOT = process.env.SP_EXT_ROOT
  ? path.resolve(process.env.SP_EXT_ROOT)
  : path.join(__dirname, '..');

// ── 测试用 Markdown ──
const mdPath = path.join(os.tmpdir(), 'sp-host-test.md');
fs.writeFileSync(mdPath, '---\ntitle: FM 标题\n---\n\n# 标题\n\n公式 $E=mc^2$\n\n$$\nL = -\\frac{1}{N}\\sum y_i\n$$\n\n```js\nconst a = 1;\n```\n', 'utf8');

// ── mock vscode ──
const posted = [];
let messageHandler = null;
let panelHtml = '';
let panelDispose = null;
const secrets = new Map();
const gState = new Map();

const vscode = {
  ViewColumn: { Beside: 2 },
  ConfigurationTarget: { Global: 1 },
  RelativePattern: class { constructor(base, pat) { this.base = base; this.pattern = pat; } },
  Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ fsPath: s }) },
  commands: {
    _cmds: {},
    registerCommand(n, cb) { this._cmds[n] = cb; return { dispose() {} }; },
    executeCommand() {},
  },
  workspace: {
    textDocuments: [],
    workspaceFolders: [{ uri: { fsPath: ROOT } }],
    getConfiguration() {
      const s = new Map();
      return { get: (k, d) => (s.has(k) ? s.get(k) : d), update: async () => {} };
    },
    onDidChangeTextDocument() { return { dispose() {} }; },
    createFileSystemWatcher() { return { onDidChange() {}, dispose() {} }; },
  },
  window: {
    activeTextEditor: undefined,
    onDidChangeTextEditorSelection() { return { dispose() {} }; },
    createWebviewPanel() {
      const panel = {
        title: '', visible: true,
        webview: {
          cspSource: 'https://test.vscode-cdn.net',
          asWebviewUri: (u) => ({ toString: () => 'https://test.vscode-cdn.net/' + encodeURIComponent(u.fsPath) }),
          onDidReceiveMessage(h) { messageHandler = h; return { dispose() {} }; },
          postMessage(m) { posted.push(m); return Promise.resolve(true); },
        },
        reveal() {},
        onDidDispose(cb) { panelDispose = cb; return { dispose() {} }; },
        dispose() { if (panelDispose) panelDispose(); },
      };
      Object.defineProperty(panel.webview, 'html', { get: () => panelHtml, set: (v) => { panelHtml = v; } });
      return panel;
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  env: { openExternal() {} },
};

const context = {
  subscriptions: [],
  extensionUri: { fsPath: ROOT },
  globalState: {
    get: (k, d) => (gState.has(k) ? gState.get(k) : d),
    update: async (k, v) => { gState.set(k, v); },
  },
  secrets: {
    get: async (k) => secrets.get(k) || '',
    store: async (k, v) => { secrets.set(k, v); },
    delete: async (k) => { secrets.delete(k); },
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscode;
  return origLoad.apply(this, arguments);
};

const ext = require(process.env.SP_EXT_ENTRY ? path.resolve(ROOT, process.env.SP_EXT_ENTRY) : path.join(ROOT, 'extension.js'));
ext.activate(context);

const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const last = (t) => [...posted].reverse().find((m) => m.type === t);

(async () => {
  assert.ok(vscode.commands._cmds['smart-publisher.preview'], 'preview 命令未注册');
  assert.ok(vscode.commands._cmds['smart-publisher.exportHtml'], 'exportHtml 命令未注册');

  vscode.commands._cmds['smart-publisher.preview']({ fsPath: mdPath });
  assert.ok(messageHandler, 'webview 消息处理器未注册');
  for (const ph of ['__NONCE__', '__CSP_SOURCE__', '__KATEX_URI__', '__HTML2CANVAS_URI__', '__PANEL_JS_URI__', '__ICON_URI__']) {
    assert.ok(!panelHtml.includes(ph), `占位符 ${ph} 未替换`);
  }
  // 运行时静态资源必须真实存在（验证 .vscodeignore 没有误删）
  for (const rel of [
    'media/panel.html', 'media/panel.css', 'media/panel.js',
    'media/icon.png', 'media/icon.svg',
    'templates/wechat.html',
    'node_modules/katex/dist/katex.min.css',
    'node_modules/katex/dist/katex.js',
    'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',
    'node_modules/highlight.js/styles/github.css',
    'node_modules/highlight.js/styles/github.min.css',
    'node_modules/html2canvas/dist/html2canvas.min.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺少运行时资源: ${rel}`);
  }
  console.log('✓ 面板 HTML 占位符全部替换 + 运行时资源齐备');

  await messageHandler({ type: 'ready' }); await wait();
  assert.strictEqual(last('themeList').themes.length, 14, '主题列表数量不对');
  assert.strictEqual(last('render').title, 'FM 标题', 'front matter 标题解析失败');
  assert.ok(last('render').bodyHtml.includes('katex'), 'render 未包含公式');
  assert.ok(last('llmConfig'), '未见 llmConfig');
  console.log('✓ ready → themeList / llmConfig / render');

  await messageHandler({ type: 'getWechatHtml' }); await wait();
  assert.ok(last('wechatHtml').html.includes('mdnice'), '微信公式未转 SVG');
  assert.ok(last('wechatHtml').html.includes('inline-equation'), '微信行内公式未转换');
  await messageHandler({ type: 'getZhihuHtml' }); await wait();
  assert.ok(last('zhihuHtml').html.includes('eeimg'), '知乎公式标记缺失');
  console.log('✓ 微信 / 知乎 复制 HTML');

  await messageHandler({ type: 'getXhsCapture', mode: 'adaptive', fontSize: 40 }); await wait();
  assert.strictEqual(last('xhsCapture').containerClass, 'xhs-capture', 'adaptive 容器类错误');
  console.log('✓ getXhsCapture(adaptive)');

  await messageHandler({ type: 'getPptInstruction', backend: 'slidev' }); await wait();
  assert.ok(last('pptInstruction').instruction.includes('Slidev'), 'Slidev prompt 缺失');
  await messageHandler({ type: 'getPptInstruction', backend: 'marp' }); await wait();
  assert.ok(last('pptInstruction').instruction.includes('Marp'), 'Marp prompt 缺失');
  console.log('✓ getPptInstruction(slidev / marp)');

  const pptBody = '# 封面\n\n---\n\n# 第二页\n\n- 要点 A\n- 要点 B';
  await messageHandler({ type: 'savePpt', backend: 'slidev', markdown: pptBody }); await wait();
  const slidesPath = path.join(os.tmpdir(), 'sp-host-test-slides.md');
  assert.ok(fs.existsSync(slidesPath), 'Slidev 文件未生成');
  const slides = fs.readFileSync(slidesPath, 'utf8');
  assert.ok(slides.startsWith('---\ntheme: default'), 'Slidev front matter 缺失');
  assert.ok(slides.includes('# 第二页'), 'Slidev 内容丢失');

  await messageHandler({ type: 'savePpt', backend: 'marp', markdown: '---\nmarp: true\n---\n\n# A' }); await wait();
  const marpPath = path.join(os.tmpdir(), 'sp-host-test-marp.md');
  assert.ok(fs.existsSync(marpPath), 'Marp 文件未生成');
  const marp = fs.readFileSync(marpPath, 'utf8');
  assert.strictEqual((marp.match(/^---$/gm) || []).length, 2, 'Marp 应只保留一组 front matter');
  assert.ok(marp.includes('marp: true') && marp.includes('# A'), 'Marp 内容异常');
  console.log('✓ savePpt（front matter + 剥离旧 front matter）');

  await messageHandler({ type: 'generateCopy', platform: 'xiaohongshu', local: true }); await wait();
  assert.ok(last('copyResult').data.title, '本地文案提取失败');
  console.log('✓ 本地文案提取');

  await messageHandler({ type: 'llmSaveConfig', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-test' }); await wait();
  const keyName = [...secrets.keys()].find((k) => k.startsWith('sp.llm.apiKey.'));
  assert.strictEqual(secrets.get(keyName), 'sk-test', 'API Key 未存入 SecretStorage');
  console.log('✓ LLM 配置保存（Key → SecretStorage）');

  await messageHandler({ type: 'fetchImageBase64', url: 'http://127.0.0.1:1/x.png', reqId: 'r1' }); await wait(200);
  assert.strictEqual(last('imageBase64Result').dataUrl, null, '失效图片应降级为 null');
  console.log('✓ fetchImageBase64 失败降级');

  ext.deactivate();
  console.log('\n🎉 扩展宿主测试全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('❌ 测试失败:', e);
  process.exit(1);
});
