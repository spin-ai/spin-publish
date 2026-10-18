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
 *   - 去 AI 味：本地检测打分 + AI 改写 + 复检（全文 / 选中片段）
 *   - 选区 AI 改写：右键选中文字，润色 / 精简 / 扩写 / 翻译…（diff 预览后替换）
 *   - 自动发布：内置 zhihu-publisher / toutiao-publisher（Python + patchright）
 *
 * 渲染核心（lib/）移植自 MIT 项目 markdown2anything：https://github.com/marsggbo/markdown2anything
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
const humanize = require('./lib/humanize');
const publishers = require('./lib/publishers');
const { extractCopy } = require('./lib/extract');

const VIEW_TYPE = 'smart-publisher.preview';
const STATE_THEME = 'sp.theme';
const STATE_PROFILES = 'sp.llm.profiles';
const STATE_ACTIVE_PROFILE = 'sp.llm.activeProfile';
const SECRET_PREFIX = 'sp.llm.apiKey.';

/** mdPath -> { panel, disposables, renderTimer } */
const panels = new Map();
/** mdPath -> { type: 'document'|'selection', startOffset?, endOffset?, original? } */
const pendingHumanize = new Map();
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
    vscode.commands.registerCommand('smart-publisher.humanize', (uri) => openPreview(uri, 'humanize')),
    vscode.commands.registerCommand('smart-publisher.aiRewriteSelection', () => aiRewriteSelection()),
    vscode.commands.registerCommand('smart-publisher.publishZhihu', (uri) => publishFlow('zhihu', uri)),
    vscode.commands.registerCommand('smart-publisher.publishToutiao', (uri) => publishFlow('toutiao', uri)),
    vscode.commands.registerCommand('smart-publisher.publisherLogin', () => publisherSessionFlow('login')),
    vscode.commands.registerCommand('smart-publisher.publisherStatus', () => publisherSessionFlow('status')),
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
    // 选区变化时，让面板的「当前选中」状态保持同步（不自动发请求）
    const sel = e.selections && e.selections[0];
    if (sel && !sel.isEmpty) {
      entry.panel.webview.postMessage({
        type: 'selectionChanged',
        chars: e.textEditor.document.getText(sel).replace(/\s/g, '').length,
      });
    } else {
      entry.panel.webview.postMessage({ type: 'selectionCleared' });
    }
  }));

  log('已激活');
}

function deactivate() {
  for (const entry of panels.values()) {
    entry.panel.dispose();
  }
  panels.clear();
  pendingHumanize.clear();
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

function openPreview(uri, initialPanel) {
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
    if (initialPanel) {
      existing.panel.webview.postMessage({ type: 'openPanel', panel: initialPanel });
    }
    return;
  }
  createPanel(mdPath, initialPanel);
}

