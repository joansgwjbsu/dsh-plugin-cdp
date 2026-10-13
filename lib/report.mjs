/**
 * dsh-plugin-cdp — 纯文本可视化报告（弹窗 / 聊天友好）
 *
 * 用途：把 DashboardPayload（见 contract.mjs）渲染成可直接贴在弹窗或聊天里的
 * 文本图表：Unicode 条形图、火花线、等宽明细表。
 *
 * 设计约束：
 *   1. 零依赖：只 import 同目录的 contract.mjs 取枚举与契约版本，其余全是字符串拼接。
 *   2. 不输出 ANSI 颜色转义 —— 弹窗不保证支持，颜色只会变成乱码。
 *   3. 一切对齐都按「显示宽度」算：CJK / 全角 / emoji 记 2 列，组合符记 0 列。
 *      等宽字体下 CJK 恰好是 ASCII 的两倍宽，所以这套算法成立。
 *   4. 任何字段缺失、salaryMin 为 null、空数组都降级为占位符；绝不让
 *      NaN / undefined / null 这几个字面量出现在用户看的文本里。
 *
 * 两个入口（签名固定，lib/index.mjs 依赖）：
 *   renderBrief(payload, opts) -> string   紧凑概览，≤ 25 行
 *   renderFull(payload, opts)  -> string   完整报告，含明细表
 */

import { DECISIONS, LOG_EVENT_KINDS, PLATFORMS, SCHEMA_VERSION } from "./contract.mjs";

// ───────────────────────────── 基础工具 ─────────────────────────────

/** 组合符 / 零宽字符：不占列。 */
const ZERO_WIDTH_RE = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufe00-\ufe0f\ufeff]/;

/**
 * 东亚宽字符（East Asian Width = W/F）与 emoji：占 2 列。
 * 只列常用区间，宁可漏判也不误判 ASCII。
 */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、康熙部首、CJK 符号（不含 0x303f）
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、注音、CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xa960 && cp <= 0xa97f) || // 谚文字母扩展 A
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe10 && cp <= 0xfe19) || // 竖排标点
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // 交通/地图类 emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // emoji 补充
    (cp >= 0x1fa70 && cp <= 0x1faff) || // 新版 emoji
    // BMP 里 EAW 明确为宽（W）的常见符号，避免 ✅ ⚡ ⌚ 之类被算成 1 列
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以上
  );
}

/**
 * 字符串在等宽终端里占用的列数。
 *
 * 宽窄判定约定（与多数终端及 string-width 默认一致）：
 *   - 东亚宽字符（CJK / 全角 / 谚文 / emoji）算 2 列；
 *   - 组合符、零宽字符、变体选择符（U+FE0E/FE0F，如 `⚠️` 的第二个码点）算 0 列；
 *   - 其余（含 `█ ░ ▁▂▃▄▅▆▇ │ ─ ┼ … ·`）算 1 列。
 * 注意 `…` 与 `·` 属于 East Asian Width = Ambiguous：本模块按「窄」处理，
 * 这与 VS Code 集成终端、Windows Terminal、iTerm2 默认设置一致；
 * 若在把 Ambiguous 渲染成双宽的 CJK 终端里显示，`…`/`·` 会导致列偏移。
 *
 * @param {unknown} input
 * @returns {number}
 */
export function displayWidth(input) {
  const s = input === null || input === undefined ? "" : String(input);
  let w = 0;
  let prev = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // U+FE0F（VS16）= 要求 emoji 呈现：把前一个字符补成 2 列；
    // U+FE0E（VS15）= 要求文本呈现：本身不占列，也不改变前一个字符。
    if (cp === 0xfe0f) {
      if (prev === 1) w += 1;
      prev = 2;
      continue;
    }
    if (cp === 0xfe0e) continue;
    if (ZERO_WIDTH_RE.test(ch)) continue;
    const cw = isWideCodePoint(cp) ? 2 : 1;
    w += cw;
    prev = cw;
  }
  return w;
}

/**
 * 显示宽度版 padEnd：把字符串补到指定显示宽度（不会截断）。
 * @param {unknown} input
 * @param {number} width
 * @param {string} [fill]
 * @returns {string}
 */
export function padEndW(input, width, fill = " ") {
  const s = input === null || input === undefined ? "" : String(input);
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const cur = displayWidth(s);
  return cur >= w ? s : s + fill.repeat(w - cur);
}

/**
 * 显示宽度版 padStart（右对齐数字用）。
 * @param {unknown} input
 * @param {number} width
 * @param {string} [fill]
 * @returns {string}
 */
export function padStartW(input, width, fill = " ") {
  const s = input === null || input === undefined ? "" : String(input);
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const cur = displayWidth(s);
  return cur >= w ? s : fill.repeat(w - cur) + s;
}

/**
 * 把字符串切成「字素簇」：基字符 + 紧随其后的组合符/零宽符/变体选择符。
 * 截断必须按簇进行，否则会把 `⚠️` 从中间切开，宽度算得再准也会错位。
 */
