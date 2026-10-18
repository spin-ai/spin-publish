'use strict';

/**
 * smart-publisher — 扩展宿主入口
 *
 * 功能：
 *   - 侧边 Webview 预览面板：实时渲染 Markdown（公式 / 代码 / 图片 / 表格）
 *   - 一键复制：微信公众号 / 知乎 / 小红书长文（带内联样式 HTML）
 *   - 导出独立 HTML 文件
 *   - 小红书长图导出（webview 内 html2canvas 智能分片，无需外部浏览器）
 *   - AI 文案：小红书笔记 / Twitter 串推（OpenAI 兼容接口，Key 存系统钥匙串）
 *
 * 渲染核心（lib/）移植自 MIT 项目 markdown2anything：https://github.com/marsggbo/markdown2anything
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const {
  renderMarkdown,
  renderMarkdownText,
  buildFullHtml,
  buildWechatCopyHtml,
  buildZhihuCopyHtml,
  buildXhsCopyHtml,
  getXhsAdaptiveCss,
  inlineRemoteImages,
} = require('./lib/converter');
const { THEMES, DEFAULT_THEME_ID, getTheme } = require('./lib/themes');
const llm = require('./lib/llm');
const { extractCopy } = require('./lib/extract');

const VIEW_TYPE = 'smart-publisher.preview';
const STATE_THEME = 'sp.theme';
const STATE_PROFILES = 'sp.llm.profiles';
const STATE_ACTIVE_PROFILE = 'sp.llm.activeProfile';
const SECRET_PREFIX = 'sp.llm.apiKey.';

/** mdPath -> { panel, disposables, renderTimer } */
const panels = new Map();
let extContext = null;

function log(msg) {
  console.log(`[smart-publisher] ${msg}`);
}

// ─────────────────────────────────────────────────────────────
//  激活
// ─────────────────────────────────────────────────────────────

function activate(context) {
  extContext = context;

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-publisher.preview', (uri) => openPreview(uri)),
    vscode.commands.registerCommand('smart-publisher.exportHtml', (uri) => exportHtmlCommand(uri)),
  );

  // 编辑内容变化 → 增量刷新预览
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const mdPath = e.document.uri.fsPath;
    const entry = panels.get(mdPath);
    if (entry && entry.panel.visible) scheduleRender(mdPath);
  }));

  // 光标移动 → 预览区滚动到对应段落
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
    const mdPath = e.textEditor.document.uri.fsPath;
    const entry = panels.get(mdPath);
    if (!entry || !entry.panel.visible) return;
    const line = e.selections && e.selections[0] ? e.selections[0].active.line : 0;
    entry.panel.webview.postMessage({ type: 'syncToLine', line });
  }));

  log('已激活');
}

function deactivate() {
  for (const entry of panels.values()) {
    entry.panel.dispose();
  }
  panels.clear();
}

// ─────────────────────────────────────────────────────────────
//  目标文件解析
// ─────────────────────────────────────────────────────────────

function resolveUri(uri) {
  if (uri && uri.fsPath) return uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.languageId === 'markdown' && ed.document.uri.fsPath) {
    return ed.document.uri;
  }
  return null;
}

function getThemeId() {
  return extContext.globalState.get(STATE_THEME, DEFAULT_THEME_ID);
}

function setThemeId(id) {
  extContext.globalState.update(STATE_THEME, id);
  const cfg = vscode.workspace.getConfiguration('smart-publisher');
  // 同步回设置，方便下次对任意文件使用
  cfg.update('theme', id, vscode.ConfigurationTarget.Global).then(() => {}, () => {});
}

/** 获取 Markdown 文本：优先取编辑器内存中的（未保存也生效），否则读磁盘 */
function getMarkdownText(mdPath) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === mdPath);
  if (doc) return doc.getText();
  return fs.readFileSync(mdPath, 'utf8');
}

function renderDoc(mdPath) {
  const raw = getMarkdownText(mdPath);
  return renderMarkdownText(raw, path.dirname(mdPath), path.basename(mdPath));
}