function createPanel(mdPath, initialPanel) {
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

  const entry = { panel, disposables: [], renderTimer: null, initialPanel: initialPanel || '' };
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
    pendingHumanize.delete(mdPath);
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
        const entry = panels.get(mdPath);
        if (entry && entry.initialPanel) {
          panel.webview.postMessage({ type: 'openPanel', panel: entry.initialPanel });
          entry.initialPanel = '';
        }
        {
          const ed = getEditorForPath(mdPath);
          const sel = ed && ed.selection;
          if (sel && !sel.isEmpty) {
            panel.webview.postMessage({
              type: 'selectionChanged',
              chars: ed.document.getText(sel).replace(/\s/g, '').length,
            });
          } else {
            panel.webview.postMessage({ type: 'selectionCleared' });
          }
        }
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

      // ── 去 AI 味 ──
      case 'humanizeDetect': {
        const result = getHumanizeScope(mdPath, msg.scope);
        pendingHumanize.set(mdPath, result.target);
        const report = humanize.buildReport(result.text, result.label);
        const targetScore = getHumanizeTargetScore();
        panel.webview.postMessage({
          type: 'humanizeReport',
          scope: result.target.type,
          label: result.label,
          report,
          defaultInstruction: humanize.buildHumanizeInstruction(report, { targetScore }),
        });
        break;
      }

      case 'humanizeGenerate': {
        const result = getHumanizeScope(mdPath, msg.scope);
        pendingHumanize.set(mdPath, result.target);
        const before = humanize.buildReport(result.text, result.label);
        const targetScore = getHumanizeTargetScore();
        const instruction = String(msg.instruction || '').trim()
          || humanize.buildHumanizeInstruction(before, { targetScore });
        const config = await getActiveLlmConfig();
        panel.webview.postMessage({ type: 'humanizeGenerating', scope: result.target.type });
        try {
          const markdown = await llm.humanizeMarkdown({
            rawMarkdown: result.text,
            instruction,
            config,
          });
          const after = humanize.buildReport(markdown, result.label);
          panel.webview.postMessage({
            type: 'humanizeResult',
            scope: result.target.type,
            label: result.label,
            markdown,
            before,
            after,
          });
        } catch (err) {
          panel.webview.postMessage({ type: 'humanizeError', message: err.message });
        }
        break;
      }

      case 'humanizeApply': {
        const result = String(msg.result || '').trim();
        if (!result) throw new Error('改写结果为空');
        const applied = await applyHumanizeResult(mdPath, result);
        panel.webview.postMessage({
          type: 'humanizeApplied',
          scope: applied.type,
          message: applied.type === 'selection' ? '已替换选中的文字' : '已替换整篇文档',
        });
        break;
      }

      case 'humanizeSave': {
        const result = String(msg.result || '').trim();
        if (!result) throw new Error('改写结果为空');
        const out = saveHumanizedFile(mdPath, msg.scope, result);
        panel.webview.postMessage({ type: 'humanizeSaved', path: out });
        vscode.window.showInformationMessage(`✅ 已保存去 AI 味副本：${path.basename(out)}`, '打开文件')
          .then((a) => { if (a === '打开文件') vscode.env.openExternal(vscode.Uri.file(out)); });
        break;
      }

      case 'humanizeGetInstruction': {
        const report = msg.report || humanize.buildReport(getMarkdownText(mdPath), path.basename(mdPath));
        panel.webview.postMessage({
          type: 'humanizeInstruction',
          instruction: humanize.buildHumanizeInstruction(report, { targetScore: getHumanizeTargetScore() }),
        });
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
    if (String(msg.type || '').startsWith('humanize')) {
      panel.webview.postMessage({ type: 'humanizeError', message: err.message });
    } else {
      panel.webview.postMessage({ type: 'toast', kind: 'error', message: err.message });
    }
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

// ─────────────────────────────────────────────────────────────
//  去 AI 味 / 选区改写
// ─────────────────────────────────────────────────────────────

function getHumanizeTargetScore() {
  const value = Number(vscode.workspace
    .getConfiguration('smart-publisher')
    .get('humanize.targetScore', 25));
  if (!Number.isFinite(value)) return 25;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getEditorForPath(mdPath) {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.fsPath === mdPath) return active;
  const visible = vscode.window.visibleTextEditors || [];
  return visible.find((e) => e.document.uri.fsPath === mdPath) || null;
}

/**
 * 取出要检测/改写的文本。
 * scope=document → 整篇（优先编辑器内存内容，未保存也生效）
 * scope=selection → 当前编辑器选区（要求有可见编辑器且非空选区）
 */
function getHumanizeScope(mdPath, scope) {
  if (scope !== 'selection') {
    const text = getMarkdownText(mdPath);
    return {
      text,
      target: { type: 'document', original: text },
      label: path.basename(mdPath),
    };
  }

  const editor = getEditorForPath(mdPath);
  if (!editor) {
    throw new Error('找不到对应的 Markdown 编辑器，请先打开文件并选中要改写的文字');
  }
  const sel = editor.selection;
  if (!sel || sel.isEmpty) {
    throw new Error('请先在编辑器中选中要改写的文字');
  }
  const doc = editor.document;
  const text = doc.getText(sel);
  if (!text.trim()) throw new Error('选中的内容为空');
  return {
    text,
    target: {
      type: 'selection',
      startOffset: doc.offsetAt(sel.start),
      endOffset: doc.offsetAt(sel.end),
      original: text,
    },
    label: `选中片段（${text.replace(/\s/g, '').length} 字）`,
  };
}

async function applyHumanizeResult(mdPath, result) {
  const target = pendingHumanize.get(mdPath);
  if (!target) throw new Error('没有可应用的改写目标，请先检测或生成');

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
  const current = doc.getText();
  let range;

  if (target.type === 'selection') {
    const now = current.slice(target.startOffset, target.endOffset);
    if (now !== target.original) {
      throw new Error('选中的内容已经变化，请重新检测 / 生成后再应用');
    }
    range = new vscode.Range(doc.positionAt(target.startOffset), doc.positionAt(target.endOffset));
  } else {
    if (target.original !== undefined && current !== target.original) {
      throw new Error('文档内容在生成后已经变化，请重新检测 / 生成后再应用');
    }
    range = new vscode.Range(doc.positionAt(0), doc.positionAt(current.length));
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, result);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error('应用修改失败');

  pendingHumanize.delete(mdPath);
  const editor = getEditorForPath(mdPath);
  if (editor) {
    const start = target.type === 'selection' ? target.startOffset : 0;
    const end = start + result.length;
    const selection = new vscode.Selection(doc.positionAt(start), doc.positionAt(end));
    editor.selection = selection;
    if (editor.revealRange) editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  }
  return { type: target.type, start: target.type === 'selection' ? target.startOffset : 0 };
}

function saveHumanizedFile(mdPath, scope, result) {
  const base = path.basename(mdPath, path.extname(mdPath));
  const suffix = scope === 'selection' ? '-humanized-selection' : '-humanized';
  const out = path.join(path.dirname(mdPath), `${base}${suffix}.md`);
  fs.writeFileSync(out, result.endsWith('\n') ? result : result + '\n', 'utf8');
  return out;
}

function getGlobalStorageDir() {
  const base = extContext.globalStorageUri && extContext.globalStorageUri.fsPath
    ? extContext.globalStorageUri.fsPath
    : path.join(os.tmpdir(), 'smart-publisher');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

function getRewriteContext(editor, startOffset, endOffset) {
  const doc = editor.document;
  const full = doc.getText();
  const before = full.slice(Math.max(0, startOffset - 1200), startOffset);
  const after = full.slice(endOffset, Math.min(full.length, endOffset + 1200));
  const title = extractTitleFromMarkdown(full) || path.basename(doc.uri.fsPath);
  return [
    `文件：${path.basename(doc.uri.fsPath)}`,
    `标题：${title}`,
    before ? `【选区前文】\n${before}` : '',
    after ? `【选区后文】\n${after}` : '',
  ].filter(Boolean).join('\n\n');
}

async function showRewriteDiff(original, result) {
  try {
    const dir = getGlobalStorageDir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const originalPath = path.join(dir, `rewrite-${stamp}-original.md`);
    const resultPath = path.join(dir, `rewrite-${stamp}-rewritten.md`);
    fs.writeFileSync(originalPath, original, 'utf8');
    fs.writeFileSync(resultPath, result, 'utf8');
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(originalPath),
      vscode.Uri.file(resultPath),
      'AI 改写预览（左：原文 / 右：改写后）',
    );
  } catch (err) {
    log('打开 diff 预览失败：' + err.message);
  }
}

/**
 * 命令：AI 改写选中文字
 * 流程：选区 → 选动作/写指令 → 调用 LLM → diff 预览 → 确认替换
 */
async function aiRewriteSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('请先打开一个编辑器。');
    return;
  }
  const sel = editor.selection;
  if (!sel || sel.isEmpty) {
    vscode.window.showWarningMessage('请先选中要改写的文字。');
    return;
  }

  const original = editor.document.getText(sel);
  if (!original.trim()) {
    vscode.window.showWarningMessage('选中的内容为空。');
    return;
  }

  const preset = await vscode.window.showQuickPick(
    llm.REWRITE_PRESETS,
    { placeHolder: '选择 AI 改写方式', matchOnDescription: true },
  );
  if (!preset) return;

  let instruction = preset.instruction;
  if (preset.id === 'custom') {
    instruction = await vscode.window.showInputBox({
      title: 'AI 改写选中文字',
      prompt: '你希望怎么改这段文字？',
      placeHolder: '例如：改得更像人写的，保留所有技术细节',
      ignoreFocusOut: true,
    });
    if (!instruction || !instruction.trim()) return;
  }

  const startOffset = editor.document.offsetAt(sel.start);
  const endOffset = editor.document.offsetAt(sel.end);
  const context = getRewriteContext(editor, startOffset, endOffset);
  const config = await getActiveLlmConfig();
  const label = String(preset.label || '').replace(/\$\([^)]*\)\s*/g, '');

  let result;
  try {
    const location = vscode.ProgressLocation ? vscode.ProgressLocation.Notification : 15;
    result = await vscode.window.withProgress(
      { location, title: `AI ${label}…`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const sub = token && token.onCancellationRequested
          ? token.onCancellationRequested(() => controller.abort())
          : { dispose() {} };
        try {
          return await llm.rewriteText({
            text: original,
            instruction,
            context,
            config,
            signal: controller.signal,
          });
        } finally {
          sub.dispose();
        }
      },
    );
  } catch (err) {
    if (/已取消|cancel/i.test(err.message)) return;
    vscode.window.showErrorMessage('AI 改写失败：' + err.message);
    return;
  }

  if (!result || !result.trim()) {
    vscode.window.showWarningMessage('AI 没有返回有效内容。');
    return;
  }
  if (result.trim() === original.trim()) {
    vscode.window.showInformationMessage('AI 认为这段文字不需要修改。');
    return;
  }

  await showRewriteDiff(original, result);
  const choice = await vscode.window.showInformationMessage(
    '是否用改写结果替换选中的文字？',
    { modal: true, detail: result.length > 600 ? result.slice(0, 600) + '…' : result },
    '替换',
    '仅复制结果',
  );
  if (!choice) return;

  if (choice === '仅复制结果') {
    await vscode.env.clipboard.writeText(result);
    vscode.window.showInformationMessage('✅ 改写结果已复制到剪贴板。');
    return;
  }

  const doc = editor.document;
  const current = doc.getText();
  if (current.slice(startOffset, endOffset) !== original) {
    vscode.window.showErrorMessage('选区内容已经变化，请重新选中后再试。');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(startOffset), doc.positionAt(endOffset)),
    result,
  );
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage('应用修改失败。');
    return;
  }
  const newSelection = new vscode.Selection(
    doc.positionAt(startOffset),
    doc.positionAt(startOffset + result.length),
  );
  editor.selection = newSelection;
  if (editor.revealRange) editor.revealRange(newSelection, vscode.TextEditorRevealType.InCenter);
  vscode.window.showInformationMessage('✅ 已替换选中的文字。');
}