function splitClusters(s) {
  const out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const attaches = out.length > 0 && (cp === 0xfe0e || cp === 0xfe0f || ZERO_WIDTH_RE.test(ch));
    if (attaches) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/**
 * 按显示宽度截断，超长补 `…`。结果宽度保证 ≤ width。
 * @param {unknown} input
 * @param {number} width
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncateW(input, width, ellipsis = "…") {
  const s = input === null || input === undefined ? "" : String(input);
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (w === 0) return "";
  if (displayWidth(s) <= w) return s;

  const hard = (limit) => {
    let out = "";
    let acc = 0;
    for (const cluster of splitClusters(s)) {
      const cw = displayWidth(cluster);
      if (acc + cw > limit) break;
      out += cluster;
      acc += cw;
    }
    return out;
  };

  const ew = displayWidth(ellipsis);
  if (w <= ew) return hard(w);
  return hard(w - ew).replace(/\s+$/, "") + ellipsis;
}

/** 截断 + 补齐：表格单元格专用，返回宽度恰好等于 width 的字符串。 */
function fitW(input, width) {
  return padEndW(truncateW(input, width), width);
}

// ───────────────────────────── 字段归一化 ─────────────────────────────

/** 任何值 → 字符串；null/undefined 及三个字面量 → ""；顺带压掉换行。 */
function str(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v);
  if (s === "null" || s === "undefined" || s === "NaN") return "";
  return s.replace(/[\r\n\t]+/g, " ").trim();
}

/** 任何值 → 有限数字，否则 null（"" 与 blank 都算 null，避免 Number("") === 0 的坑）。 */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 时间戳解析。契约里 appliedAt 是「本地时间」"YYYY-MM-DDTHH:mm:ss"，
 * generatedAt 是 ISO 8601（可能带 Z）。带时区的走 Date 取本地时间，
 * 不带的直接按字面量取值，避免被时区偏移挪走一天。
 */
export function parseStamp(value) {
  const s = str(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: m[4] === undefined ? null : Number(m[4]),
    mi: m[5] === undefined ? null : Number(m[5]),
    se: m[6] === undefined ? null : Number(m[6]),
    zoned: /(?:Z|[+-]\d{2}:?\d{2})$/.test(s),
  };
}

const p2 = (n) => String(n).padStart(2, "0");
const p4 = (n) => String(n).padStart(4, "0");

/**
 * 格式化时间戳。
 * @param {unknown} value
 * @param {"date"|"time"|"datetime"|"mdhm"|"md"} [mode]
 * @returns {string} 无法解析时返回 "—"
 */
export function fmtStamp(value, mode = "datetime") {
  const st = parseStamp(value);
  if (!st) return "—";
  let { y, mo, d, h, mi } = st;
  if (st.zoned) {
    const dt = new Date(str(value));
    if (!Number.isNaN(dt.getTime())) {
      y = dt.getFullYear();
      mo = dt.getMonth() + 1;
      d = dt.getDate();
      h = dt.getHours();
      mi = dt.getMinutes();
    }
  }
  const date = `${p4(y)}-${p2(mo)}-${p2(d)}`;
  const time = h === null ? "" : `${p2(h)}:${p2(mi ?? 0)}`;
  switch (mode) {
    case "date":
      return date;
    case "md":
      return `${p2(mo)}-${p2(d)}`;
    case "time":
      return time || "—";
    case "mdhm":
      return time ? `${p2(mo)}-${p2(d)} ${time}` : `${p2(mo)}-${p2(d)}`;
    default:
      return time ? `${date} ${time}` : date;
  }
}

const PLATFORM_SHORT = Object.freeze({ zhaopin: "智联", boss: "Boss", liepin: "猎聘" });
const DECISION_LABEL = Object.freeze({
  applied: "已投递",
  pending: "待投",
  skipped: "已排除",
  unknown: "未知",
});
const DECISION_ORDER = Array.isArray(DECISIONS) && DECISIONS.length ? DECISIONS : ["applied", "pending", "skipped", "unknown"];
const PLACEHOLDER = "—";

/**
 * 日志事件类型标签。契约（2026-10-13）起 `applied` 数组承载**全部**日志事件，
 * 只有 `kind === "applied"` 才算一次投递；miss / nav_timeout 等失败事件
 * 只用于统计失败面，绝不能计进投递数。
 */
const EVENT_LABEL = Object.freeze({
  applied: "投递成功",
  miss: "列表内已无",
  nav_timeout: "导航超时",
  error: "错误",
  cycle: "轮次",
  start: "启动",
  summary: "汇总",
});
const EVENT_KINDS = Array.isArray(LOG_EVENT_KINDS) && LOG_EVENT_KINDS.length ? LOG_EVENT_KINDS : Object.keys(EVENT_LABEL);

/** 平台别名 → 契约键，方便 opts.platform 既收 "zhaopin" 也收 "智联"。 */
const PLATFORM_ALIAS = (() => {
  const map = new Map();
  for (const key of Object.keys(PLATFORMS || {})) {
    map.set(key.toLowerCase(), key);
    map.set(String(PLATFORMS[key]).toLowerCase(), key);
    map.set(String(PLATFORMS[key]).slice(0, 2).toLowerCase(), key);
  }
  for (const [key, short] of Object.entries(PLATFORM_SHORT)) map.set(short.toLowerCase(), key);
  return map;
})();

function normalizeJob(raw, index) {
  const j = raw && typeof raw === "object" ? raw : {};
  const platform = str(j.platform) || "unknown";
  const salaryMonths = num(j.salaryMonths);
  const appliedAtRaw = str(j.appliedAt);
  return {
    id: str(j.id) || `${platform}#${index}`,
    platform,
    platformLabel: str(PLATFORMS?.[platform]) || platform,
    platformShort: PLATFORM_SHORT[platform] || str(PLATFORMS?.[platform]) || platform,
    title: str(j.title) || "（未命名岗位）",
    company: str(j.company),
    city: str(j.city),
    district: str(j.district),
    locationRaw: str(j.locationRaw),
    salaryRaw: str(j.salaryRaw),
    salaryMin: num(j.salaryMin),
    salaryMax: num(j.salaryMax),
    salaryMonths: salaryMonths === null ? 12 : salaryMonths,
    salaryIsDaily: j.salaryIsDaily === true,
    experience: str(j.experience),
    education: str(j.education),
    decision: DECISION_ORDER.includes(str(j.decision)) ? str(j.decision) : "unknown",
    basis: str(j.basis),
    appliedAt: appliedAtRaw,
    appliedAtDisplay: appliedAtRaw ? fmtStamp(appliedAtRaw, "mdhm") : PLACEHOLDER,
    receipt: str(j.receipt),
    misapplied: str(j.misapplied),
    source: str(j.source),
  };
}