function getTemplatePath() {
  const cfg = vscode.workspace.getConfiguration('smart-publisher');
  const name = cfg.get('template', 'wechat') || 'wechat';
  const mdDir = vscode.window.activeTextEditor
    ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath || '')
    : '';
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const candidates = [];
  if (ws) candidates.push(path.join(ws.uri.fsPath, 'templates', `${name}.html`));
  if (mdDir) candidates.push(path.join(mdDir, 'templates', `${name}.html`));
  candidates.push(path.join(extContext.extensionUri.fsPath, 'templates', `${name}.html`));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return path.join(extContext.extensionUri.fsPath, 'templates', 'wechat.html');
}

// ─────────────────────────────────────────────────────────────
//  面板创建
// ─────────────────────────────────────────────────────────────

function openPreview(uri) {
  const resolved = resolveUri(uri);
  if (!resolved) {
    vscode.window.showWarningMessage('请先打开一个 Markdown 文件，再使用 smart-publisher。');
    return;
  }
  const mdPath = resolved.fsPath;
  const existing = panels.get(mdPath);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Beside, true);
    renderPanel(mdPath);
    return;
  }
  createPanel(mdPath);
}

function createPanel(mdPath) {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `smart-publisher · ${path.basename(mdPath)}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extContext.extensionUri],
    },
  );

  // 面板标签页图标（之前是 VS Code 默认图标）
  panel.iconPath = vscode.Uri.file(
    path.join(extContext.extensionUri.fsPath, 'media', 'icon.png'),
  );

  const entry = { panel, disposables: [], renderTimer: null };
  panels.set(mdPath, entry);

  panel.webview.html = getWebviewHtml(panel.webview);

  panel.webview.onDidReceiveMessage(
    (msg) => handleMessage(mdPath, panel, msg),
    null,
    entry.disposables,
  );

  panel.onDidDispose(() => {
    entry.disposables.forEach((d) => d.dispose());
    panels.delete(mdPath);
  }, null, entry.disposables);

  // 监听磁盘文件外部变更
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(mdPath), path.basename(mdPath)),
    );
    watcher.onDidChange(() => scheduleRender(mdPath));
    entry.disposables.push(watcher);
  } catch (_) {}
}

function scheduleRender(mdPath) {
  const entry = panels.get(mdPath);
  if (!entry) return;
  clearTimeout(entry.renderTimer);
  entry.renderTimer = setTimeout(() => renderPanel(mdPath), 220);
}

function renderPanel(mdPath) {
  const entry = panels.get(mdPath);
  if (!entry) return;
  try {
    const { bodyHtml, title } = renderDoc(mdPath);
    const theme = getTheme(getThemeId());
    const raw = getMarkdownText(mdPath);
    const wordCount = raw.replace(/\s+/g, '').length;
    entry.panel.title = `smart-publisher · ${path.basename(mdPath)}`;
    entry.panel.webview.postMessage({
      type: 'render',
      bodyHtml,
      title,
      wordCount,
      theme: { id: theme.id, name: theme.name, css: theme.css, wrapperBg: theme.wrapperBg },
    });
  } catch (err) {
    log('渲染失败: ' + err.message);
    entry.panel.webview.postMessage({ type: 'error', message: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
//  Webview HTML
// ─────────────────────────────────────────────────────────────

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function getWebviewHtml(webview) {
  const nonce = getNonce();
  const csp = webview.cspSource;
  const ext = extContext.extensionUri.fsPath;

  const uri = (rel) => webview.asWebviewUri(vscode.Uri.file(path.join(ext, rel)));
  const katexDist = uri(path.join('node_modules', 'katex', 'dist'));
  const hlStyle = uri(path.join('node_modules', 'highlight.js', 'styles', 'github.min.css'));
  const html2canvas = uri(path.join('node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'));
  const panelCss = uri(path.join('media', 'panel.css'));
  const panelJs = uri(path.join('media', 'panel.js'));
  const iconUri = uri(path.join('media', 'icon.svg'));

  let version = '';
  try { version = require('./package.json').version; } catch (_) {}

  let html = fs.readFileSync(path.join(ext, 'media', 'panel.html'), 'utf8');
  html = html
    .split('__NONCE__').join(nonce)
    .split('__CSP_SOURCE__').join(csp)
    .split('__KATEX_URI__').join(katexDist)
    .split('__HL_URI__').join(hlStyle)
    .split('__HTML2CANVAS_URI__').join(html2canvas)
    .split('__PANEL_CSS_URI__').join(panelCss)
    .split('__PANEL_JS_URI__').join(panelJs)
    .split('__ICON_URI__').join(iconUri)
    .split('__VERSION__').join(version);
  return html;
}

// ─────────────────────────────────────────────────────────────
//  消息处理
// ─────────────────────────────────────────────────────────────

async function handleMessage(mdPath, panel, msg) {
  if (!msg || !msg.type) return;
  try {
    switch (msg.type) {
      case 'ready': {
        sendThemeList(panel);
        sendLlmConfig(panel);
        renderPanel(mdPath);
        break;
      }

      case 'setTheme': {
        setThemeId(msg.themeId);
        renderPanel(mdPath);
        break;
      }

      case 'getWechatHtml': {
        const { bodyHtml } = renderDoc(mdPath);
        const inlined = await inlineRemoteImages(bodyHtml).catch(() => bodyHtml);
        const theme = getTheme(getThemeId());
        const html = buildWechatCopyHtml(inlined, getTemplatePath(), theme);
        panel.webview.postMessage({ type: 'wechatHtml', html });
        break;
      }

      case 'getZhihuHtml': {
        const { bodyHtml } = renderDoc(mdPath);
        const theme = getTheme(getThemeId());
        const html = buildZhihuCopyHtml(bodyHtml, null, theme);
        panel.webview.postMessage({ type: 'zhihuHtml', html });
        break;
      }

      case 'getXhsCopyHtml': {
        const { bodyHtml } = renderDoc(mdPath);
        const theme = getTheme(getThemeId());
        const html = buildXhsCopyHtml(bodyHtml, theme);
        panel.webview.postMessage({ type: 'xhsCopyHtml', html });
        break;
      }

      case 'exportHtml': {
        const out = exportHtmlFile(mdPath);
        vscode.window.showInformationMessage(`✅ 已导出 HTML：${out}`, '打开文件', '在 Finder 中显示')
          .then((a) => {
            if (a === '打开文件') vscode.env.openExternal(vscode.Uri.file(out));
            if (a === '在 Finder 中显示') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(out));
          });
        panel.webview.postMessage({ type: 'toast', kind: 'success', message: `已导出 HTML：${path.basename(out)}` });
        break;
      }

      // ── 小红书长图截图（webview 内 html2canvas）──
      case 'getXhsCapture': {
        const { bodyHtml, title } = renderDoc(mdPath);
        const theme = getTheme(getThemeId());
        const mode = msg.mode === 'adaptive' ? 'adaptive' : 'classic';
        const useThemeAccent = vscode.workspace
          .getConfiguration('smart-publisher')
          .get('xhs.adaptiveUseTheme', true);
        let css = '';
        let containerClass = 'article-wrapper';
        const bg = theme.wrapperBg || '#ffffff';
        if (mode === 'adaptive') {
          css = getXhsAdaptiveCss(theme, {
            fontSize: Number(msg.fontSize) || 36,
            useThemeAccent,
          });
          containerClass = 'xhs-capture';
        }
        panel.webview.postMessage({
          type: 'xhsCapture',
          bodyHtml,
          title,
          mode,
          css,
          containerClass,
          bg,
        });
        break;
      }

      case 'saveXhsImages': {
        const dir = saveXhsImages(mdPath, msg.dataUrls || []);
        vscode.window.showInformationMessage(
          `✅ 已导出 ${(msg.dataUrls || []).length} 张长图到 ${dir}`,
          '在 Finder 中显示',
        ).then((a) => {
          if (a === '在 Finder 中显示') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        });
        panel.webview.postMessage({ type: 'saveXhsDone', count: (msg.dataUrls || []).length, dir });
        break;
      }

      // ── 远程图片转 base64（html2canvas 无法渲染跨域图片）──
      case 'fetchImageBase64': {
        const dataUrl = await fetchAsDataUrl(msg.url).catch(() => null);
        panel.webview.postMessage({ type: 'imageBase64Result', reqId: msg.reqId, dataUrl });
        break;
      }

      // ── AI 文案 ──
      case 'getCopyInstruction': {
        panel.webview.postMessage({
          type: 'copyInstruction',
          platform: msg.platform,
          instruction: llm.getDefaultInstruction(msg.platform),
        });
        break;
      }

      case 'generateCopy': {
        const { title, rawMarkdown } = renderDoc(mdPath);
        const platform = msg.platform === 'twitter' ? 'twitter' : 'xiaohongshu';
        if (msg.local) {
          const data = extractCopy({ rawMarkdown, platform, title });
          panel.webview.postMessage({ type: 'copyResult', platform, source: 'local', data });
          break;
        }
        const cfg = vscode.workspace.getConfiguration('smart-publisher');
        const withBody = cfg.get('llm.sendFullText', true);
        const config = await getActiveLlmConfig();
        const context = llm.buildContext({
          title,
          link: '',
          images: [],
          rawMarkdown: withBody ? rawMarkdown : rawMarkdown.slice(0, 1200),
        });
        panel.webview.postMessage({ type: 'copyGenerating', platform });
        try {
          const data = await llm.generateCopy({
            platform,
            instruction: msg.instruction || llm.getDefaultInstruction(platform),
            context,
            config,
          });
          panel.webview.postMessage({ type: 'copyResult', platform, source: 'llm', data });
        } catch (err) {
          panel.webview.postMessage({ type: 'copyError', platform, message: err.message });
        }
        break;
      }

      // ── PPT 导出（Slidev / Marp）──
      case 'getPptInstruction': {
        panel.webview.postMessage({
          type: 'pptInstruction',
          backend: msg.backend,
          instruction: llm.getDefaultPptInstruction(msg.backend),
        });
        break;
      }

      case 'generatePpt': {
        const { rawMarkdown } = renderDoc(mdPath);
        const backend = msg.backend === 'marp' ? 'marp' : 'slidev';
        const config = await getActiveLlmConfig();
        panel.webview.postMessage({ type: 'pptGenerating', backend });
        try {
          const markdown = await llm.generatePptMarkdown({
            rawMarkdown,
            backend,
            instruction: msg.instruction,
            config,
          });
          panel.webview.postMessage({ type: 'pptResult', backend, markdown });
        } catch (err) {
          panel.webview.postMessage({ type: 'pptError', backend, message: err.message });
        }
        break;
      }

      case 'savePpt': {
        const backend = msg.backend === 'marp' ? 'marp' : 'slidev';
        const { title } = renderDoc(mdPath);
        const out = savePptFile(mdPath, backend, msg.markdown || '', title);
        panel.webview.postMessage({ type: 'pptSaved', backend, path: out });
        vscode.window.showInformationMessage(`✅ 已生成 ${path.basename(out)}`, '打开文件')
          .then((a) => { if (a === '打开文件') vscode.env.openExternal(vscode.Uri.file(out)); });
        break;
      }

      // ── LLM 配置 ──
      case 'llmGetConfig': {
        sendLlmConfig(panel);
        break;
      }

      case 'llmSaveConfig': {
        await saveLlmProfile(msg);
        sendLlmConfig(panel);
        panel.webview.postMessage({ type: 'toast', kind: 'success', message: 'LLM 配置已保存' });
        break;
      }

      case 'llmDeleteProfile': {
        await deleteLlmProfile(msg.profileId);
        sendLlmConfig(panel);
        break;
      }

      case 'llmActivate': {
        await extContext.globalState.update(STATE_ACTIVE_PROFILE, msg.profileId);
        sendLlmConfig(panel);
        break;
      }

      case 'llmTest': {
        try {
          const config = await getActiveLlmConfig(msg.profileId);
          const res = await llm.testConnection({ config });
          panel.webview.postMessage({ type: 'llmTestResult', ok: true, message: `连接成功，模型回复：${res.reply}` });
        } catch (err) {
          panel.webview.postMessage({ type: 'llmTestResult', ok: false, message: err.message });
        }
        break;
      }

      case 'openExternal': {
        if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      }

      default:
        log('未知消息类型: ' + msg.type);
    }
  } catch (err) {
    log(`处理消息 ${msg.type} 失败: ${err.stack || err.message}`);
    panel.webview.postMessage({ type: 'toast', kind: 'error', message: err.message });
  }
}

function sendThemeList(panel) {
  panel.webview.postMessage({
    type: 'themeList',
    themes: THEMES.map((t) => ({ id: t.id, name: t.name })),
    currentId: getThemeId(),
  });
}

// ─────────────────────────────────────────────────────────────
//  导出 / 保存
// ─────────────────────────────────────────────────────────────

function exportHtmlCommand(uri) {
  const resolved = resolveUri(uri);
  if (!resolved) {
    vscode.window.showWarningMessage('请先打开一个 Markdown 文件。');
    return;
  }
  try {
    const out = exportHtmlFile(resolved.fsPath);
    vscode.window.showInformationMessage(`✅ 已导出 HTML：${out}`, '打开文件', '在 Finder 中显示')
      .then((a) => {
        if (a === '打开文件') vscode.env.openExternal(vscode.Uri.file(out));
        if (a === '在 Finder 中显示') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(out));
      });
  } catch (err) {
    vscode.window.showErrorMessage('导出失败：' + err.message);
  }
}

function exportHtmlFile(mdPath) {
  const { bodyHtml } = renderDoc(mdPath);
  const html = buildFullHtml(bodyHtml, getTemplatePath());
  const base = path.basename(mdPath, path.extname(mdPath));
  const cfgDir = vscode.workspace.getConfiguration('smart-publisher').get('outputPath', '');
  let outDir;
  if (cfgDir) {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    outDir = path.isAbsolute(cfgDir)
      ? cfgDir
      : path.join(ws ? ws.uri.fsPath : path.dirname(mdPath), cfgDir);
  } else {
    outDir = path.dirname(mdPath);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${base}.html`);
  fs.writeFileSync(out, html, 'utf8');
  return out;
}