// ─────────────────────────────────────────────────────────────
//  浏览器自动发布（内置 zhihu-publisher / toutiao-publisher）
// ─────────────────────────────────────────────────────────────

function extractTitleFromMarkdown(markdown) {
  const text = String(markdown || '').replace(/^\uFEFF/, '');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (front) {
    const titleLine = front[1].match(/^title\s*:\s*(.+)$/m);
    if (titleLine) {
      let title = titleLine[1].trim();
      title = title.replace(/^['"]|['"]$/g, '').trim();
      if (title) return title;
    }
  }
  const h1 = text.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1].trim() : '';
}

async function pickPlatform(placeHolder) {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '知乎', description: 'zhuanlan.zhihu.com', platform: 'zhihu' },
      { label: '今日头条', description: 'mp.toutiao.com', platform: 'toutiao' },
    ],
    { placeHolder: placeHolder || '选择发布平台' },
  );
  return pick ? pick.platform : null;
}

function ensurePublisherReady(platform) {
  const pub = publishers.getPublisher(platform);
  if (!pub) throw new Error('未知发布平台：' + platform);
  const files = publishers.checkSkillFiles(extContext.extensionUri, platform);
  if (!files.ok) {
    throw new Error(`内置的 ${pub.name} 发布脚本不完整，缺少：\n${files.missing.join('\n')}\n请重新安装扩展。`);
  }
  const python = publishers.resolvePython(vscode);
  const check = publishers.checkPython(python);
  if (!check.ok) {
    const error = new Error(
      `找不到可用的 Python（${python}）：${check.error}\n` +
      '自动发布需要 Python 3.9+ 与 Google Chrome。可在设置里指定 smart-publisher.publisher.pythonPath。',
    );
    error.pythonMissing = true;
    throw error;
  }
  return { pub, python };
}

