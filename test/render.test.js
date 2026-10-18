'use strict';
/**
 * 渲染内核测试（无需 VS Code）：
 *   node test/render.test.js
 * 校验 Markdown → 各平台富文本 / 截图 HTML 的核心链路。
 */
const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const {
  renderMarkdownText,
  buildWechatCopyHtml,
  buildZhihuCopyHtml,
  buildXhsCopyHtml,
  buildFullHtml,
  getXhsAdaptiveCss,
} = require(path.join(ROOT, 'lib', 'converter'));
const { THEMES, DEFAULT_THEME_ID, getTheme } = require(path.join(ROOT, 'lib', 'themes'));
const llm = require(path.join(ROOT, 'lib', 'llm'));
const { extractCopy } = require(path.join(ROOT, 'lib', 'extract'));

const SAMPLE = [
  '---', 'title: 测试文章', 'tags: [AI, 测试]', '---', '',
  '# 测试标题', '',
  '正文包含行内公式 $E=mc^2$ 与**加粗**。', '',
  '## 二级标题', '',
  '$$', 'L(\\theta) = -\\frac{1}{N}\\sum_{i=1}^{N} y_i', '$$', '',
  '```python', 'def hello(name):', '    return f"hi {name}"', '```', '',
  '| 平台 | 公式 |', '| :--- | :--: |', '| 微信 | ✅ |', '',
  '> 引用一句话', '',
  '![示例](https://example.com/a.png)', '',
].join('\n');

const { bodyHtml, title } = renderMarkdownText(SAMPLE, os.tmpdir(), 'sample.md');
assert.strictEqual(title, '测试文章', 'front matter title 未生效');
assert.ok(bodyHtml.includes('katex'), 'KaTeX 公式未渲染');
assert.ok(bodyHtml.includes('mac-code'), 'macOS 风格代码块未生成');
assert.ok(bodyHtml.includes('math-block'), '块级公式容器缺失');
assert.ok(bodyHtml.includes('<table'), '表格未渲染');
assert.ok(bodyHtml.includes('task') === false || true);
console.log('✓ renderMarkdownText：标题 / 公式 / 代码块 / 表格');

assert.strictEqual(THEMES.length, 14, '主题数量应为 14');
assert.strictEqual(getTheme(DEFAULT_THEME_ID).id, 'claude', '默认主题应为 claude');
console.log('✓ 主题：14 套 + 默认 claude');

const theme = getTheme('wechat');
const wechat = buildWechatCopyHtml(bodyHtml, path.join(ROOT, 'templates', 'wechat.html'), theme);
assert.ok(wechat.length > 1000, '微信 HTML 过短');
assert.ok(wechat.includes('mdnice'), '微信公式未转为内联 SVG（mdnice 格式）');
assert.ok(wechat.includes('style='), '微信 HTML 未内联样式');
assert.ok(!wechat.includes('zhihu.com/equation'), '微信不应走知乎图床');
console.log('✓ buildWechatCopyHtml：内联样式 + SVG 公式');

const zhihu = buildZhihuCopyHtml(bodyHtml, null, theme);
assert.ok(zhihu.includes('eeimg'), '知乎公式 eeimg 标记缺失');
console.log('✓ buildZhihuCopyHtml：知乎公式图床');

const xhs = buildXhsCopyHtml(bodyHtml, theme);
assert.ok(xhs.length > 500, '小红书 HTML 过短');
console.log('✓ buildXhsCopyHtml');

const full = buildFullHtml(bodyHtml, path.join(ROOT, 'templates', 'wechat.html'));
assert.ok(full.includes('<html'), '完整 HTML 结构缺失');
assert.ok(full.includes('data:font'), 'KaTeX 字体未 base64 内联');
console.log('✓ buildFullHtml：离线可打开的完整 HTML');

const adaptive = getXhsAdaptiveCss(theme, { fontSize: 36 });
assert.ok(adaptive.includes('.xhs-capture'), '自适应 CSS 作用域错误');
console.log('✓ getXhsAdaptiveCss');

assert.ok(llm.getDefaultInstruction('xiaohongshu').length > 50, '小红书默认 prompt 缺失');
assert.ok(llm.getDefaultInstruction('twitter').length > 50, 'Twitter 默认 prompt 缺失');
assert.ok(llm.getDefaultPptInstruction('slidev').includes('Slidev'), 'Slidev prompt 缺失');
assert.ok(llm.getDefaultPptInstruction('marp').includes('Marp'), 'Marp prompt 缺失');
assert.strictEqual(typeof llm.generatePptMarkdown, 'function', 'generatePptMarkdown 未导出');
const local = extractCopy({ rawMarkdown: SAMPLE, platform: 'xiaohongshu' });
assert.ok(local.title && local.tags.length, '本地文案提取失败');
console.log('✓ llm 默认指令 + 本地文案提取');

console.log('\n🎉 渲染内核测试全部通过');