/** 去掉 LLM 可能附带的 front matter（仅当它看起来像 YAML 且较短） */
function stripLeadingFrontMatter(md) {
  const s = String(md || '').replace(/^\uFEFF/, '').trimStart();
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return s.trim();
  const block = m[1];
  const looksLikeYaml = block.split('\n').length <= 30 && /^[A-Za-z_][\w-]*\s*:/m.test(block);
  return looksLikeYaml ? s.slice(m[0].length).trim() : s.trim();
}

/**
 * 保存 PPT Markdown，并按后端补上 front matter。
 * Slidev → <base>-slides.md；Marp → <base>-marp.md
 */
function savePptFile(mdPath, backend, markdown, title) {
  const body = stripLeadingFrontMatter(markdown);
  const frontMatter = backend === 'marp'
    ? '---\nmarp: true\ntheme: default\npaginate: true\nsize: 16:9\n---\n\n'
    : `---\ntheme: default\ntitle: ${JSON.stringify(title || '')}\n---\n\n`;
  const base = path.basename(mdPath, path.extname(mdPath));
  const out = path.join(
    path.dirname(mdPath),
    backend === 'marp' ? `${base}-marp.md` : `${base}-slides.md`,
  );
  fs.writeFileSync(out, frontMatter + body + '\n', 'utf8');
  return out;
}