function runPublisherTerminal(platform, action, options, mdPath) {
  const pub = publishers.getPublisher(platform);
  if (!pub) throw new Error('未知发布平台：' + platform);
  const python = publishers.resolvePython(vscode);
  const command = publishers.buildPublisherCommand({
    extensionUri: extContext.extensionUri,
    platform,
    python,
    action,
    options,
  });
  const name = `smart-publisher · ${pub.name}`;
  const cwd = mdPath ? path.dirname(mdPath) : extContext.extensionUri.fsPath;
  const terminals = vscode.window.terminals || [];
  let terminal = terminals.find((t) => t.name === name);
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name,
      cwd,
      env: publishers.terminalEnv(vscode),
    });
  }
  terminal.show(true);
  terminal.sendText(command, true);
  return command;
}

async function publisherSessionFlow(action) {
  const platform = await pickPlatform(action === 'login' ? '登录哪个平台' : '检查哪个平台的登录状态');
  if (!platform) return;
  try {
    const { pub } = ensurePublisherReady(platform);
    runPublisherTerminal(platform, action, {}, null);
    vscode.window.showInformationMessage(
      action === 'login'
        ? `已在终端启动 ${pub.name} 登录流程，请在打开的 Chrome 里扫码。`
        : `正在检查 ${pub.name} 登录状态，结果见终端输出。`,
    );
  } catch (err) {
    await handlePublisherError(err);
  }
}