function normalizeEvent(raw) {
  const e = raw && typeof raw === "object" ? raw : {};
  const platform = str(e.platform) || "unknown";
  const kindRaw = str(e.kind).toLowerCase();
  const known = EVENT_KINDS.includes(kindRaw);
  return {
    platform,
    platformLabel: str(PLATFORMS?.[platform]) || platform,
    platformShort: PLATFORM_SHORT[platform] || str(PLATFORMS?.[platform]) || platform,
    kind: known ? kindRaw : "",
    kindLabel: known ? EVENT_LABEL[kindRaw] || kindRaw : "未标注",
    isApplied: kindRaw === "applied",
    // 失败类事件没有岗位名（contract: title 为 null），这里统一成空串
    title: str(e.title),
    salaryRaw: str(e.salaryRaw),
    salaryMin: num(e.salaryMin),
    salaryMax: num(e.salaryMax),
    at: str(e.at),
    verified: e.verified === true,
    keyword: str(e.keyword),
  };
}

function normalizeWarning(raw) {
  const w = raw && typeof raw === "object" ? raw : {};
  const level = str(w.level).toLowerCase() || "warn";
  const source = str(w.source);
  const line = str(w.line);
  return {
    level,
    levelLabel: level === "error" ? "错误" : level === "info" ? "提示" : "警告",
    source,
    line,
    where: source ? (line ? `${source}:${line}` : source) : "（未知来源）",
    message: str(w.message) || "（无说明）",
  };
}

function normalizeSources(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") list = Object.values(raw);
  const items = list
    .filter((s) => s && typeof s === "object")
    .map((s) => ({ path: str(s.path), bytes: num(s.bytes) || 0, mtime: str(s.mtime) }));
  return { items, count: items.length, bytes: items.reduce((a, s) => a + s.bytes, 0) };
}

function normalizePayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return {
    schemaVersion: num(p.schemaVersion),
    generatedAt: str(p.generatedAt),
    jobs: Array.isArray(p.jobs) ? p.jobs.map(normalizeJob) : [],
    applied: Array.isArray(p.applied) ? p.applied.map(normalizeEvent) : [],
    warnings: Array.isArray(p.warnings) ? p.warnings.map(normalizeWarning) : [],
    sources: normalizeSources(p.sources),
  };
}

// ───────────────────────────── 薪资分桶 ─────────────────────────────

/** 月薪分桶（左闭右开）。`salaryMin` 为 null 的走「薪资未明」，不混进 0。 */
export const SALARY_BUCKETS = Object.freeze([
  Object.freeze({ key: "lt7", label: "<7k", min: null, max: 7000 }),
  Object.freeze({ key: "7-9", label: "7-9k", min: 7000, max: 9000 }),
  Object.freeze({ key: "9-12", label: "9-12k", min: 9000, max: 12000 }),
  Object.freeze({ key: "12-15", label: "12-15k", min: 12000, max: 15000 }),
  Object.freeze({ key: "15-20", label: "15-20k", min: 15000, max: 20000 }),
  Object.freeze({ key: "ge20", label: "≥20k", min: 20000, max: null }),
]);

/** `salaryMin` 为 null/缺失时的独立桶名。 */
export const UNKNOWN_SALARY_LABEL = "薪资未明";

/**
 * 月薪分桶。边界：7000→"7-9k"，9000→"9-12k"，12000→"12-15k"，
 * 15000→"15-20k"，20000→"≥20k"。
 * @param {unknown} salaryMin
 * @returns {string}
 */
export function salaryBucket(salaryMin) {
  const v = num(salaryMin);
  if (v === null) return UNKNOWN_SALARY_LABEL;
  for (const b of SALARY_BUCKETS) {
    if ((b.min === null || v >= b.min) && (b.max === null || v < b.max)) return b.label;
  }
  return UNKNOWN_SALARY_LABEL;
}

// ───────────────────────────── 聚合 ─────────────────────────────

const bar = (count, scale, width) => {
  if (width <= 0) return "";
  const filled = scale <= 0 || count <= 0 ? 0 : Math.max(1, Math.round((count / scale) * width));
  const f = Math.min(width, filled);
  return "█".repeat(f) + "░".repeat(width - f);
};

const pct = (n, total) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%");

function cityKey(job) {
  if (job.city && job.district) return `${job.city}·${job.district}`;
  if (job.city) return job.city;
  if (job.district) return job.district;
  if (job.locationRaw) return job.locationRaw;
  return "地点未明";
}

function locationText(job) {
  if (job.locationRaw) return job.locationRaw;
  const k = cityKey(job);
  return k === "地点未明" ? PLACEHOLDER : k;
}

function salaryText(job) {
  if (job.salaryRaw) return job.salaryRaw;
  if (job.salaryIsDaily) {
    if (job.salaryMin !== null && job.salaryMax !== null) return `${job.salaryMin}-${job.salaryMax}元/天`;
    if (job.salaryMin !== null) return `${job.salaryMin}元/天起`;
    return "日薪未标明";
  }
  if (job.salaryMin !== null && job.salaryMax !== null) return `${kfmt(job.salaryMin)}-${kfmt(job.salaryMax)}`;
  if (job.salaryMin !== null) return `${kfmt(job.salaryMin)} 起`;
  if (job.salaryMax !== null) return `${kfmt(job.salaryMax)} 以内`;
  return "未标明";
}