function saveXhsImages(mdPath, dataUrls) {
  const base = path.basename(mdPath, path.extname(mdPath));
  const dir = path.join(path.dirname(mdPath), `${base}_xhs`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dataUrls.forEach((dataUrl, i) => {
    const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    const fname = `xiaohongshu-${String(i + 1).padStart(2, '0')}.png`;
    fs.writeFileSync(path.join(dir, fname), buf);
  });
  return dir;
}

// ─────────────────────────────────────────────────────────────
//  远程图片下载
// ─────────────────────────────────────────────────────────────

function fetchAsDataUrl(url, timeoutMs = 12000, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const client = u.protocol === 'https:' ? https : http;
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const req = client.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchAsDataUrl(loc, timeoutMs, maxBytes).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { fail(new Error('HTTP ' + res.statusCode)); return; }
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) { fail(new Error('图片过大')); req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(`data:${guessMime(buf, url)};base64,${buf.toString('base64')}`);
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.on('timeout', () => { req.destroy(); fail(new Error('超时')); });
  });
}

function guessMime(buf, url) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 7 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 5 && buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.length > 11 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  return map[ext] || 'image/png';
}

// ─────────────────────────────────────────────────────────────
//  LLM 多配置管理
// ─────────────────────────────────────────────────────────────

