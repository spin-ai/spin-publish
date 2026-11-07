'use strict';

/**
 * lib/humanize.js — 中文文章「去 AI 味」检测器（JavaScript 版）
 *
 * 由 opencode-publisher 的 humanize-writing 技能（MIT）移植：
 *   publishers/humanize-writing/scripts/detector.py
 *
 * 纯本地规则，不联网、不调用模型。检测词面特征（开头套话、黑话、填充语、
 * 升华结尾、标题党……）与结构特征（段落长度是否过于均匀、列表/加粗密度）。
 *
 * 对外接口：
 *   analyze(text)                  -> report
 *   buildReport(text, source)      -> report
 *   renderTextReport(report)       -> string
 *   buildHumanizeInstruction(report, opts) -> string（可直接编辑的改写 prompt）
 *   grade(score)                   -> string
 */

const WEIGHTS = { high: 3, medium: 2, low: 1 };

const GRADE_BANDS = [
  [25, '自然（人味合格）'],
  [50, '有 AI 痕迹'],
  [75, 'AI 味明显'],
  [101, '浓厚 AI 味'],
];

// (pattern, category, severity, suggestion)
// 注意：pattern 不带 g，扫描时会克隆；中文内容统一按行匹配，不跨行。
const RULES = [
  // 开头：先铺宏大背景，再进正题
  { re: /在当今.{0,8}(快速发展|飞速发展|日新月异|瞬息万变)/u, category: '开头套话', severity: 'high', suggestion: '删掉宏大背景，第一句直接进入正题' },
  { re: /随着.{2,24}的(普及|发展|进步|推广|浪潮|深入|不断演进|广泛应用)/u, category: '开头套话', severity: 'high', suggestion: '删掉“随着…”式背景铺垫' },
  { re: /(近年来|当下|如今)，?.{0,10}(AI|人工智能|大模型|GPT)/u, category: '开头套话', severity: 'medium', suggestion: 'AI 话题开场几乎必是模板，换成具体问题或场景' },

  // 结尾：升华 / 客套 / 互动诱导
  { re: /在这个.{2,16}的(时代|今天|背景下)/u, category: '升华结尾', severity: 'high', suggestion: '删掉时代感慨，用一句实在话收尾' },
  { re: /让我们(一起|来|共同)(期待|努力|迎接|探索)/u, category: '升华结尾', severity: 'high', suggestion: '删掉“让我们”句式' },
  { re: /(希望|相信)(本文|这篇|以上|这篇文章?)(对你|对大家|对各位|对你有所)?帮?助?/u, category: '客套结尾', severity: 'high', suggestion: '换成资源链接，或直接删' },
  { re: /(总而言之|综上所述|总的来说|由此可见|综合来看)/u, category: '总结套话', severity: 'medium', suggestion: '删掉，直接给结论' },

  // 填充 / 犹疑
  { re: /(值得注意的是|值得一提的是|不得不说|需要指出的是|更重要的是)/u, category: '填充语', severity: 'medium', suggestion: '删掉提示语，直接陈述事实' },
  { re: /(众所周知|毋庸置疑|不言而喻|显然)/u, category: '套话', severity: 'medium', suggestion: '删掉；真的人尽皆知就无需说' },
  { re: /(简单来说|换句话说|也就是说)[，,]/u, category: '解释填充', severity: 'low', suggestion: '偶尔可以，连续出现就是模板感' },

  // 机械连接词 / 排比
  { re: /(首先|其次|再次|最后)[，,、]/u, category: '机械连接词', severity: 'medium', suggestion: '去掉序号词，用内容自然衔接' },
  { re: /(一方面|另一方面)[，,]/u, category: '机械连接词', severity: 'low', suggestion: '拆开写，别成对出现' },
  { re: /不仅.{2,36}[，,](而且|还)/u, category: '排比结构', severity: 'low', suggestion: '拆成两句，或只留一半' },

  // 黑话
  { re: /(赋能|抓手|闭环|颗粒度|打法|沉淀|拉通|底层逻辑|顶层设计|组合拳|方法论|心智|壁垒|护城河)/u, category: '黑话', severity: 'medium', suggestion: '换成大白话' },

  // 标题党 / 营销腔
  { re: /(深度解析|深度剖析|全面解析|深入探讨|一文读懂|一文吃透|一文搞懂|保姆级|手把手|小白也能|看这一篇就够了)/u, category: '标题党', severity: 'high', suggestion: '换成朴素、具体的标题' },
  { re: /(干货|精华|宝藏|绝了|yyds|吊打|碾压)/u, category: '营销腔', severity: 'medium', suggestion: '删掉或换成对内容的客观描述' },

  // 空泛程度词 / 模糊量化
  { re: /(极大地|显著地|有效地|充分地|大幅(度)?(提升|提高|优化|降低))/u, category: '空泛程度词', severity: 'medium', suggestion: '用具体数字替代（快了 40%？省了 3 倍？）' },
  { re: /(非常|十分|极其|相当|超级)/u, category: '程度副词', severity: 'low', suggestion: '删掉或换成具体程度' },
  { re: /(很多|大量|不少)(情况|时候|场景)下?/u, category: '模糊量化', severity: 'medium', suggestion: '换成具体条件（在 5 万 QPS 以上时？）' },

  // emoji
  { re: /[\u{1F300}-\u{1FAFF}\u2705\u274C\u2728\u2753\u2757\u2714\u2716\u2B50]/u, category: 'emoji', severity: 'low', suggestion: '按目标平台规范删减；正文堆 emoji 是强 AI 信号' },
];