function kfmt(v) {
  const n = num(v);
  if (n === null) return PLACEHOLDER;
  if (n >= 1000) {
    const k = Math.round(n / 100) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

function countBy(items, keyOf) {
  const map = new Map();
  for (const it of items) {
    const k = keyOf(it);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

function sortRows(map, labelOf) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, label: labelOf ? labelOf(key) : key, count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** opts 归一化：过滤条件与排版参数。 */
function normalizeOpts(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const platformRaw = str(o.platform).toLowerCase();
  const platform = platformRaw ? PLATFORM_ALIAS.get(platformRaw) || platformRaw : undefined;
  const city = str(o.city);
  const decision = DECISION_ORDER.includes(str(o.decision)) ? str(o.decision) : undefined;
  const topNum = num(o.top);
  const topCitiesNum = num(o.topCities);
  const widthNum = num(o.width);
  const linesNum = num(o.briefLines);
  return {
    platform,
    city: city || undefined,
    decision,
    top: topNum !== null && topNum > 0 ? Math.floor(topNum) : undefined,
    topCities: topCitiesNum !== null && topCitiesNum > 0 ? Math.floor(topCitiesNum) : undefined,
    width: widthNum !== null && widthNum >= 40 ? Math.floor(widthNum) : 112,
    briefLines: linesNum !== null && linesNum > 4 ? Math.floor(linesNum) : 25,
  };
}

function cityMatches(job, q) {
  const needle = q.toLowerCase();
  return `${job.city}${job.district}${job.locationRaw}`.toLowerCase().includes(needle);
}

function filterJobs(jobs, o) {
  return jobs.filter(
    (j) =>
      (!o.platform || j.platform === o.platform) &&
      (!o.decision || j.decision === o.decision) &&
      (!o.city || cityMatches(j, o.city)),
  );
}

const DAY_MS = 86400000;
function dayNumber(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
function dateFromDayNumber(n) {
  const dt = new Date(n * DAY_MS);
  return `${p4(dt.getUTCFullYear())}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

/** 投递事件 → 每日计数（升序连续日期）。 */
function dailySeries(events) {
  const map = new Map();
  let skipped = 0;
  for (const e of events) {
    const st = parseStamp(e.at);
    if (!st) {
      skipped += 1;
      continue;
    }
    const key = `${p4(st.y)}-${p2(st.mo)}-${p2(st.d)}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  if (!map.size) return { days: [], skipped };
  const keys = [...map.keys()].sort();
  const start = dayNumber(keys[0]);
  const end = dayNumber(keys[keys.length - 1]);
  const days = [];
  for (let n = start; n <= end; n += 1) {
    const date = dateFromDayNumber(n);
    days.push({ date, count: map.get(date) || 0 });
  }
  return { days, skipped };
}

const SPARK_CHARS = "▁▂▃▄▅▆▇█";
function sparkline(counts) {
  const max = counts.reduce((a, c) => Math.max(a, c), 0);
  return counts
    .map((c) => {
      if (c <= 0) return SPARK_CHARS[0];
      if (max <= 0) return SPARK_CHARS[0];
      const idx = Math.min(7, Math.max(1, Math.ceil((c / max) * 7)));
      return SPARK_CHARS[idx];
    })
    .join("");
}

// ───────────────────────────── 标题 / 小节 ─────────────────────────────

function rule(label, width) {
  const head = label ? `── ${label} ` : "";
  const w = Math.max(3, width - displayWidth(head));
  return head + "─".repeat(w);
}

function section(title, width) {
  return rule(title, width);
}

const INDENT = "  ";

/** 键值块：label 左对齐、值右对齐。 */
function kvLines(pairs, labelW) {
  const w = Math.max(...pairs.map(([k]) => displayWidth(k)), labelW || 0);
  return pairs.map(([k, v, suffix]) => `${INDENT}${padEndW(k, w)}  ${padStartW(v, 6)}${suffix ? `  ${suffix}` : ""}`);
}

/** 条形图块：标签 + `█░` 条 + 计数(+后缀)。 */
function barLines(rows, opts) {
  const { barWidth, valueSuffix, cap = 16 } = opts || {};
  if (!rows.length) return [`${INDENT}（无数据）`];
  const labels = rows.map((r) => truncateW(r.label, cap));
  const labelW = Math.max(...labels.map(displayWidth));
  const max = rows.reduce((a, r) => Math.max(a, r.count), 0);
  const countW = Math.max(...rows.map((r) => String(r.count).length));
  return rows.map((r, i) =>
    [
      INDENT,
      padEndW(labels[i], labelW),
      " │",
      bar(r.count, max, barWidth),
      "│ ",
      padStartW(String(r.count), countW),
      valueSuffix ? `  ${valueSuffix(r)}` : "",
    ].join(""),
  );
}

// ───────────────────────────── 明细表 ─────────────────────────────

const TABLE_COLUMNS = [
  { key: "platform", header: "平台", cap: 8, min: 4, flexible: false, get: (j) => j.platformLabel },
  { key: "title", header: "岗位", cap: 20, min: 10, flexible: true, get: (j) => j.title },
  { key: "company", header: "公司", cap: 14, min: 8, flexible: true, get: (j) => j.company || PLACEHOLDER },
  { key: "location", header: "地点", cap: 10, min: 6, flexible: true, get: (j) => locationText(j) },
  { key: "salary", header: "薪资", cap: 12, min: 8, flexible: true, get: (j) => salaryText(j) },
  { key: "decision", header: "判定", cap: 6, min: 6, flexible: false, get: (j) => DECISION_LABEL[j.decision] || "未知" },
  { key: "appliedAt", header: "投递时间", cap: 11, min: 11, flexible: false, get: (j) => j.appliedAtDisplay },
];

const DECISION_RANK = new Map(DECISION_ORDER.map((d, i) => [d, i]));

/** 默认排序：已投递时间倒序 → 判定优先级 → 平台 → 岗位名。 */
function defaultSort(jobs) {
  return [...jobs].sort((a, b) => {
    const ta = parseStamp(a.appliedAt) ? a.appliedAt : "";
    const tb = parseStamp(b.appliedAt) ? b.appliedAt : "";
    if (ta !== tb) return ta < tb ? 1 : -1; // 时间倒序，空值排最后
    const ra = DECISION_RANK.get(a.decision) ?? 9;
    const rb = DECISION_RANK.get(b.decision) ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
}

function tableLayout(jobs, budget) {
  const cols = TABLE_COLUMNS.map((c) => {
    const maxCell = jobs.reduce((a, j) => Math.max(a, displayWidth(c.get(j))), 0);
    return { ...c, width: Math.max(displayWidth(c.header), Math.min(c.cap, maxCell)) };
  });
  const total = () => cols.reduce((a, c) => a + c.width, 0) + 3 * (cols.length - 1);
  let guard = 0;
  while (total() > budget && guard < 800) {
    guard += 1;
    let target = null;
    for (const c of cols) {
      if (!c.flexible || c.width <= c.min) continue;
      if (!target || c.width > target.width) target = c;
    }
    if (!target) break;
    target.width -= 1;
  }
  return { cols, width: total() };
}

/**
 * 渲染等宽对齐的岗位明细表（列宽按显示宽度计算，中文不错位）。
 * @param {object[]} jobs 已经归一化的岗位数组
 * @param {{width?: number, top?: number}} [opts]
 * @returns {string}
 */
export function renderJobTable(jobs, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const budget = num(o.width) !== null && num(o.width) >= 40 ? Math.floor(num(o.width)) : 112;
  const list = Array.isArray(jobs) ? jobs.filter((j) => j && typeof j === "object") : [];
  if (!list.length) return `${INDENT}（无岗位）`;

  const { cols, width } = tableLayout(list, budget);
  const line = (cells) => cells.map((c, i) => fitW(c, cols[i].width)).join(" │ ").replace(/\s+$/, "");
  const out = [];
  out.push(line(cols.map((c) => c.header)));
  out.push(cols.map((c) => "─".repeat(c.width)).join("─┼─"));

  const limit = num(o.top) !== null && num(o.top) > 0 ? Math.floor(num(o.top)) : list.length;
  const shown = list.slice(0, limit);
  for (const j of shown) {
    let row = line(cols.map((c) => c.get(j)));
    if (j.misapplied) row += "  [!误投]";
    if (j.salaryIsDaily) row += "  [日薪]";
    out.push(row);
    if (j.misapplied) out.push(`${INDENT}${INDENT}↳ 误投原因：${truncateW(j.misapplied, Math.max(20, width - 14))}`);
  }
  if (limit < list.length) {
    out.push(`${INDENT}… 另有 ${list.length - limit} 条未显示（可用 top 参数调整）`);
  }
  return out.join("\n");
}

// ───────────────────────────── 主构建函数 ─────────────────────────────

function buildView(payload, o) {
  const p = normalizePayload(payload);
  const jobs = filterJobs(p.jobs, o);
  const events = o.platform ? p.applied.filter((e) => e.platform === o.platform) : p.applied;

  const counts = { applied: 0, pending: 0, skipped: 0, unknown: 0 };
  for (const j of jobs) counts[j.decision] += 1;

  const dailyJobs = jobs.filter((j) => j.salaryIsDaily);
  const monthlyJobs = jobs.filter((j) => !j.salaryIsDaily);
  const bucketMap = new Map();
  for (const j of monthlyJobs) {
    const label = salaryBucket(j.salaryMin);
    bucketMap.set(label, (bucketMap.get(label) || 0) + 1);
  }
  const salaryRows = [
    ...SALARY_BUCKETS.map((b) => ({ label: b.label, count: bucketMap.get(b.label) || 0 })),
    { label: UNKNOWN_SALARY_LABEL, count: bucketMap.get(UNKNOWN_SALARY_LABEL) || 0 },
  ];
  const resolvedSalary = monthlyJobs.length - (bucketMap.get(UNKNOWN_SALARY_LABEL) || 0);

  const platformRows = sortRows(
    countBy(jobs, (j) => j.platform),
    (k) => str(PLATFORMS?.[k]) || k,
  );
  const decisionRows = DECISION_ORDER.map((d) => ({
    label: DECISION_LABEL[d] || d,
    count: counts[d] || 0,
  }));
  const cityMap = countBy(jobs, cityKey);
  const cityRows = sortRows(cityMap);

  // 契约（2026-10-13）：applied 数组承载全部日志事件，只有 kind === "applied"
  // 才算投递。失败事件（miss / nav_timeout / error）只进失败面统计。
  const appliedEvents = events.filter((e) => e.isApplied);
  const unlabeledEvents = events.filter((e) => !e.kind).length;
  const kindRows = sortRows(
    countBy(events, (e) => e.kind || "__unlabeled__"),
    (k) => (k === "__unlabeled__" ? "未标注 kind" : `${EVENT_LABEL[k] || "其他"}(${k})`),
  );
  const keywordRows = sortRows(
    countBy(appliedEvents.filter((e) => e.keyword), (e) => e.keyword),
  ).slice(0, 5);

  const { days, skipped: skippedEvents } = dailySeries(appliedEvents);
  const peak = days.reduce((a, d) => (a === null || d.count > a.count ? d : a), null);
  const totalEvents = days.reduce((a, d) => a + d.count, 0);

  const warnings = p.warnings;
  const schemaOk = p.schemaVersion === SCHEMA_VERSION;

  // ── 图表块（按 style 排版） ──
  const buildBlocks = (style) => {
    const { barWidth, ruleWidth, cityCap, cityLimit, notes } = style;
    const blocks = {};

    blocks.platform = [
      section(`平台分布（共 ${jobs.length} 个岗位）`, ruleWidth),
      ...barLines(platformRows.map((r) => ({ label: r.label, count: r.count })), {
        barWidth,
        valueSuffix: (r) => pct(r.count, jobs.length),
      }),
    ];

    blocks.decision = [
      section("判定构成", ruleWidth),
      ...barLines(decisionRows, { barWidth, valueSuffix: (r) => pct(r.count, jobs.length) }),
    ];

    const salaryTitle = `薪资分布（月薪 · 按 salaryMin 分桶，n=${monthlyJobs.length}${
      dailyJobs.length ? `；日薪 ${dailyJobs.length} 单未计入` : ""
    }）`;
    const salaryBlock = [section(salaryTitle, ruleWidth), ...barLines(salaryRows, { barWidth })];
    if (dailyJobs.length && notes) {
      const samples = [...new Set(dailyJobs.map((j) => j.salaryRaw).filter(Boolean))].slice(0, 2);
      salaryBlock.push(`${INDENT}日薪样本：${samples.length ? samples.join("、") : "日薪"}（属排除项，不进月薪直方图）`);
    }
    if (resolvedSalary < monthlyJobs.length && notes) {
      salaryBlock.push(`${INDENT}月薪已解析 ${resolvedSalary} / ${monthlyJobs.length}，其余归入「${UNKNOWN_SALARY_LABEL}」`);
    }
    blocks.salary = salaryBlock;

    const shownCities = cityRows.slice(0, cityLimit);
    const cityBlock = [
      section(
        `地点分布（Top ${shownCities.length} / 共 ${cityRows.length} 处）`,
        ruleWidth,
      ),
      ...barLines(shownCities.map((r) => ({ label: r.label, count: r.count })), { barWidth, cap: cityCap }),
    ];
    if (cityRows.length > shownCities.length && notes) {
      cityBlock.push(`${INDENT}… 另有 ${cityRows.length - shownCities.length} 处地点未展开`);
    }
    blocks.city = cityBlock;

    const timelineBlock = [section("投递时间线", ruleWidth)];
    if (!days.length) {
      timelineBlock.push(`${INDENT}（无投递事件）`);
    } else {
      const sparkDays = days.length > 60 ? days.slice(-60) : days;
      const range =
        sparkDays.length > 1 ? `${sparkDays[0].date} ~ ${sparkDays[sparkDays.length - 1].date}` : sparkDays[0].date;
      const sparkLine = `${INDENT}${sparkline(sparkDays.map((d) => d.count))}  （${range}，${sparkDays.length} 天，${totalEvents} 单）`;
      const peakLine = peak && peak.count > 0 ? `峰值 ${peak.date.slice(5)}（${peak.count} 单）` : "";
      if (style.mergeTimeline && peakLine) timelineBlock.push(`${sparkLine}  ${peakLine}`);
      else {
        timelineBlock.push(sparkLine);
        if (peakLine) timelineBlock.push(`${INDENT}峰值：${peak.date}（${peak.count} 单）`);
      }
      const active = days.filter((d) => d.count > 0).slice(-12);
      if (notes) {
        timelineBlock.push(`${INDENT}有投递的日期：${active.map((d) => `${d.date.slice(5)}(${d.count})`).join(" ")}`);
      }
    }
    if (skippedEvents > 0 || unlabeledEvents > 0) {
      const diag = [];
      if (skippedEvents > 0) diag.push(`${skippedEvents} 条投递事件缺时间`);
      if (unlabeledEvents > 0) diag.push(`${unlabeledEvents} 条日志事件缺 kind`);
      timelineBlock.push(`${INDENT}注：${diag.join(" · ")}，均未计入投递数`);
    }
    if (o.city || o.decision) {
      timelineBlock.push(`${INDENT}注：投递事件只有平台字段，地点/判定筛选不作用于时间线`);
    }
    blocks.timeline = timelineBlock;

    // 日志失败面（与投递统计分开成节，绝不混进投递数）
    const failureCount = events.length - appliedEvents.length;
    const logBlock = [
      section(`日志事件构成（共 ${events.length} 条 · 投递成功 ${appliedEvents.length} · 非投递 ${failureCount}）`, ruleWidth),
      ...barLines(
        kindRows.map((r) => ({ label: r.label, count: r.count })),
        { barWidth, cap: style.logCap || 24, valueSuffix: (r) => pct(r.count, events.length) },
      ),
    ];
    if (keywordRows.length) {
      logBlock.push(
        `${INDENT}命中关键词：${keywordRows.map((r) => `${r.label}(${r.count})`).join(" ")}`,
      );
    }
    if (failureCount > 0) {
      const timeout = kindRows.find((r) => r.key === "nav_timeout");
      const miss = kindRows.find((r) => r.key === "miss");
      const bits = [];
      if (timeout) bits.push(`导航超时 ${timeout.count} 次`);
      if (miss) bits.push(`列表内已无 ${miss.count} 次`);
      if (bits.length) logBlock.push(`${INDENT}${bits.join(" · ")} —— 数值偏高说明当日岗位池接近挖穿`);
    }
    blocks.log = logBlock;

    blocks.warn = [
      section(`解析告警（${warnings.length}）`, ruleWidth),
      ...warnings.slice(0, style.warnLimit).map(
        (w) => `${INDENT}[${w.levelLabel}] ${w.where}  ${truncateW(w.message, Math.max(24, ruleWidth - 16))}`,
      ),
    ];
    if (warnings.length > style.warnLimit) {
      blocks.warn.push(`${INDENT}… 另有 ${warnings.length - style.warnLimit} 条告警`);
    }
    return blocks;
  };

  const sorted = defaultSort(jobs);

  return {
    p,
    o,
    jobs,
    sorted,
    events,
    appliedEvents,
    unlabeledEvents,
    kindRows,
    counts,
    dailyJobs,
    monthlyJobs,
    resolvedSalary,
    salaryRows,
    platformRows,
    decisionRows,
    cityRows,
    days,
    peak,
    totalEvents,
    skippedEvents,
    warnings,
    schemaOk,
    buildBlocks,
  };
}

function schemaWarningLine(p) {
  const got = p.schemaVersion === null ? "缺失" : `v${p.schemaVersion}`;
  return `[!] 契约版本不符：本模块预期 v${SCHEMA_VERSION}，数据为 ${got}`;
}

function generatedLabel(p) {
  const stamp = p.generatedAt ? fmtStamp(p.generatedAt, "datetime") : "—";
  const when = stamp === "—" ? "时间未提供" : stamp;
  const src = p.sources.count ? `${p.sources.count} 个数据源` : "数据源未提供";
  return `生成 ${when} · ${src}`;
}

function summarize(view) {
  const { counts, jobs, appliedEvents, warnings, p } = view;
  return `岗位 ${jobs.length} · 判定 已投${counts.applied}/待投${counts.pending}/排除${counts.skipped}/未知${counts.unknown} · 投递事件 ${appliedEvents.length} · 日志事件 ${p.applied.length} · 告警 ${warnings.length}`;
}

/** 一行日志失败面摘要（给 renderBrief 用）。 */
function logSummaryLine(view) {
  const parts = view.kindRows.slice(0, 4).map((r) => {
    const name = r.key === "__unlabeled__" ? "未标注" : EVENT_LABEL[r.key] || r.key;
    return `${name} ${r.count}`;
  });
  const rest = view.kindRows.slice(4).reduce((a, r) => a + r.count, 0);
  if (rest > 0) parts.push(`其他 ${rest}`);
  return `日志：${parts.join(" · ")}（仅 kind=applied 计入投递）`;
}

function filterLine(view) {
  const parts = [];
  if (view.o.platform) parts.push(`平台=${str(PLATFORMS?.[view.o.platform]) || view.o.platform}`);
  if (view.o.city) parts.push(`城市=${view.o.city}`);
  if (view.o.decision) parts.push(`判定=${DECISION_LABEL[view.o.decision] || view.o.decision}`);
  if (view.o.top) parts.push(`top=${view.o.top}`);
  return parts.length ? `筛选：${parts.join(" · ")}` : "";
}

/**
 * 把区块塞进行数预算，保证总行数 ≤ budget。
 * 每个区块带 priority：预算不够时**按优先级丢**（数字大的先丢），而不是无脑砍尾巴——
 * 告警和概览比图表尾部更该保住。区块之间的相对顺序不变。
 * @param {{lines: string[], priority: number}[]} entries
 * @param {number} budget
 */
function packBlocks(entries, budget) {
  const total = entries.reduce((a, e) => a + e.lines.length, 0);
  if (total <= budget) return entries.flatMap((e) => e.lines);

  const byPriority = entries
    .map((e, index) => ({ ...e, index }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  const kept = new Set();
  let used = 0;
  let dropped = 0;
  for (const e of byPriority) {
    // 预留 1 行给「已省略 N 个区块」提示
    if (used + e.lines.length + 1 <= budget) {
      kept.add(e.index);
      used += e.lines.length;
    } else {
      dropped += 1;
    }
  }
  const lines = entries.filter((_, i) => kept.has(i)).flatMap((e) => e.lines);
  if (dropped > 0) lines.push(`… 已省略 ${dropped} 个区块（完整内容见 renderFull）`);
  return lines.length <= budget ? lines : lines.slice(0, budget);
}

/**
 * 紧凑概览（弹窗/聊天直接看的版本），行数 ≤ opts.briefLines（默认 25）。
 * @param {object} payload DashboardPayload
 * @param {{platform?: string, city?: string, decision?: string, top?: number, topCities?: number, briefLines?: number}} [opts]
 * @returns {string}
 */
export function renderBrief(payload, opts) {
  const o = normalizeOpts(opts);
  const view = buildView(payload, o);
  const ruleWidth = 40;
  const barWidth = 17;
  /** @type {{lines: string[], priority: number}[]} */
  const blocks = [];
  const add = (lines, priority) => blocks.push({ lines, priority });

  add([`投递数据看板 · ${generatedLabel(view.p)}`], 0);
  if (!view.schemaOk) add([schemaWarningLine(view.p)], 0);
  add([summarize(view)], 0);
  const fl = filterLine(view);
  if (fl) add([fl], 0);

  const style = {
    barWidth,
    ruleWidth,
    cityCap: 14,
    cityLimit: o.topCities || 2,
    warnLimit: 2,
    notes: false,
    mergeTimeline: true,
  };
  if (!view.jobs.length) {
    add([`（暂无岗位数据：原始 ${view.p.jobs.length} 条，投递事件 ${view.p.applied.length} 条）`], 1);
  } else {
    const b = view.buildBlocks(style);
    add(b.platform, 3);
    add(b.salary, 4);
    add(b.timeline, 5);
    add(b.city, 7);
  }
  if (view.p.applied.length) add([logSummaryLine(view)], 6);
  if (view.warnings.length) add(view.buildBlocks(style).warn, 2);
  return packBlocks(blocks, o.briefLines).join("\n");
}

/**
 * 完整报告（含明细表、误投/排除原因、全部告警）。
 * @param {object} payload DashboardPayload
 * @param {{platform?: string, city?: string, decision?: string, top?: number, topCities?: number, width?: number, warnLimit?: number}} [opts]
 * @returns {string}
 */
export function renderFull(payload, opts) {
  const o = normalizeOpts(opts);
  const view = buildView(payload, o);
  const tableText = renderJobTable(view.sorted, { width: o.width, top: o.top });
  const tableWidth = Math.max(...tableText.split("\n").map(displayWidth));
  const ruleWidth = Math.min(120, Math.max(62, tableWidth));
  const barWidth = 26;
  const warnLimit = num(opts?.warnLimit) !== null && num(opts?.warnLimit) > 0 ? Math.floor(num(opts?.warnLimit)) : 40;

  const b = view.buildBlocks({
    barWidth,
    ruleWidth,
    cityCap: 16,
    cityLimit: o.topCities || 12,
    warnLimit,
    notes: true,
  });

  const out = [];
  const title = "投递数据看板 · 完整报告";
  const pad = Math.max(0, ruleWidth - displayWidth(title) - 2);
  out.push("═".repeat(ruleWidth));
  out.push(`${" ".repeat(Math.floor(pad / 2))}${title}`);
  out.push(` ${generatedLabel(view.p)}`);
  const fl = filterLine(view);
  if (fl) out.push(` ${fl}`);
  if (!view.schemaOk) out.push(` ${schemaWarningLine(view.p)}`);
  out.push("═".repeat(ruleWidth));
  out.push("");

  out.push(section("概览", ruleWidth));
  out.push(
    ...kvLines([
      ["岗位总数", String(view.jobs.length)],
      ["已投递", String(view.counts.applied), `(${pct(view.counts.applied, view.jobs.length)})`],
      ["待投", String(view.counts.pending), `(${pct(view.counts.pending, view.jobs.length)})`],
      ["已排除", String(view.counts.skipped), `(${pct(view.counts.skipped, view.jobs.length)})`],
      ["未知判定", String(view.counts.unknown), `(${pct(view.counts.unknown, view.jobs.length)})`],
      ["投递事件", String(view.appliedEvents.length), "kind=applied"],
      ["日志事件", String(view.p.applied.length), "含失败类"],
      ["解析告警", String(view.warnings.length)],
      ...(view.p.jobs.length !== view.jobs.length ? [["原始岗位", String(view.p.jobs.length)]] : []),
    ]),
  );
  if (!view.jobs.length) {
    out.push(`${INDENT}（筛选后没有任何岗位，可用 renderFull(payload) 不带筛选参数查看全部）`);
  }
  out.push("");

  out.push(...b.platform);
  out.push("");
  out.push(...b.decision);
  out.push("");
  out.push(...b.salary);
  out.push("");
  out.push(...b.city);
  out.push("");
  out.push(...b.timeline);
  out.push("");
  out.push(...b.log);
  out.push("");

  out.push(section(`岗位明细（${view.sorted.length} 条${o.top && o.top < view.sorted.length ? `，显示前 ${o.top} 条` : ""}）`, ruleWidth));
  out.push(tableText);
  out.push("");

  const flagged = view.jobs.filter((j) => j.misapplied || j.decision === "skipped");
  if (flagged.length) {
    out.push(section(`误投与被排除（${flagged.length}）`, ruleWidth));
    for (const j of flagged.slice(0, 20)) {
      const tag = j.misapplied ? "误投" : "排除";
      const reason = j.misapplied || j.basis || j.receipt || "（无原因记录）";
      out.push(
        `${INDENT}[${tag}] ${fitW(j.title, 18)} ${fitW(j.company || PLACEHOLDER, 12)} ${truncateW(reason, Math.max(20, ruleWidth - 36))}`,
      );
    }
    if (flagged.length > 20) out.push(`${INDENT}… 另有 ${flagged.length - 20} 条`);
    out.push("");
  }

  if (view.warnings.length) {
    out.push(...b.warn);
  } else {
    out.push(section("解析告警（0）", ruleWidth));
    out.push(`${INDENT}（无）`);
  }
  return out.join("\n");
}

/**
 * 供调用方复用的筛选与选项归一 —— **不要自己重写一份**。
 *
 * 动机（2026-10-13 实测发现的 bug）：`cdp_jobs_report` 返回的 jobCount 原本取
 * 未过滤的 payload.jobs.length，于是「筛选北京已投递」时报告头部显示「岗位 7」，
 * 而工具返回值却是 81，两者矛盾。调用方若照着 81 去做决策就被误导了。
 * 修法不是各算一遍，而是让调用方复用报告内部这一套 —— 这样两处口径永远一致。
 */
export { filterJobs, normalizeOpts, normalizePayload };

export default { renderBrief, renderFull, displayWidth, padEndW, padStartW, truncateW, salaryBucket, SALARY_BUCKETS, UNKNOWN_SALARY_LABEL, renderJobTable };