function getProfiles() {
  return extContext.globalState.get(STATE_PROFILES, []);
}

async function ensureDefaultProfile() {
  const profiles = getProfiles();
  if (profiles.length) return profiles;
  const cfg = vscode.workspace.getConfiguration('smart-publisher');
  const p = {
    id: 'p' + Date.now().toString(36),
    name: '默认',
    baseUrl: cfg.get('llm.baseUrl', ''),
    model: cfg.get('llm.model', ''),
  };
  await extContext.globalState.update(STATE_PROFILES, [p]);
  await extContext.globalState.update(STATE_ACTIVE_PROFILE, p.id);
  return [p];
}

async function getActiveLlmConfig(profileId) {
  const profiles = await ensureDefaultProfile();
  const activeId = profileId || extContext.globalState.get(STATE_ACTIVE_PROFILE, '');
  const p = profiles.find((x) => x.id === activeId) || profiles[0];
  if (!p) {
    const cfg = vscode.workspace.getConfiguration('smart-publisher');
    return { id: '', name: '默认', baseUrl: cfg.get('llm.baseUrl', ''), model: cfg.get('llm.model', ''), apiKey: '' };
  }
  const apiKey = await extContext.secrets.get(SECRET_PREFIX + p.id) || '';
  return { id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey };
}

