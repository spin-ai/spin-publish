'use strict';
/**
 * 去 AI 味检测器 / 发布命令构造测试：
 *   node test/humanize.test.js
 */
const assert = require('assert');
const path = require('path');
const humanize = require('../lib/humanize');
const publishers = require('../lib/publishers');

const aiText = [
  '# 深度解析：在当今快速发展的时代',
  '',
  '在当今快速发展的时代，随着人工智能技术的普及，值得注意的是，首先，我们要赋能业务，形成闭环。',
  '',
  '这不仅极大地提升了效率，而且显著地降低了成本。总而言之，希望本文对你有帮助。',
].join('\n');

const humanText = [
  '# 把服务迁到 k8s 踩的三个坑',
  '',
  '上周三凌晨两点，监控报警。我爬起来看日志，发现是 readinessProbe 配错了。',
  '',
  '改完已经三点半。第二天又遇到 PVC 挂载失败，折腾到中午。',
].join('\n');

const report = humanize.buildReport(aiText, 'ai.md');
assert.ok(report.score > 0, 'AI 文本分数应大于 0');
assert.ok(report.total_hits >= 4, 'AI 文本应命中多条规则');
assert.ok(report.by_category['开头套话'], '应识别开头套话');
assert.ok(report.by_category['黑话'], '应识别黑话');
assert.ok(report.top_suggestions.length > 0, '应给出优先改写建议');
console.log(`✓ AI 味检测：score=${report.score}, hits=${report.total_hits}`);

const humanReport = humanize.buildReport(humanText, 'human.md');
assert.ok(humanReport.score < report.score, '人味文本分数应低于模板文本');
console.log(`✓ 人味文本分数更低：${humanReport.score} < ${report.score}`);

// 代码块里的词不应计入
const fenced = '```js\n// 在当今快速发展的时代，值得注意的是\n```\n';
assert.strictEqual(humanize.buildReport(fenced, 'code.md').total_hits, 0, '代码围栏内容不应命中');
console.log('✓ 代码围栏不参与检测');

// 结构惩罚：四段长度几乎一致
const uniform = ['aaaa', 'bbbb', 'cccc', 'dddd'].map((s) => s + '这是一段长度几乎一样的文字。').join('\n\n');
const uniformReport = humanize.buildReport(uniform, 'uniform.md');
assert.ok(uniformReport.structure.paragraph_cv < 0.25, '应识别出段落长度过于均匀');
assert.ok(uniformReport.structure_penalties.length >= 1, '应给出结构惩罚');
console.log('✓ 结构检测（段落节奏 / 列表 / 加粗）');

const instruction = humanize.buildHumanizeInstruction(report, { targetScore: 20 });
assert.ok(instruction.includes('红线'), '改写指令应包含红线');
assert.ok(instruction.includes(String(report.score)), '改写指令应包含当前分数');
assert.ok(instruction.includes('20'), '改写指令应包含目标分数');
assert.ok(instruction.includes('只输出改写后的 Markdown'), '改写指令应约束输出格式');
console.log('✓ 改写 prompt 生成');

const textReport = humanize.renderTextReport(report);
assert.ok(textReport.includes('AI 味检测报告'), '文本报告标题缺失');
assert.ok(textReport.includes('优先改写建议'), '文本报告缺少建议');
console.log('✓ 文本报告生成');

// ── 发布命令构造 ──
assert.strictEqual(publishers.getPublisher('zhihu').name, '知乎');
assert.strictEqual(publishers.getPublisher('toutiao').name, '今日头条');
const extUri = { fsPath: '/tmp/ext' };
const cmd = publishers.buildPublisherCommand({
  extensionUri: extUri,
  platform: 'zhihu',
  python: '/usr/bin/python3',
  action: 'manual',
  options: { contentFile: '/tmp/a.md', cover: '/tmp/c.png', column: '我的专栏' },
});
assert.ok(cmd.includes("'/usr/bin/python3'"), '命令应包含 Python');
assert.ok(cmd.includes('zhihu-publisher'), '命令应指向知乎技能');
assert.ok(cmd.includes("'--mode' 'manual'"), '命令应带 manual 模式');
assert.ok(cmd.includes("'--column' '我的专栏'"), '命令应带专栏');
assert.ok(cmd.includes("'--content-file' '/tmp/a.md'"), '命令应带 Markdown 路径');
console.log('✓ 发布命令构造（知乎）');

const loginCmd = publishers.buildPublisherCommand({
  extensionUri: extUri,
  platform: 'toutiao',
  python: 'python3',
  action: 'login',
});
assert.ok(loginCmd.includes('toutiao-publisher'), '登录命令应指向头条技能');
assert.ok(loginCmd.includes("'setup' '--json'"), '登录命令参数缺失');
console.log('✓ 登录命令构造（头条）');

const args = publishers.buildPublisherArgs('toutiao', {
  mode: 'auto', contentFile: '/tmp/a.md', headless: true, noCover: true,
});
assert.ok(args.includes('--headless') && args.includes('--no-cover'), '头条参数缺失');
console.log('✓ 发布参数构造');

console.log('\n🎉 去 AI 味 / 发布适配测试全部通过');