const BULLET_PATTERN = /^\s*([-*+]|\d+[.)])\s/;
const PARAGRAPH_SKIP_PREFIXES = ['#', '-', '*', '>', '|', '```', '!'];
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

function grade(score) {
  for (const [threshold, label] of GRADE_BANDS) {
    if (score < threshold) return label;
  }
  return GRADE_BANDS[GRADE_BANDS.length - 1][1];
}

function scanHits(text) {
  const hits = [];
  let fenceChar = null;
  let fenceLen = 0;
  const lines = String(text == null ? '' : text).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE_LINE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fenceChar === null) {
        fenceChar = marker[0];
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = null;
      }
      continue;
    }
    if (fenceChar !== null) continue; // 代码块是引用材料，不算作者口吻

    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
      let match;
      while ((match = re.exec(line)) !== null) {
        hits.push({
          line: i + 1,
          category: rule.category,
          severity: rule.severity,
          excerpt: match[0].slice(0, 40),
          suggestion: rule.suggestion,
        });
        if (match[0] === '') re.lastIndex++;
      }
    }
  }
  return hits;
}

function analyzeStructure(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const nonempty = lines.filter((line) => line.trim());
  const paragraphs = String(text == null ? '' : text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const proseLengths = paragraphs
    .filter((p) => !PARAGRAPH_SKIP_PREFIXES.some((prefix) => p.startsWith(prefix)))
    .map((p) => p.length);

  const structure = {
    bullet_ratio: 0,
    paragraph_cv: null,
    bold_count: (String(text == null ? '' : text).match(/\*\*[^*\n]+\*\*/g) || []).length,
  };

  if (nonempty.length) {
    const bulletLines = nonempty.filter((line) => BULLET_PATTERN.test(line)).length;
    structure.bullet_ratio = Math.round((bulletLines / nonempty.length) * 1000) / 1000;
  }
  if (proseLengths.length >= 4) {
    const mean = proseLengths.reduce((a, b) => a + b, 0) / proseLengths.length;
    const variance = proseLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / proseLengths.length;
    const std = Math.sqrt(variance);
    structure.paragraph_cv = mean ? Math.round((std / mean) * 1000) / 1000 : 0;
  }
  return structure;
}

function computeScore(hits, charCount, structure) {
  if (!charCount) return { score: 0, density: 0, penalties: [] };

  const weighted = hits.reduce((sum, hit) => sum + (WEIGHTS[hit.severity] || 0), 0);
  const density = weighted / (charCount / 1000);
  let score = density * 6;
  const penalties = [];

  if (structure.paragraph_cv !== null && structure.paragraph_cv < 0.25) {
    score += 8;
    penalties.push('段落长度过于均匀（变异系数 < 0.25），像模板生成');
  }
  if (structure.bullet_ratio > 0.4) {
    score += 5;
    penalties.push(`列表行占比 ${Math.round(structure.bullet_ratio * 100)}%，过高`);
  }
  if (structure.bold_count > charCount / 200) {
    score += 4;
    penalties.push(`加粗 ${structure.bold_count} 处，密度过高`);
  }

  return {
    score: Math.min(100, Math.round(score)),
    density: Math.round(density * 100) / 100,
    penalties,
  };
}

function buildReport(text, source) {
  const content = String(text == null ? '' : text);
  const charCount = content.replace(/\s/g, '').length;
  const hits = scanHits(content);
  const structure = analyzeStructure(content);
  const scoring = computeScore(hits, charCount, structure);

  const byCategory = {};
  for (const hit of hits) {
    if (!byCategory[hit.category]) {
      byCategory[hit.category] = { count: 0, severity: hit.severity };
    }
    byCategory[hit.category].count += 1;
  }

  const topSuggestions = hits
    .slice()
    .sort((a, b) => {
      const diff = (WEIGHTS[b.severity] || 0) - (WEIGHTS[a.severity] || 0);
      return diff !== 0 ? diff : a.line - b.line;
    })
    .slice(0, 8);

  return {
    source: source || '(selection)',
    char_count: charCount,
    score: scoring.score,
    grade: grade(scoring.score),
    density_per_1000: scoring.density,
    total_hits: hits.length,
    by_category: byCategory,
    structure,
    structure_penalties: scoring.penalties,
    top_suggestions: topSuggestions,
    hits,
  };
}

function analyze(text, source) {
  return buildReport(text, source);
}

function renderTextReport(report) {
  const lines = [
    `AI 味检测报告: ${report.source}`,
    `分数: ${report.score}/100（${report.grade}）`,
    `正文 ${report.char_count} 字，加权命中密度 ${report.density_per_1000}/千字，命中 ${report.total_hits} 处`,
    '',
    '分类命中:',
  ];

  const categories = Object.entries(report.by_category).sort((a, b) => {
    const diff = (WEIGHTS[b[1].severity] || 0) - (WEIGHTS[a[1].severity] || 0);
    return diff !== 0 ? diff : b[1].count - a[1].count;
  });
  for (const [category, entry] of categories) {
    lines.push(`  ${category}: ${entry.count} 处 [${entry.severity}]`);
  }

  lines.push('', '结构指标:');
  const s = report.structure;
  lines.push(
    `  段落长度变异系数: ${s.paragraph_cv === null ? '样本不足' : s.paragraph_cv}` +
    (s.paragraph_cv !== null && s.paragraph_cv < 0.25 ? '（过于均匀）' : ''),
  );
  lines.push(
    `  列表行占比: ${Math.round(s.bullet_ratio * 100)}%` +
    (s.bullet_ratio > 0.4 ? '（过高）' : ''),
  );
  lines.push(`  加粗: ${s.bold_count} 处`);
  for (const penalty of report.structure_penalties) lines.push(`  ⚠ ${penalty}`);

  if (report.top_suggestions.length) {
    lines.push('', '优先改写建议:');
    report.top_suggestions.forEach((hit, index) => {
      lines.push(`  ${index + 1}. 第 ${hit.line} 行 “${hit.excerpt}” → ${hit.suggestion}`);
    });
  }
  return lines.join('\n');
}

/**
 * 生成一份可直接编辑的「去 AI 味」改写指令。
 * 检测报告只作为参考，不要求模型逐条机械替换。
 */
function buildHumanizeInstruction(report, opts) {
  const targetScore = Number.isFinite(opts && opts.targetScore) ? opts.targetScore : 25;
  const platform = (opts && opts.platform) || '';

  const lines = [
    '你是中文技术作者，帮我把下面这篇稿子改得像人写的（去 AI 味），而不是重写一篇新文章。',
    '',
    '【红线（先读这个）】',
    '1. 不改事实：技术内容、数据、结论、代码、术语一律不改变含义，只动表达方式。',
    '2. 不编造：所有新增的“人味细节”（具体数字、经历、踩坑）必须来自原文或我提供的信息；缺素材时写 `[待补：真实细节——比如具体版本号/耗时/报错]`，绝不替我编。',
    '3. 保留作者的术语和口癖：作者本来怎么说就怎么说，改写不是统一腔调。',
    '4. 代码块、图片引用、链接、LaTeX 公式必须原样保留，一个字符都不要改；可以用 `[原文]` 标注不确定的地方。',
    '',
    '【改写重点】',
    '- 删掉宏大开场、套话、填充语、机械连接词、升华结尾和空洞总结；第一句直接进入具体问题或结论。',
    '- 让段落长短有起伏：允许一句话成段，把几个中庸段落合并再拆开，别让每段都一样长。',
    '- 降低列表和加粗密度：列表只留真正的枚举（配置项、命令、版本号），其余展开成连贯段落。',
    '- 把“很多/大量/显著/极大地”换成具体数字或条件；原文没有就标 `[待补]`。',
    '- 有立场就写明白，有取舍就承认缺点；不要两边讨好。',
    '- 允许口语、插入语、破折号打断句；别为了“顺滑”把文章磨成模板。',
    '- 删掉没有信息量的段落：删掉它读者没有损失，就整段删。',
  ];

  if (report) {
    lines.push('', '【检测结果（仅作参考，不要机械逐条替换）】');
    lines.push(`当前 AI 味分数：${report.score}/100（${report.grade}），命中 ${report.total_hits} 处。`);
    const top = (report.top_suggestions || []).slice(0, 6);
    if (top.length) {
      lines.push('优先处理：');
      for (const hit of top) {
        lines.push(`- 第 ${hit.line} 行 “${hit.excerpt}”：${hit.suggestion}`);
      }
    }
    if (report.structure_penalties && report.structure_penalties.length) {
      lines.push('结构问题：');
      for (const penalty of report.structure_penalties) lines.push(`- ${penalty}`);
    }
  }

  lines.push('', `【目标】把 AI 味分数降到 ${targetScore} 以下，且不要留下 high 级问题。`);
  if (platform) lines.push(`【平台】这篇会发到 ${platform}，按该平台的表达习惯微调。`);
  lines.push(
    '',
    '【输出要求】只输出改写后的 Markdown 全文（或我选中的片段），不要解释、不要前言后记、不要用代码围栏包住整篇。',
    '保留原有 front matter、标题层级和段落顺序；如果必须调整结构，也只在原文范围内调整。',
  );

  return lines.join('\n');
}

module.exports = {
  RULES,
  WEIGHTS,
  GRADE_BANDS,
  grade,
  scanHits,
  analyzeStructure,
  computeScore,
  buildReport,
  analyze,
  renderTextReport,
  buildHumanizeInstruction,
};
