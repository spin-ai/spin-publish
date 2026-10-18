'use strict';
/**
 * 选区 AI 改写 / 去 AI 味 LLM 管线测试：
 *   node test/rewrite.test.js
 *
 * 用本地 HTTP 服务器模拟 OpenAI 兼容接口，验证：
 *   - 预设完整性
 *   - prompt 是否带上选区、上下文、指令
 *   - 整段代码围栏是否被清理
 *   - 未配置 / 空输入的可操作错误
 */
const assert = require('assert');
const http = require('http');
const llm = require('../lib/llm');

function startFakeLlm(reply) {
  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
      captured.push({ url: req.url, headers: req.headers, payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: reply } }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, captured, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

(async () => {
  // ── 预设完整性 ──
  assert.ok(llm.REWRITE_PRESETS.length >= 9, '改写预设数量不足');
  const ids = new Set();
  for (const preset of llm.REWRITE_PRESETS) {
    assert.ok(preset.id && !ids.has(preset.id), `预设 id 重复或缺失: ${preset.id}`);
    ids.add(preset.id);
    assert.ok(preset.label, `预设缺少 label: ${preset.id}`);
    if (preset.id !== 'custom') {
      assert.ok(preset.instruction && preset.instruction.length > 10, `预设缺少 instruction: ${preset.id}`);
    }
  }
  for (const id of ['humanize', 'polish', 'concise', 'expand', 'casual', 'formal', 'proofread', 'translate-en', 'custom']) {
    assert.ok(ids.has(id), `缺少预设: ${id}`);
  }
  assert.strictEqual(llm.getRewritePreset('humanize').id, 'humanize');
  assert.strictEqual(llm.getRewritePreset('nope'), null);
  console.log(`✓ 改写预设完整（${llm.REWRITE_PRESETS.length} 个）`);

  // ── 参数校验（不发起网络请求） ──
  await assert.rejects(
    llm.rewriteText({ text: '   ', instruction: '润色', config: {} }),
    /选中的内容为空/,
  );
  await assert.rejects(
    llm.rewriteText({ text: '原句', instruction: '', config: {} }),
    /改写要求不能为空/,
  );
  await assert.rejects(
    llm.rewriteText({ text: '原句', instruction: '润色', config: { baseUrl: '', model: 'm' } }),
    /未配置 LLM 接口地址/,
  );
  await assert.rejects(
    llm.humanizeMarkdown({ rawMarkdown: '', instruction: '去 AI 味', config: {} }),
    /待改写的正文为空/,
  );
  await assert.rejects(
    llm.humanizeMarkdown({ rawMarkdown: '正文', instruction: '', config: {} }),
    /改写指令不能为空/,
  );
  console.log('✓ 空输入 / 未配置 LLM 的错误提示');

  // ── 选区改写：prompt + 围栏清理 ──
  const fake = await startFakeLlm('```markdown\n改写后的句子。\n```');
  try {
    const result = await llm.rewriteText({
      text: '这是一段需要改写的原句。',
      instruction: '改得更口语一点',
      context: '标题：测试文章\n\n【选区前文】\n前文\n\n【选区后文】\n后文',
      config: { baseUrl: fake.baseUrl, apiKey: '', model: 'fake-model' },
    });
    assert.strictEqual(result, '改写后的句子。', '改写结果应去掉整段代码围栏');

    const call = fake.captured[0];
    assert.strictEqual(call.url, '/v1/chat/completions', '应调用 OpenAI 兼容路径');
    assert.strictEqual(call.payload.model, 'fake-model');
    assert.ok(call.payload.messages[0].content.includes('只输出改写后的文字'), 'system prompt 缺少约束');
    const user = call.payload.messages[1].content;
    assert.ok(user.includes('这是一段需要改写的原句。'), '缺少待改写内容');
    assert.ok(user.includes('改得更口语一点'), '缺少改写要求');
    assert.ok(user.includes('标题：测试文章'), '缺少文章上下文');
    assert.ok(user.includes('【选区前文】'), '缺少选区前文');
    console.log('✓ rewriteText：上下文 / 指令 / 围栏清理');

    // ── 去 AI 味：prompt + 返回 Markdown ──
    fake.captured.length = 0;
    const markdown = await llm.humanizeMarkdown({
      rawMarkdown: '# 标题\n\n在当今快速发展的时代，值得注意的是……',
      instruction: '删掉套话，改得像人写的，保留 Markdown。',
      config: { baseUrl: fake.baseUrl, apiKey: '', model: 'fake-model' },
    });
    assert.strictEqual(markdown, '改写后的句子。');
    const humanCall = fake.captured[0];
    assert.ok(humanCall.payload.messages[0].content.includes('只输出改写后的 Markdown'), 'system prompt 缺少 Markdown 约束');
    assert.ok(humanCall.payload.messages[0].content.includes('front matter'), 'system prompt 缺少 front matter 保护');
    assert.ok(humanCall.payload.messages[1].content.includes('在当今快速发展的时代'), '缺少待改写正文');
    assert.ok(humanCall.payload.messages[1].content.includes('删掉套话'), '缺少改写指令');
    console.log('✓ humanizeMarkdown：Markdown / front matter / 指令');
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }

  // ── 本地端点不要求 Key ──
  assert.strictEqual(llm.isLocalEndpoint('http://localhost:11434/v1'), true);
  assert.strictEqual(llm.isLocalEndpoint('https://api.deepseek.com/v1'), false);
  console.log('✓ 本地端点识别');

  console.log('\n🎉 选区 AI 改写 / 去 AI 味管线测试全部通过');
})().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