async function handlePublisherError(err) {
  log('发布流程失败：' + err.message);
  if (err.pythonMissing) {
    const action = await vscode.window.showErrorMessage(err.message, '打开设置');
    if (action === '打开设置') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'smart-publisher.publisher.pythonPath');
    }
    return;
  }
  vscode.window.showErrorMessage(err.message);
}

async function publishFlow(platform, uri) {
  const resolved = resolveUri(uri);
  if (!resolved) {
    vscode.window.showWarningMessage('请先打开要发布的 Markdown 文件。');
    return;
  }
  const mdPath = resolved.fsPath;
  let pub;
  try {
    ({ pub } = ensurePublisherReady(platform));
  } catch (err) {
    await handlePublisherError(err);
    return;
  }

  const actionPick = await vscode.window.showQuickPick(
    [
      { label: '$(edit) 填充草稿（推荐）', description: '填好标题/正文/封面，停在发布前，最后一步你自己点', action: 'manual' },
      { label: '$(beaker) 只校验 Markdown', description: '不打开浏览器，只检查标题、图片和格式', action: 'validate' },
      { label: '$(warning) 直接发布（高风险）', description: '脚本会替你点最后一步发布，需二次确认', action: 'auto' },
    ],
    { placeHolder: `发布到${pub.name}：选择操作` },
  );
  if (!actionPick) return;
  const action = actionPick.action;

  const options = { contentFile: mdPath };
  if (action === 'manual' || action === 'auto') {
    const raw = getMarkdownText(mdPath);
    const defaultTitle = extractTitleFromMarkdown(raw);
    const title = await vscode.window.showInputBox({
      title: `发布到${pub.name} · 标题`,
      prompt: '留空则自动使用 front matter 的 title 或正文第一个 # 标题',
      value: defaultTitle,
      ignoreFocusOut: true,
    });
    if (title === undefined) return;
    if (title.trim()) options.title = title.trim();

    const coverPick = await vscode.window.showQuickPick(
      platform === 'toutiao'
        ? [
            { label: '使用正文首图（推荐）', description: '头条会自动取正文第一张图作为封面', value: 'inline' },
            { label: '选择一张封面图片…', value: 'file' },
            { label: '明确选择「无封面」', value: 'none' },
          ]
        : [
            { label: '不上传封面（使用平台默认）', value: 'inline' },
            { label: '选择一张封面图片…', value: 'file' },
          ],
      { placeHolder: '封面设置' },
    );
    if (!coverPick) return;
    if (coverPick.value === 'none') {
      options.noCover = true;
    } else if (coverPick.value === 'file') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: '用作封面',
        filters: { 图片: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      });
      if (!picked || !picked.length) return;
      options.cover = picked[0].fsPath;
    }

    if (pub.supportsColumn) {
      const column = await vscode.window.showInputBox({
        title: '知乎专栏（可选）',
        prompt: '留空则不指定专栏',
        placeHolder: '例如：我的专栏',
        ignoreFocusOut: true,
      });
      if (column === undefined) return;
      if (column.trim()) options.column = column.trim();
    }
  }

  if (action === 'auto') {
    const confirm = await vscode.window.showWarningMessage(
      `即将让脚本在 ${pub.name} 自动点击「发布」。\n\n请确认：内容已检查无误，并理解平台风控与账号风险。`,
      { modal: true },
      '我确认，直接发布',
      '取消',
    );
    if (confirm !== '我确认，直接发布') return;
  }

  try {
    runPublisherTerminal(platform, action, options, mdPath);
    vscode.window.showInformationMessage(
      `已在终端启动${pub.name}发布流程。首次运行会自动创建 Python 虚拟环境并安装 patchright（需要几分钟）；手动模式下填完草稿后会停在发布前，发布完成后在终端按 Ctrl+C 结束。`,
    );
  } catch (err) {
    await handlePublisherError(err);
  }
}

module.exports = { activate, deactivate };