async function saveLlmProfile(msg) {
  const profiles = await ensureDefaultProfile();
  let p = profiles.find((x) => x.id === msg.profileId);
  if (!p) {
    p = { id: 'p' + Date.now().toString(36), name: msg.name || '新配置', baseUrl: '', model: '' };
    profiles.push(p);
  }
  if (typeof msg.name === 'string' && msg.name.trim()) p.name = msg.name.trim();
  if (typeof msg.baseUrl === 'string') p.baseUrl = msg.baseUrl.trim();
  if (typeof msg.model === 'string') p.model = msg.model.trim();
  await extContext.globalState.update(STATE_PROFILES, profiles);
  if (typeof msg.apiKey === 'string' && msg.apiKey.trim()) {
    await extContext.secrets.store(SECRET_PREFIX + p.id, msg.apiKey.trim());
  }
  await extContext.globalState.update(STATE_ACTIVE_PROFILE, p.id);
  // 同步设置项，方便其他入口读取
  const cfg = vscode.workspace.getConfiguration('smart-publisher');
  await cfg.update('llm.baseUrl', p.baseUrl, vscode.ConfigurationTarget.Global).then(() => {}, () => {});
  await cfg.update('llm.model', p.model, vscode.ConfigurationTarget.Global).then(() => {}, () => {});
  return p;
}

async function deleteLlmProfile(profileId) {
  let profiles = await ensureDefaultProfile();
  profiles = profiles.filter((x) => x.id !== profileId);
  if (!profiles.length) profiles = await ensureDefaultProfile();
  await extContext.globalState.update(STATE_PROFILES, profiles);
  await extContext.secrets.delete(SECRET_PREFIX + profileId).then(() => {}, () => {});
  const activeId = extContext.globalState.get(STATE_ACTIVE_PROFILE, '');
  if (activeId === profileId) {
    await extContext.globalState.update(STATE_ACTIVE_PROFILE, profiles[0].id);
  }
}

async function sendLlmConfig(panel) {
  const profiles = await ensureDefaultProfile();
  const activeId = extContext.globalState.get(STATE_ACTIVE_PROFILE, '');
  const list = [];
  for (const p of profiles) {
    const key = await extContext.secrets.get(SECRET_PREFIX + p.id) || '';
    list.push({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, hasKey: !!key });
  }
  const active = await getActiveLlmConfig();
  panel.webview.postMessage({
    type: 'llmConfig',
    profiles: list,
    activeId: active.id || activeId,
    baseUrl: active.baseUrl,
    model: active.model,
    hasKey: !!active.apiKey,
  });
}

module.exports = { activate, deactivate };
