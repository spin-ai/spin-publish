/* md2any — webview 交互逻辑 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // ── 状态 ──────────────────────────────────────────────
  let currentBodyHtml = '';
  let currentTitle = '';
  let currentTheme = null;
  let zoom = 1;
  let xhsSlices = [];
  let llmState = { profiles: [], activeId: '', hasKey: false };
  let aiData = null;

  // ── 工具函数 ──────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── 主题应用 ──────────────────────────────────────────
  function applyTheme(theme) {
    currentTheme = theme;
    const accent = themeAccent(theme);
    document.documentElement.style.setProperty('--m2a-accent', accent);
    let styleEl = document.getElementById('theme-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'theme-style';
      document.head.appendChild(styleEl);
    }
    // 主题 CSS 是裸选择器，统一下挂到 .article-wrapper 作用域，避免污染面板
    const scoped = String(theme.css || '').replace(/([^}]+)\{/g, (m, sel) => {
      const lines = sel.split(',');
      return '.article-wrapper ' + lines.map((s) => s.trim()).join(', .article-wrapper ') + ' {';
    });
    styleEl.textContent =
      '.article-wrapper { background: ' + (theme.wrapperBg || '#fff') + '; }\n' + scoped;
    $('preview-scroll').style.background = theme.wrapperBg || 'transparent';
  }

  const THEME_ACCENT = {
    wechat: '#de7456', claude: '#d97706', macos: '#0071e3', dark: '#89b4fa',
    zhihu: '#0f6fec', monochrome: '#111111', spring: '#e86f8c', academic: '#1a1a1a',
    xhs: '#ff2442', notion: '#0f7b6c', 'claude-pro': '#c2410c', medium: '#1a1a1a',
    ryf: '#0079c1', 'clean-blue': '#3182ce',
  };
  function themeAccent(theme) {
    if (theme && THEME_ACCENT[theme.id]) return THEME_ACCENT[theme.id];
    const m = String((theme && theme.css) || '').match(/strong\s*\{[^}]*color\s*:\s*(#[0-9a-fA-F]{3,6})/i);
    return m ? m[1] : '#0a9d58';
  }

  // ── 主题选择 ──────────────────────────────────────────
  $('theme-select').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'setTheme', themeId: e.target.value });
  });

  // ── 缩放 ──────────────────────────────────────────────
  function applyZoom() {
    const canvas = $('zoom-canvas');
    canvas.style.zoom = String(zoom);
    canvas.style.transformOrigin = 'top center';
    $('btn-zoom-reset').textContent = Math.round(zoom * 100) + '%';
  }
  $('btn-zoom-in').addEventListener('click', () => { zoom = Math.min(2, zoom + 0.1); applyZoom(); });
  $('btn-zoom-out').addEventListener('click', () => { zoom = Math.max(0.5, zoom - 0.1); applyZoom(); });
  $('btn-zoom-reset').addEventListener('click', () => { zoom = 1; applyZoom(); });
  $('preview-scroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom = Math.min(2, Math.max(0.5, zoom + (e.deltaY < 0 ? 0.06 : -0.06)));
    applyZoom();
  }, { passive: false });

  // ── 侧面板开关 ────────────────────────────────────────
  function togglePanel(id) {
    const el = $(id);
    const willShow = el.hidden;
    ['panel-xhs', 'panel-ai', 'panel-llm'].forEach((p) => { $(p).hidden = true; });
    el.hidden = !willShow;
    if (id === 'panel-ai' && willShow) requestInstruction();
    if (id === 'panel-llm' && willShow) vscode.postMessage({ type: 'llmGetConfig' });
  }
  $('btn-xhs').addEventListener('click', () => togglePanel('panel-xhs'));
  $('btn-ai').addEventListener('click', () => togglePanel('panel-ai'));
  $('btn-llm').addEventListener('click', () => togglePanel('panel-llm'));
  document.querySelectorAll('.panel-close').forEach((b) => {
    b.addEventListener('click', () => { $(b.dataset.close).hidden = true; });
  });

  // ── 复制（微信 / 知乎 / 小红书）────────────────────────
  function copyHtml(html) {
    const preview = $('preview-content');
    const plain = preview ? preview.innerText : '';
    const finish = (label) => toast(`✅ 已复制${label}格式，去编辑器粘贴即可`);
    if (navigator.clipboard && window.ClipboardItem) {
      navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]).then(() => finish('')).catch(fallback);
    } else { fallback(); }
    function fallback() {
      const tmp = document.createElement('div');
      tmp.style.cssText = 'position:fixed;left:-99999px;top:0;';
      tmp.innerHTML = html;
      document.body.appendChild(tmp);
      const range = document.createRange();
      range.selectNodeContents(tmp);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      try { document.execCommand('copy'); finish(''); }
      catch (_) { toast('复制失败，请手动选择后复制', 'error'); }
      sel.removeAllRanges();
      document.body.removeChild(tmp);
    }
  }

  $('btn-copy-wechat').addEventListener('click', () => {
    setBusy('btn-copy-wechat', true, '处理中…');
    vscode.postMessage({ type: 'getWechatHtml' });
  });
  $('btn-copy-zhihu').addEventListener('click', () => vscode.postMessage({ type: 'getZhihuHtml' }));
  $('btn-copy-xhs').addEventListener('click', () => vscode.postMessage({ type: 'getXhsCopyHtml' }));
  $('btn-export-html').addEventListener('click', () => vscode.postMessage({ type: 'exportHtml' }));

  function setBusy(id, busy, label) {
    const b = $(id);
    if (!b) return;
    b.disabled = busy;
    if (label) b.dataset._label = b.textContent, b.textContent = label;
    else if (b.dataset._label) b.textContent = b.dataset._label;
  }

  // ── 小红书长图 ────────────────────────────────────────
  const XHS_W = 1080, XHS_H = 1440, XHS_SCALE = 2, CHUNK_H = 1200, CHUNK_OVERLAP = 120;

  $('xhs-mode').addEventListener('change', () => {
    const adaptive = $('xhs-mode').value === 'adaptive';
    $('xhs-font-row').hidden = !adaptive;
  });
  $('xhs-font').addEventListener('input', () => { $('xhs-font-val').textContent = $('xhs-font').value; });

  $('btn-xhs-generate').addEventListener('click', () => {
    setBusy('btn-xhs-generate', true, '生成中…');
    $('xhs-output').innerHTML = '<p class="hint">⏳ 正在请求渲染…</p>';
    vscode.postMessage({
      type: 'getXhsCapture',
      mode: $('xhs-mode').value,
      fontSize: Number($('xhs-font').value),
    });
  });

  $('btn-xhs-export-all').addEventListener('click', () => {
    if (!xhsSlices.length) return;
    setBusy('btn-xhs-export-all', true, '导出中…');
    vscode.postMessage({ type: 'saveXhsImages', dataUrls: xhsSlices });
  });

  async function renderXhs(msg) {
    const { bodyHtml, mode, css, containerClass, bg } = msg;
    // 1) 预取远程图片为 base64（html2canvas 无法渲染跨域图片）
    const holder = document.createElement('div');
    holder.innerHTML = bodyHtml;
    const remoteImgs = Array.from(holder.querySelectorAll('img')).filter((im) => {
      const src = im.getAttribute('src') || '';
      return /^https?:\/\//.test(src);
    });
    if (remoteImgs.length) {
      $('xhs-output').innerHTML = `<p class="hint">⏳ 正在内联 ${remoteImgs.length} 张远程图片…</p>`;
      await Promise.all(remoteImgs.map(async (im) => {
        const url = im.getAttribute('src');
        const dataUrl = await fetchImageBase64(url);
        if (dataUrl) { im.setAttribute('src', dataUrl); }
      }));
    }

    // 2) 离屏容器
    $('xhs-output').innerHTML = '<p class="hint">⏳ html2canvas 渲染中…</p>';
    const fontSize = Number($('xhs-font').value) || 36;
    const pad = mode === 'adaptive'
      ? `${Math.round(56 * fontSize / 40)}px ${Math.round(44 * fontSize / 40)}px`
      : '40px 48px';
    const off = document.createElement('div');
    off.className = containerClass;
    off.style.cssText = `position:absolute;left:-20000px;top:0;width:${XHS_W}px;padding:${pad};background:${bg};`;
    off.innerHTML = holder.innerHTML;
    if (mode === 'adaptive') {
      const s = document.createElement('style');
      s.textContent = css;
      off.insertBefore(s, off.firstChild);
    }
    document.body.appendChild(off);
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready.catch(() => {});
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    let full;
    try {
      full = await captureChunked(off);
    } finally {
      off.remove();
    }

    // 3) 智能切片
    const bgRgb = cssColorToRgb(bg);
    xhsSlices = smartSlice(full, XHS_H * XHS_SCALE, bgRgb, 16);
    showXhsOutput(xhsSlices);
    $('btn-xhs-export-all').disabled = false;
    setBusy('btn-xhs-generate', false);
    toast(`✅ 生成 ${xhsSlices.length} 张长图，可点击「一键导出全部」保存`);
  }

  function fetchImageBase64(url) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const handler = (e) => {
        const m = e.data;
        if (m && m.type === 'imageBase64Result' && m.reqId === reqId) {
          window.removeEventListener('message', handler);
          resolve(m.dataUrl || null);
        }
      };
      window.addEventListener('message', handler);
      vscode.postMessage({ type: 'fetchImageBase64', url, reqId });
      setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 15000);
    });
  }

  async function captureChunked(el) {
    const totalH = Math.max(1, Math.ceil(el.getBoundingClientRect().height));
    const physW = XHS_W * XHS_SCALE;
    const out = document.createElement('canvas');
    out.width = physW;
    out.height = Math.max(1, totalH * XHS_SCALE);
    const octx = out.getContext('2d');
    const bg = (currentTheme && currentTheme.wrapperBg) || '#ffffff';
    octx.fillStyle = bg;
    octx.fillRect(0, 0, out.width, out.height);
    let y = 0, guard = 0;
    while (y < totalH && guard < 500) {
      guard++;
      const chunkLogicalH = Math.min(CHUNK_H, totalH - y);
      const canvas = await html2canvas(el, {
        scale: XHS_SCALE,
        backgroundColor: bg,
        useCORS: true,
        logging: false,
        width: XHS_W,
        windowWidth: XHS_W,
        height: Math.min(chunkLogicalH + CHUNK_OVERLAP, totalH - y),
        y,
        x: 0,
      });
      const pasteH = Math.min(chunkLogicalH * XHS_SCALE, canvas.height);
      octx.drawImage(canvas, 0, 0, canvas.width, pasteH, 0, y * XHS_SCALE, physW, pasteH);
      y += chunkLogicalH;
      await new Promise((r) => setTimeout(r, 20));
    }
    const finalH = Math.min(totalH * XHS_SCALE, out.height);
    const cropped = document.createElement('canvas');
    cropped.width = physW;
    cropped.height = finalH;
    cropped.getContext('2d').drawImage(out, 0, 0, physW, finalH, 0, 0, physW, finalH);
    return cropped;
  }

  function cssColorToRgb(color) {
    const m = String(color || '').match(/#([0-9a-f]{3,8})/i);
    let hex = m ? m[1] : 'ffffff';
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length >= 6) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    }
    const rgb = String(color).match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
    return { r: 255, g: 255, b: 255 };
  }

  function isCleanRow(data, relY, width, bgRgb, tol) {
    const off = relY * width * 4;
    for (let x = 0; x < width; x++) {
      const i = off + x * 4;
      if (data[i + 3] < 10) continue;
      if (Math.abs(data[i] - bgRgb.r) > tol ||
          Math.abs(data[i + 1] - bgRgb.g) > tol ||
          Math.abs(data[i + 2] - bgRgb.b) > tol) return false;
    }
    return true;
  }

  function smartSlice(canvas, maxSliceH, bgRgb, tol) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const slices = [];
    let startY = 0;
    while (startY < H) {
      let endY = Math.min(startY + maxSliceH, H);
      if (endY < H) {
        const minEndY = startY + Math.floor(maxSliceH * 0.5);
        const chunk = ctx.getImageData(0, startY, W, endY - startY);
        let cutY = endY;
        while (cutY > minEndY) {
          if (isCleanRow(chunk.data, cutY - startY - 1, W, bgRgb, tol)) { endY = cutY; break; }
          cutY--;
        }
      }
      const sc = document.createElement('canvas');
      sc.width = W; sc.height = endY - startY;
      sc.getContext('2d').drawImage(canvas, 0, startY, W, endY - startY, 0, 0, W, endY - startY);
      slices.push(sc.toDataURL('image/png'));
      startY = endY;
    }
    return slices;
  }

  function showXhsOutput(slices) {
    if (!slices.length) {
      $('xhs-output').innerHTML = '<p class="hint">未生成任何图片。</p>';
      $('btn-xhs-export-all').disabled = true;
      return;
    }
    $('xhs-output').innerHTML = slices
      .map((url, i) => `<img src="${url}" alt="第 ${i + 1} 张" title="第 ${i + 1} 张 / 共 ${slices.length} 张">`)
      .join('');
  }

  // ── AI 文案 ───────────────────────────────────────────
  $('ai-platform').addEventListener('change', requestInstruction);
  function requestInstruction() {
    vscode.postMessage({ type: 'getCopyInstruction', platform: $('ai-platform').value });
  }
  $('btn-ai-generate').addEventListener('click', () => {
    $('ai-status').textContent = '⏳ 正在调用 LLM…';
    $('ai-result').hidden = true;
    vscode.postMessage({
      type: 'generateCopy',
      platform: $('ai-platform').value,
      instruction: $('ai-instruction').value,
    });
  });
  $('btn-ai-local').addEventListener('click', () => {
    $('ai-status').textContent = '⏳ 本地提取中…';
    $('ai-result').hidden = true;
    vscode.postMessage({ type: 'generateCopy', platform: $('ai-platform').value, local: true });
  });
  $('btn-ai-copy').addEventListener('click', () => {
    if (!aiData) return;
    const platform = $('ai-platform').value;
    let text = '';
    if (platform === 'twitter' && aiData.tweets) {
      text = aiData.tweets.map((t, i) => `${i + 1}/${aiData.tweets.length}\n${t.body}`).join('\n\n');
      if (aiData.tags && aiData.tags.length) text += '\n\n' + aiData.tags.map((t) => '#' + t).join(' ');
    } else {
      text = [aiData.title, '', aiData.body, '', (aiData.tags || []).map((t) => '#' + t).join(' ')]
        .filter((x) => x !== undefined && x !== null).join('\n').trim();
    }
    navigator.clipboard.writeText(text).then(
      () => toast('✅ 文案已复制到剪贴板'),
      () => toast('复制失败', 'error'),
    );
  });

  function renderAiResult(platform, data) {
    aiData = data;
    $('ai-result').hidden = false;
    $('ai-title').value = data.title || '';
    $('ai-tags').value = (data.tags || []).join(', ');
    const bodyRow = $('ai-body-row');
    const tweetsBox = $('ai-tweets');
    if (platform === 'twitter' && data.tweets && data.tweets.length) {
      bodyRow.hidden = true;
      tweetsBox.innerHTML = data.tweets.map((t, i) => (
        `<div class="tweet"><div class="num">${i + 1}/${data.tweets.length}</div>` +
        `<textarea data-idx="${i}">${escapeHtml(t.body)}</textarea></div>`
      )).join('');
      tweetsBox.querySelectorAll('textarea').forEach((ta) => {
        ta.addEventListener('input', () => { aiData.tweets[+ta.dataset.idx].body = ta.value; });
      });
    } else {
      bodyRow.hidden = false;
      $('ai-body').value = data.body || '';
      tweetsBox.innerHTML = '';
    }
    $('ai-status').textContent = data.source === 'llm'
      ? '✅ AI 生成完成，可继续编辑后复制'
      : '✅ 本地提取完成（未调用模型），可继续编辑后复制';
  }

  // ── LLM 配置 ──────────────────────────────────────────
  let editingProfileId = '';
  $('llm-profile').addEventListener('change', () => loadProfile($('llm-profile').value));
  $('llm-new').addEventListener('click', () => {
    editingProfileId = '';
    $('llm-name').value = '';
    $('llm-baseurl').value = $('llm-baseurl').value;
    $('llm-model').value = '';
    $('llm-apikey').value = '';
    $('llm-key-hint').textContent = '(新配置)';
    $('llm-status').textContent = '';
  });
  $('llm-del').addEventListener('click', () => {
    if (editingProfileId) vscode.postMessage({ type: 'llmDeleteProfile', profileId: editingProfileId });
  });
  $('llm-save').addEventListener('click', () => {
    vscode.postMessage({
      type: 'llmSaveConfig',
      profileId: editingProfileId || undefined,
      name: $('llm-name').value,
      baseUrl: $('llm-baseurl').value,
      model: $('llm-model').value,
      apiKey: $('llm-apikey').value,
    });
    $('llm-apikey').value = '';
  });
  $('llm-test').addEventListener('click', () => {
    $('llm-status').textContent = '⏳ 正在测试连接…';
    vscode.postMessage({ type: 'llmTest', profileId: editingProfileId || undefined });
  });
  document.querySelectorAll('#llm-presets .chip').forEach((c) => {
    c.addEventListener('click', () => {
      $('llm-baseurl').value = c.dataset.base;
      $('llm-model').value = c.dataset.model;
    });
  });

  function loadProfile(id) {
    const p = llmState.profiles.find((x) => x.id === id);
    if (!p) return;
    editingProfileId = p.id;
    $('llm-name').value = p.name || '';
    $('llm-baseurl').value = p.baseUrl || '';
    $('llm-model').value = p.model || '';
    $('llm-apikey').value = '';
    $('llm-key-hint').textContent = p.hasKey ? '(已保存，留空不修改)' : '(未设置)';
    $('llm-status').textContent = '';
  }

  function renderLlmConfig(msg) {
    llmState = msg;
    const sel = $('llm-profile');
    sel.innerHTML = '';
    (msg.profiles || []).forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || p.model || p.id;
      if (p.id === msg.activeId) opt.selected = true;
      sel.appendChild(opt);
    });
    const activeId = msg.activeId || (msg.profiles[0] && msg.profiles[0].id) || '';
    if (activeId) { sel.value = activeId; loadProfile(activeId); }
  }

  // ── 扩展消息处理 ──────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'render': {
        currentBodyHtml = msg.bodyHtml || '';
        currentTitle = msg.title || '';
        $('preview-content').innerHTML = msg.bodyHtml || '';
        $('doc-title').textContent = currentTitle || '未命名';
        $('word-count').textContent = msg.wordCount ? `${msg.wordCount} 字` : '';
        if (msg.theme) applyTheme(msg.theme);
        break;
      }
      case 'themeList': {
        const sel = $('theme-select');
        sel.innerHTML = '';
        (msg.themes || []).forEach((t) => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name;
          sel.appendChild(opt);
        });
        if (msg.currentId) sel.value = msg.currentId;
        break;
      }
      case 'error': {
        $('preview-content').innerHTML = `<p style="color:#f88;font-family:monospace;">⚠️ 渲染错误：${escapeHtml(msg.message)}</p>`;
        break;
      }
      case 'syncToLine': {
        const headings = Array.from(document.querySelectorAll('#preview-content [data-source-line]'));
        if (!headings.length) break;
        let best = null;
        for (const el of headings) {
          if (parseInt(el.dataset.sourceLine, 10) <= msg.line) best = el;
        }
        const scroller = $('preview-scroll');
        scroller.scrollTo({ top: Math.max(0, (best ? best.offsetTop : 0) - 60), behavior: 'smooth' });
        break;
      }
      case 'wechatHtml': {
        setBusy('btn-copy-wechat', false);
        copyHtml(msg.html || '');
        break;
      }
      case 'zhihuHtml': {
        copyHtml(msg.html || '');
        break;
      }
      case 'xhsCopyHtml': {
        copyHtml(msg.html || '');
        break;
      }
      case 'xhsCapture': {
        renderXhs(msg).catch((err) => {
          $('xhs-output').innerHTML = `<p class="hint" style="color:#f88">❌ 生成失败：${escapeHtml(err.message)}</p>`;
          setBusy('btn-xhs-generate', false);
          toast('生成失败：' + err.message, 'error');
        });
        break;
      }
      case 'saveXhsDone': {
        setBusy('btn-xhs-export-all', false);
        toast(`✅ 已导出 ${msg.count} 张到 ${msg.dir}`, 'success');
        break;
      }
      case 'copyInstruction': {
        $('ai-instruction').value = msg.instruction || '';
        break;
      }
      case 'copyGenerating': {
        $('ai-status').textContent = '⏳ 正在调用 LLM…';
        break;
      }
      case 'copyResult': {
        renderAiResult(msg.platform, msg.data);
        break;
      }
      case 'copyError': {
        $('ai-status').textContent = '❌ ' + (msg.message || '生成失败');
        toast('生成失败：' + (msg.message || ''), 'error');
        break;
      }
      case 'llmConfig': {
        renderLlmConfig(msg);
        break;
      }
      case 'llmTestResult': {
        $('llm-status').textContent = (msg.ok ? '✅ ' : '❌ ') + msg.message;
        break;
      }
      case 'toast': {
        toast(msg.message || '', msg.kind);
        break;
      }
    }
  });

  // ── 初始化 ────────────────────────────────────────────
  applyZoom();
  vscode.postMessage({ type: 'ready' });
})();
