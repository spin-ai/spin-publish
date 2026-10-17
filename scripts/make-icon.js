'use strict';
/**
 * scripts/make-icon.js — 生成扩展图标 media/icon.png
 *
 * 无第三方依赖：用超采样 + 纯 JS 光栅化几何图形，再手写 PNG 编码。
 * 设计：翡翠→深青渐变圆角方块 + 白色纸飞机（发布/发送）+ 折痕。
 *
 * 用法：node scripts/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_PNG = path.join(ROOT, 'media', 'icon.png');
const OUT_SVG = path.join(ROOT, 'media', 'icon.svg');

const N = 128;          // 输出尺寸
const SS = 4;           // 超采样倍数
const S = N * SS;       // 内部画布
const RADIUS = 28;      // 圆角
const BORDER = 1.1;     // 内描边宽度

// 渐变（135°）
const C0 = [0x22, 0xb5, 0x73]; // 翡翠绿
const C1 = [0x0a, 0x6b, 0x7c]; // 深青

// 纸飞机（Feather "send" 的 24 格坐标）
const P_SCALE = 3.6;
const P_OFF = 20.8;
const PLANE = [[22, 2], [15, 22], [11, 13], [2, 9]];
const CREASE = [[22, 2], [11, 13]];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function toCanvas([x, y]) {
  return [x * P_SCALE + P_OFF, y * P_SCALE + P_OFF];
}

function insideRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = clamp(x, r, w - r);
  const cy = clamp(y, r, h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insidePolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

// 光栅化到 S×S 的 RGBA buffer
const buf = Buffer.alloc(S * S * 4, 0);
const planePts = PLANE.map(toCanvas);
const creaseA = toCanvas(CREASE[0]);
const creaseB = toCanvas(CREASE[1]);
const creaseHalf = (0.85 * P_SCALE) / 2;

for (let py = 0; py < S; py++) {
  for (let px = 0; px < S; px++) {
    // 内部坐标 → 128 世界坐标
    const x = (px + 0.5) / SS;
    const y = (py + 0.5) / SS;
    const i = (py * S + px) * 4;

    // 圆角方块（含 1.1px 内描边）
    const outer = insideRoundedRect(x, y, N, N, RADIUS);
    if (!outer) continue;
    const inner = insideRoundedRect(x, y, N, N, RADIUS - BORDER);

    // 135° 渐变
    const t = clamp((x / N + y / N) / 2, 0, 1);
    let r = Math.round(lerp(C0[0], C1[0], t));
    let g = Math.round(lerp(C0[1], C1[1], t));
    let b = Math.round(lerp(C0[2], C1[2], t));

    if (!inner) {
      // 内描边：向白色提亮
      r = Math.round(lerp(r, 255, 0.18));
      g = Math.round(lerp(g, 255, 0.18));
      b = Math.round(lerp(b, 255, 0.18));
    } else {
      // 顶部柔光
      const gloss = 0.10 * clamp(1 - y / (N * 0.6), 0, 1);
      r = Math.round(lerp(r, 255, gloss));
      g = Math.round(lerp(g, 255, gloss));
      b = Math.round(lerp(b, 255, gloss));

      // 白色纸飞机
      if (insidePolygon(x, y, planePts)) {
        const d = distToSegment(x, y, creaseA[0], creaseA[1], creaseB[0], creaseB[1]);
        if (d <= creaseHalf) {
          // 折痕：用背景青色调压暗
          r = Math.round(lerp(255, C1[0], 0.34));
          g = Math.round(lerp(255, C1[1], 0.34));
          b = Math.round(lerp(255, C1[2], 0.34));
        } else {
          r = 255; g = 255; b = 255;
        }
      }
    }

    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
}

// 盒式下采样 S → N
const out = Buffer.alloc(N * N * 4, 0);
const factor = SS * SS;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const si = ((y * SS + sy) * S + (x * SS + sx)) * 4;
        const sa = buf[si + 3] / 255;
        r += buf[si] * sa; g += buf[si + 1] * sa; b += buf[si + 2] * sa; a += sa;
      }
    }
    const di = (y * N + x) * 4;
    if (a > 0) {
      out[di] = Math.round(r / a);
      out[di + 1] = Math.round(g / a);
      out[di + 2] = Math.round(b / a);
    }
    out[di + 3] = Math.round((a / factor) * 255);
  }
}

// ── PNG 编码 ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// 每行前置 filter 字节 0
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  out.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(OUT_PNG, png);

// 同时输出 SVG 源文件（便于以后修改/换色）
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22b573"/>
      <stop offset="1" stop-color="#0a6b7c"/>
    </linearGradient>
  </defs>
  <rect x="${BORDER / 2}" y="${BORDER / 2}" width="${N - BORDER}" height="${N - BORDER}" rx="${RADIUS}"
        fill="url(#g)" stroke="rgba(255,255,255,0.18)" stroke-width="${BORDER}"/>
  <g transform="translate(${P_OFF} ${P_OFF}) scale(${P_SCALE})">
    <polygon points="${PLANE.map((p) => p.join(',')).join(' ')}" fill="#fff"/>
    <line x1="${CREASE[0][0]}" y1="${CREASE[0][1]}" x2="${CREASE[1][0]}" y2="${CREASE[1][1]}"
          stroke="#0a6b7c" stroke-opacity="0.34" stroke-width="0.85" stroke-linecap="round"/>
  </g>
</svg>
`;
fs.writeFileSync(OUT_SVG, svg, 'utf8');

console.log(`✅ 已生成 ${path.relative(ROOT, OUT_PNG)} (${N}×${N}, ${png.length} bytes)`);
console.log(`✅ 已生成 ${path.relative(ROOT, OUT_SVG)}`);
