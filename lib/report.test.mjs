/**
 * dsh-plugin-cdp — report.mjs 单元测试
 *
 * 运行：node --test <插件目录>\lib\report.test.mjs
 *
 * 重点覆盖三件最容易翻车的事：
 *   1. 中英混排的显示宽度（中文 = 2 列），以及基于它的 pad/truncate；
 *   2. 薪资分桶的边界值（7000 / 9000 / 12000 / 15000 / 20000 落在哪桶）；
 *   3. 空数据 / 字段缺失 / salaryMin 为 null 时不崩、不出现 NaN|undefined|null 字面量。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SALARY_BUCKETS,
  UNKNOWN_SALARY_LABEL,
  displayWidth,
  fmtStamp,
  padEndW,
  padStartW,
  parseStamp,
  renderBrief,
  renderFull,
  renderJobTable,
  salaryBucket,
  truncateW,
} from "./report.mjs";

// ───────────────────────────── fixture ─────────────────────────────

/** 14 条岗位：3 平台、1 条日薪、1 条 salaryMin=null、1 条字段全缺失、1 条误投、2 条告警。 */
function fixture() {
  const j = (o) => ({
    id: "",
    platform: "zhaopin",
    title: "",
    company: "",
    city: "",
    district: "",
    locationRaw: "",
    salaryRaw: "",
    salaryMin: null,
    salaryMax: null,
    salaryMonths: 12,
    salaryIsDaily: false,
    experience: "",
    education: "",
    decision: "unknown",
    basis: "",
    appliedAt: null,
    receipt: "",
    misapplied: "",
    source: "台账明细",
    ...o,
  });

  const jobs = [
    j({ id: "zp:1", platform: "zhaopin", title: "前端开发工程师", company: "北京星海科技有限公司", city: "北京", district: "海淀", locationRaw: "北京·海淀", salaryRaw: "1.1-1.3万", salaryMin: 11000, salaryMax: 13000, experience: "3-5年", education: "本科", decision: "applied", basis: "合规", appliedAt: "2026-03-04T09:12:00", receipt: "已向对方发送简历和打招呼语", source: "台账已投递" }),
    j({ id: "zp:2", platform: "zhaopin", title: "数据分析师", company: "北京朝阳数据服务有限公司", city: "北京", district: "朝阳", locationRaw: "北京·朝阳", salaryRaw: "1.2-1.4万·13薪", salaryMin: 12000, salaryMax: 14000, salaryMonths: 13, experience: "1-3年", education: "硕士", decision: "applied", appliedAt: "2026-03-04T09:40:00" }),
    j({ id: "zp:3", platform: "zhaopin", title: "Java开发工程师", company: "星海信息", city: "北京", district: "海淀", locationRaw: "北京·海淀", salaryRaw: "8000-9000元", salaryMin: 8000, salaryMax: 9000, experience: "3-5年", education: "大专", decision: "pending", basis: "合规待投" }),
    j({ id: "zp:4", platform: "zhaopin", title: "测试工程师", company: "太原云图软件", city: "太原", district: "小店", locationRaw: "太原·小店", salaryRaw: "6001-7000元", salaryMin: 6001, salaryMax: 7000, decision: "skipped", basis: "薪资低于阈值 7000", misapplied: "薪资低于 7000 阈值，属规则排除" }),
    j({ id: "zp:5", platform: "zhaopin", title: "产品经理", company: "北京朝阳产品实验室", city: "北京", district: "朝阳", locationRaw: "北京·朝阳", salaryRaw: "面议", salaryMin: null, salaryMax: null, decision: "applied", appliedAt: "2026-03-04T14:05:00" }),
    j({ id: "zp:6", platform: "zhaopin", title: "算法工程师", company: "星海智能", city: "北京", district: "海淀", locationRaw: "北京·海淀", salaryRaw: "2.3-2.5万·13薪", salaryMin: 23000, salaryMax: 25000, salaryMonths: 13, decision: "unknown", basis: "" }),
    j({ id: "boss:1", platform: "boss", title: "前端工程师（Vue）", company: "星海网络", city: "北京", district: "海淀", locationRaw: "北京·海淀", salaryRaw: "9-18k·14薪", salaryMin: 9000, salaryMax: 18000, salaryMonths: 14, decision: "applied", appliedAt: "2026-03-02T10:00:00", receipt: "已向对方发送简历和打招呼语" }),
    j({ id: "boss:2", platform: "boss", title: "Web前端开发", company: "朝阳科技", city: "北京", district: "朝阳", locationRaw: "北京·朝阳", salaryRaw: "8-9k", salaryMin: 8500, salaryMax: 9000, decision: "pending" }),
    j({ id: "boss:3", platform: "boss", title: "资深前端架构师", company: "太原小店数字科技", city: "太原", district: "小店", locationRaw: "太原·小店", salaryRaw: "1.5-3万·14薪", salaryMin: 15000, salaryMax: 30000, salaryMonths: 14, experience: "5-10年", education: "本科", decision: "applied", appliedAt: "2026-03-04T09:12:00", receipt: "已向对方发送简历和打招呼语" }),
    j({ id: "boss:4", platform: "boss", title: "前端实习生", company: "云图教育", city: "太原", district: "小店", locationRaw: "太原·小店", salaryRaw: "180-220元/天", salaryMin: 180, salaryMax: 220, salaryIsDaily: true, decision: "skipped", basis: "日薪岗位，属排除项", misapplied: "日薪岗位不投递" }),
    j({ id: "boss:5", platform: "boss", title: "小程序开发", decision: "pending" }),
    j({ id: "lp:1", platform: "liepin", title: "前端开发（React）", company: "太原迎泽信息", city: "太原", district: "迎泽", locationRaw: "太原·迎泽", salaryRaw: "7000-11000元·13薪", salaryMin: 7000, salaryMax: 11000, salaryMonths: 13, decision: "applied", appliedAt: "2026-03-05T09:00:00", receipt: "已向对方发送简历和打招呼语" }),
    j({ id: "lp:2", platform: "liepin", title: "高级前端工程师", company: "迎泽数字", city: "太原", district: "迎泽", locationRaw: "太原·迎泽", salaryRaw: "1.3-1.5万", salaryMin: 13000, salaryMax: 15000, decision: "pending" }),
    j({ id: "lp:3", platform: "liepin", title: "技术专家", company: "北京某互联网公司", city: "北京", district: "", locationRaw: "北京", salaryRaw: "1.6-1.8万", salaryMin: 16000, salaryMax: 18000, decision: "skipped", basis: "经验不匹配" }),
  ];

  // 契约（2026-10-13）：applied 承载**全部日志事件**，只有 kind === "applied" 才算投递。
  // 失败类事件 title 为 null（不是空串），且 salaryRaw 为空串。
  const applied = [
    { platform: "zhaopin", kind: "applied", title: "前端开发工程师", salaryRaw: "1.1-1.3万", salaryMin: 11000, salaryMax: 13000, at: "2026-03-02T10:00:00", verified: true, keyword: "前端开发" },
    { platform: "boss", kind: "applied", title: "前端工程师（Vue）", salaryRaw: "9-18k·14薪", salaryMin: 9000, salaryMax: 18000, at: "2026-03-02T11:30:00", verified: true, keyword: "前端" },
    { platform: "zhaopin", kind: "applied", title: "数据分析师", salaryRaw: "1.2-1.4万·13薪", salaryMin: 12000, salaryMax: 14000, at: "2026-03-04T09:12:00", verified: true, keyword: "数据分析" },
    { platform: "zhaopin", kind: "applied", title: "产品经理", salaryRaw: "面议", salaryMin: null, salaryMax: null, at: "2026-03-04T09:40:00", verified: false, keyword: "产品经理" },
    { platform: "boss", kind: "applied", title: "资深前端架构师", salaryRaw: "1.5-3万·14薪", salaryMin: 15000, salaryMax: 30000, at: "2026-03-04T14:05:00", verified: true, keyword: "前端" },
    { platform: "liepin", kind: "applied", title: "前端开发（React）", salaryRaw: "7000-11000元·13薪", salaryMin: 7000, salaryMax: 11000, at: "2026-03-05T09:00:00", verified: false, keyword: "前端开发" },
    { platform: "zhaopin", kind: "applied", title: "前端开发工程师", salaryRaw: "1.1-1.3万", salaryMin: 11000, salaryMax: 13000, at: "2026-03-09T08:30:00", verified: true, keyword: "前端开发" },
    // 时间缺失：不进时间线，但必须在报告里说明，不能静默丢
    { platform: "zhaopin", kind: "applied", title: "时间缺失的岗位", salaryRaw: "1-1.2万", salaryMin: 10000, salaryMax: 12000, at: "", verified: false, keyword: "前端" },
    // 失败类事件 14 条：title 全为 null。若被算成投递，时间线会明显虚高。
    ...Array.from({ length: 14 }, (_, i) =>
      i < 8
        ? { platform: "zhaopin", kind: "nav_timeout", title: null, salaryRaw: "", salaryMin: null, salaryMax: null, at: `2026-03-0${(i % 5) + 2}T10:1${i}:00`, verified: false, keyword: "前端开发" }
        : { platform: "boss", kind: "miss", title: null, salaryRaw: "", salaryMin: null, salaryMax: null, at: `2026-03-0${(i % 5) + 2}T11:2${i}:00`, verified: false, keyword: "前端" },
    ),
    { platform: "boss", kind: "cycle", title: null, salaryRaw: "", at: "2026-03-10T09:00:00", verified: false, keyword: "" },
    { platform: "boss", kind: "start", title: null, salaryRaw: "", at: "2026-03-01T08:00:00", verified: false, keyword: "" },
    { platform: "zhaopin", kind: "error", title: null, salaryRaw: "", at: "2026-03-06T15:00:00", verified: false, keyword: "" },
    // 缺 kind：既不算投递也不能当成功事件，报告里要有提示
    { platform: "zhaopin", title: "没有 kind 的事件", salaryRaw: "", at: "2026-03-07T12:00:00", verified: false },
  ];

  const warnings = [
    { level: "warn", source: "台账明细", line: 12, message: "薪资「面议」无法解析为区间，已归入「薪资未明」" },
    { level: "error", source: "run-zp-B.log", line: 88, message: "无法识别的日志行，已跳过（未静默丢弃）" },
  ];

  return {
    schemaVersion: 1,
    generatedAt: "2026-03-12T18:30:00",
    jobs,
    applied,
    warnings,
    sources: [
      { path: "<工作目录>/投递台账.md", bytes: 59788, mtime: "2026-03-12T18:00:00" },
      { path: "<工作目录>/run-zp-B.log", bytes: 2784, mtime: "2026-03-12T17:40:00" },
      { path: "<工作目录>/run-boss.log", bytes: 1379, mtime: "2026-03-12T17:41:00" },
    ],
  };
}

/** 压力数据：200 岗位 / 60 地点 / 40 告警 / 大量失败事件。 */
function bigPayload() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-03-12T18:30:00",
    jobs: Array.from({ length: 200 }, (_, i) => ({
      platform: ["zhaopin", "boss", "liepin"][i % 3],
      title: `岗位${i}`,
      company: `公司${i}`,
      city: `城市${i % 60}`,
      district: `区${i % 7}`,
      salaryRaw: "1-1.5万",
      salaryMin: 10000 + i,
      salaryMax: 15000 + i,
      decision: ["applied", "pending", "skipped", "unknown"][i % 4],
      appliedAt: `2026-03-${String((i % 28) + 1).padStart(2, "0")}T09:00:00`,
    })),
    applied: [
      ...Array.from({ length: 120 }, (_, i) => ({
        platform: ["zhaopin", "boss", "liepin"][i % 3],
        kind: "applied",
        title: `岗位${i}`,
        salaryRaw: "1-1.5万",
        salaryMin: 10000 + i,
        salaryMax: 15000 + i,
        at: `2026-03-${String((i % 28) + 1).padStart(2, "0")}T09:00:00`,
        verified: true,
        keyword: `关键词${i % 9}`,
      })),
      ...Array.from({ length: 120 }, (_, i) => ({
        platform: "zhaopin",
        kind: "nav_timeout",
        title: null,
        salaryRaw: "",
        at: `2026-03-${String((i % 28) + 1).padStart(2, "0")}T10:00:00`,
        verified: false,
        keyword: "",
      })),
      ...Array.from({ length: 77 }, (_, i) => ({
        platform: "boss",
        kind: "miss",
        title: null,
        salaryRaw: "",
        at: `2026-03-${String((i % 28) + 1).padStart(2, "0")}T11:00:00`,
        verified: false,
        keyword: "",
      })),
    ],
    warnings: Array.from({ length: 40 }, (_, i) => ({ level: "warn", source: `f${i}.log`, line: i, message: `第 ${i} 行无法解析` })),
    sources: [],
  };
}

/** 取某一节的全部行（到下一个 `── ` 小节或 52 个 `═` 为止）。 */
function sectionLines(text, title) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`── ${title}`));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("── ") || lines[i].startsWith("═")) break;
    if (lines[i].trim() === "") break;
    out.push(lines[i]);
  }
  return out;
}

/** 一行里列分隔符（`│` 或分隔行的 `┼`）的显示宽度偏移；表格对齐的核心指标。 */
function sepOffsets(line) {
  const offsets = [];
  let w = 0;
  for (const ch of line) {
    if (ch === "│" || ch === "┼") offsets.push(w);
    w += displayWidth(ch);
  }
  return offsets;
}

const BAD_LITERAL = /\b(?:undefined|NaN)\b|\bnull\b/;

// 自证入口：`node lib/report.test.mjs --demo` 直接把 fixture 的完整报告打到 stdout。
// 用 process.exit 在测试注册后、runner 启动前退出，所以输出是干净的（无 TAP 噪声）。
if (process.argv.includes("--demo")) {
  process.stdout.write(`${renderFull(fixture())}\n`);
  process.stdout.write(`${"-".repeat(64)}\n`);
  process.stdout.write(`${renderBrief(fixture())}\n`);
  process.exit(0);
}

// ───────────────────────────── 1. displayWidth ─────────────────────────────

test("displayWidth：ASCII / 中文 / 混排 / 空值", () => {
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth(null), 0);
  assert.equal(displayWidth(undefined), 0);
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("北京"), 4, "两个汉字 = 4 列");
  assert.equal(displayWidth("a北b京"), 6, "混排：1+2+1+2");
  assert.equal(displayWidth("Boss直聘"), 8);
  assert.equal(displayWidth("智联招聘"), 8);
  assert.equal(displayWidth("（未命名岗位）"), 14, "全角括号也是 2 列");
  assert.equal(displayWidth("北京·海淀"), 9, "间隔号 U+00B7 按窄字符算 1 列（Ambiguous=Narrow 约定）");
  assert.equal(displayWidth("≥20k"), 4, "≥ 是 Ambiguous → 按窄算 1 列");
  assert.equal(displayWidth("█░"), 2, "方块元素算 1 列");
  assert.equal(displayWidth("▁▂▃▄▅▆▇█"), 8, "火花线字符算 1 列");
  assert.equal(displayWidth("│─┼─"), 4, "制表符算 1 列");
  assert.equal(displayWidth("…"), 1, "省略号算 1 列");
  assert.equal(displayWidth("🎯"), 2, "emoji 算 2 列");
  assert.equal(displayWidth("e\u0301"), 1, "组合符不占列");
  assert.equal(displayWidth(1234), 4, "数字也能测");
});

test("displayWidth：变体选择符 U+FE0F 把窄基字符升级为 2 列（⚠️ vs ⚠）", () => {
  assert.equal(displayWidth("\u26a0"), 1, "单独的 ⚠ 是文本呈现，1 列");
  assert.equal(displayWidth("\u26a0\ufe0f"), 2, "⚠ + VS16 是 emoji 呈现，2 列");
  assert.notEqual(displayWidth("\u26a0\ufe0f"), displayWidth("\u26a0"));
  assert.equal(displayWidth("\u2705"), 2, "✅ 本身是宽 emoji");
  assert.equal(displayWidth("\u2705\ufe0f"), 2, "加了 VS16 也是 2，不能翻倍");
  assert.equal(displayWidth("\u26a0\ufe0e"), 1, "VS15 强制文本呈现，仍 1 列");
  assert.equal(displayWidth("a\u200bb"), 2, "零宽空格不占列");
  assert.equal(displayWidth("\ufeffx"), 1, "BOM 不占列");
  // 截断不得把 ⚠️ 从中间切开
  const emoji = "\u26a0\ufe0f\u26a0\ufe0f\u26a0\ufe0f";
  const cut = truncateW(emoji, 4);
  assert.ok(displayWidth(cut) <= 4, `宽度 ≤ 4，实际 ${displayWidth(cut)}`);
  assert.ok(cut.endsWith("…"));
  const body = cut.replace(/…$/, "");
  assert.ok(emoji.startsWith(body));
  assert.ok(!["\ufe0f", "\ufe0e", "\u200b"].includes(emoji.charAt(body.length)), "不得切断字素簇");
  assert.equal(truncateW(emoji, 5), "\u26a0\ufe0f\u26a0\ufe0f…", "两个完整簇 + 省略号 = 5 列");
});

test("不变量：displayWidth(padEndW(s, n)) === n 对任意样本与任意 n 成立", () => {
  const samples = [
    "",
    "abc",
    "北京",
    "智联招聘",
    "Boss直聘",
    "前端工程师（Vue）",
    "北京·海淀",
    "180-220元/天",
    "████████░░░░░░░",
    "▁▂▃▄▅▆▇█",
    "│─┼─",
    "…",
    "🎯 emoji",
    "\u26a0\ufe0f 告警",
    "e\u0301 combining",
    "混合 mixed 文本 123",
  ];
  for (const s of samples) {
    for (const n of [0, 1, 2, 3, 7, 12, 20, 41]) {
      assert.equal(displayWidth(padEndW(s, n)), Math.max(n, displayWidth(s)), `样本 ${JSON.stringify(s)} / n=${n}`);
      assert.ok(displayWidth(truncateW(s, n)) <= n, `截断必须 ≤ ${n}：${JSON.stringify(s)}`);
    }
  }
});

test("displayWidth 与 pad / truncate 组合：CJK 与 ASCII 对齐到同一列宽", () => {  const rows = [["平台", "zhilian"], ["Boss直聘", "boss"], ["猎聘", "liepin"]];
  const widths = rows.map((r) => displayWidth(padEndW(r[0], 10)));
  assert.deepEqual(widths, [10, 10, 10], "不同文字补到相同显示宽度");

  const padded = padEndW("北京", 6);
  assert.equal(padded, "北京  ");
  assert.equal(displayWidth(padded), 6);
  assert.equal(padEndW("abcdef", 3), "abcdef", "padEndW 不截断");
  assert.equal(padEndW(null, 3), "   ");
  assert.equal(padStartW("7", 3), "  7");
  assert.equal(displayWidth(padStartW("12", 6)), 6);
});

test("truncateW：按显示宽度截断并补 …，宽度绝不超过上限", () => {
  const long = "北京星海科技有限公司";
  const cut = truncateW(long, 10);
  assert.ok(displayWidth(cut) <= 10, `截断后宽度 ${displayWidth(cut)} 应 ≤ 10`);
  assert.ok(cut.endsWith("…"));
  assert.ok(cut.startsWith("北京"));

  assert.equal(truncateW("abc", 5), "abc", "不超长则原样返回");
  assert.equal(truncateW("abcdef", 0), "");
  assert.ok(displayWidth(truncateW("北京", 1)) <= 1, "极限宽度不越界");
  assert.ok(displayWidth(truncateW("很长很长很长的岗位名称", 8)) <= 8);
  // 4 个汉字 = 8 列，正好放下，不截断
  assert.equal(truncateW("北京星海", 8), "北京星海");
  assert.equal(truncateW("北京星海科", 8).endsWith("…"), true);
});

// ───────────────────────────── 2. 薪资分桶边界 ─────────────────────────────

test("salaryBucket：null / 缺失 / 非法值一律进「薪资未明」，不混进 0", () => {
  for (const v of [null, undefined, "", "  ", "abc", NaN, {}]) {
    assert.equal(salaryBucket(v), UNKNOWN_SALARY_LABEL, `${JSON.stringify(v)} 应为薪资未明`);
  }
  assert.notEqual(salaryBucket(null), salaryBucket(0), "0 元与未解析必须可区分");
  assert.equal(salaryBucket(0), "<7k");
});

test("salaryBucket：7000/9000/12000/15000/20000 的边界归属", () => {
  assert.equal(salaryBucket(0), "<7k");
  assert.equal(salaryBucket(6999), "<7k");
  assert.equal(salaryBucket(7000), "7-9k", "7000 恰好进 7-9k（左闭）");
  assert.equal(salaryBucket(8999), "7-9k");
  assert.equal(salaryBucket(9000), "9-12k", "9000 恰好进 9-12k");
  assert.equal(salaryBucket(11999), "9-12k");
  assert.equal(salaryBucket(12000), "12-15k", "12000 恰好进 12-15k");
  assert.equal(salaryBucket(14999), "12-15k");
  assert.equal(salaryBucket(15000), "15-20k", "15000 恰好进 15-20k");
  assert.equal(salaryBucket(19999), "15-20k");
  assert.equal(salaryBucket(20000), "≥20k", "20000 恰好进 ≥20k");
  assert.equal(salaryBucket(999999), "≥20k");
  // 字符串数字也认
  assert.equal(salaryBucket("11000"), "9-12k");
});

test("SALARY_BUCKETS 顺序与标签稳定（页面/文档依赖它）", () => {
  assert.deepEqual(
    SALARY_BUCKETS.map((b) => b.label),
    ["<7k", "7-9k", "9-12k", "12-15k", "15-20k", "≥20k"],
  );
});

// ───────────────────────────── 3. 时间戳 ─────────────────────────────

test("parseStamp / fmtStamp：本地时间不被时区挪走，坏值给占位符", () => {
  const st = parseStamp("2026-03-04T09:12:00");
  assert.equal(st.y, 2026);
  assert.equal(st.mo, 3);
  assert.equal(st.d, 4);
  assert.equal(fmtStamp("2026-03-04T09:12:00", "datetime"), "2026-03-04 09:12");
  assert.equal(fmtStamp("2026-03-04T09:12:00", "mdhm"), "03-04 09:12");
  assert.equal(fmtStamp("2026-03-04", "date"), "2026-03-04");
  assert.equal(fmtStamp(null), "—");
  assert.equal(fmtStamp(""), "—");
  assert.equal(fmtStamp("not-a-date"), "—");
  assert.equal(parseStamp("not-a-date"), null);
});

// ───────────────────────────── 4. 明细表对齐 ─────────────────────────────

test("renderJobTable：7 列 6 个分隔符，中英混排行宽完全对齐", () => {
  const jobs = [
    {
      platform: "zhaopin", platformLabel: "智联招聘", title: "前端开发工程师", company: "Beijing StarSea Tech Co Ltd",
      locationRaw: "北京·海淀", salaryRaw: "1.1-1.3万", decision: "applied", appliedAtDisplay: "03-04 09:12",
      salaryIsDaily: false, misapplied: "",
    },
    {
      platform: "boss", platformLabel: "Boss直聘", title: "Senior Frontend Engineer 高级前端", company: "星海",
      locationRaw: "太原·小店", salaryRaw: "9-18k·14薪", decision: "pending", appliedAtDisplay: "—",
      salaryIsDaily: false, misapplied: "",
    },
    {
      platform: "liepin", platformLabel: "猎聘", title: "数据分析师", company: "某某某某某科技有限公司", locationRaw: "北京",
      salaryRaw: "面议", decision: "skipped", appliedAtDisplay: "—", salaryIsDaily: false,
      misapplied: "薪资低于阈值，规则排除", 
    },
  ];
  const text = renderJobTable(jobs, { width: 100 });
  const all = text.split("\n");
  const dividers = all.filter((l) => sepOffsets(l).length > 0);
  assert.equal(dividers.length, 5, "表头 + 分隔行 + 3 行数据");

  const reference = sepOffsets(dividers[0]);
  assert.equal(reference.length, 6, "7 列应有 6 个列分隔符");
  for (const l of dividers) {
    assert.deepEqual(sepOffsets(l), reference, `列错位：${l}`);
  }
  assert.ok(text.includes("…"), "超长公司名/岗位名被截断并加省略号");
  assert.ok(!BAD_LITERAL.test(text), "表格里不能出现 undefined/NaN/null 字面量");
});

test("renderJobTable：误投行带原因、日薪行带标记、超长行数截断有提示", () => {
  const f = fixture();
  const text = renderJobTable(f.jobs, {});
  assert.ok(text.includes("[!误投]"), "误投行必须有显眼标记");
  assert.ok(text.includes("↳ 误投原因："), "误投必须给出原因");
  assert.ok(text.includes("[日薪]"), "日薪岗位必须标出");

  const limited = renderJobTable(f.jobs, { top: 5 });
  assert.ok(limited.includes("另有 9 条未显示"), `top 生效：${limited.split("\n").pop()}`);
  assert.equal(limited.split("\n").filter((l) => l.includes("│")).length, 6, "表头 + 5 行");

  assert.equal(renderJobTable([], {}), "  （无岗位）");
});

// ───────────────────────────── 5. 分桶在真实渲染里的体现 ─────────────────────────────

test("renderFull：薪资直方图分桶计数正确，日薪单独一条不进月薪桶", () => {
  const text = renderFull(fixture());
  const rows = sectionLines(text, "薪资分布");
  const parsed = new Map();
  for (const l of rows) {
    const m = /^ {2}(\S+)\s+│.*│\s*(\d+)\s*$/.exec(l);
    if (m) parsed.set(m[1], Number(m[2]));
  }
  assert.equal(parsed.get("<7k"), 1);
  assert.equal(parsed.get("7-9k"), 3);
  assert.equal(parsed.get("9-12k"), 2);
  assert.equal(parsed.get("12-15k"), 2);
  assert.equal(parsed.get("15-20k"), 2);
  assert.equal(parsed.get("≥20k"), 1);
  assert.equal(parsed.get(UNKNOWN_SALARY_LABEL), 2, "salaryMin=null 与字段缺失共 2 条，单独成桶");
  const monthlyTotal = [...parsed.values()].reduce((a, b) => a + b, 0);
  assert.equal(monthlyTotal, 13, "14 条岗位中 1 条日薪被排除在月薪直方图外");
  assert.ok(text.includes("日薪 1 单未计入"), "小节标题必须声明日薪未计入");
  assert.ok(text.includes("日薪样本：180-220元/天"), "日薪样本单独说明，不混进月薪桶");
  // 日薪的 180 绝不能混进月薪桶行（样本说明行可以提，桶行不行）
  const bucketRows = rows.filter((l) => /^ {2}(<7k|7-9k|9-12k|12-15k|15-20k|≥20k|薪资未明)\s+│/.test(l));
  assert.equal(bucketRows.length, 7, "6 个月薪桶 + 薪资未明");
  assert.ok(!bucketRows.some((l) => l.includes("180-220")), "日薪数值不得出现在月薪桶行里");
});

test("renderFull：投递时间线只统计 kind=applied，失败事件不得虚增投递量", () => {
  const f = fixture();
  const text = renderFull(f);
  const rows = sectionLines(text, "投递时间线");
  const sparkLine = rows.find((l) => /[▁▂▃▄▅▆▇█]/.test(l));
  assert.ok(sparkLine.includes("7 单"), `时间线只应统计 7 条 kind=applied 事件：${sparkLine}`);
  assert.ok(sparkLine.includes("8 天"));
  assert.ok(!sparkLine.includes("22 单") && !sparkLine.includes("26 单"), "失败事件被算进去了");

  // 日志里有 26 条事件，但投递只有 8 条（其中 7 条有时间）—— 两者必须分开陈述
  assert.match(text, /投递事件\s+8\s+kind=applied/, "概览里的投递事件按 kind 过滤");
  assert.match(text, /日志事件\s+26/, "概览里的日志事件是全部事件");
  const logRows = sectionLines(text, "日志事件构成");
  assert.ok(logRows.some((l) => l.includes("导航超时(nav_timeout)") && l.includes("8")));
  assert.ok(logRows.some((l) => l.includes("列表内已无(miss)") && l.includes("6")));
  assert.ok(logRows.some((l) => l.includes("导航超时 8 次 · 列表内已无 6 次")));
  assert.ok(logRows.some((l) => l.includes("命中关键词")), "关键词命中率线索");
});

test("title 为 null 的失败事件不进入明细表（明细表数据源是 jobs，不是 applied）", () => {
  const f = fixture();
  const text = renderFull(f);
  const tableLines = text
    .slice(text.indexOf("── 岗位明细"))
    .split("\n")
    .filter((l) => l.includes("│"));
  // 表头 + 14 行岗位
  assert.equal(tableLines.length, 15, `明细表应只有 jobs 的 14 行，实际 ${tableLines.length - 1} 行`);
  assert.ok(text.includes("── 岗位明细（14 条）"));
  assert.ok(!text.includes("没有 kind 的事件"), "事件标题不得混进明细表");
  assert.ok(!tableLines.some((l) => l.includes("导航超时") || l.includes("列表内已无")));
});

test("renderFull：地点分布按计数降序，北京·海淀 居首", () => {
  const rows = sectionLines(renderFull(fixture()), "地点分布");
  const counts = [];
  for (const l of rows) {
    const m = /^ {2}(\S+)\s+│.*│\s*(\d+)\s*$/.exec(l);
    if (m) counts.push({ label: m[1], count: Number(m[2]) });
  }
  assert.equal(counts[0].label, "北京·海淀");
  assert.equal(counts[0].count, 4);
  const nums = counts.map((c) => c.count);
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a), "必须降序");
  assert.equal(nums.reduce((a, b) => a + b, 0), 14);
});

test("renderFull：平台分布含计数与占比，判定构成四项齐全", () => {
  const text = renderFull(fixture());
  const p = sectionLines(text, "平台分布");
  assert.equal(p.length, 3, "3 个平台");
  assert.ok(p[0].includes("智联招聘") && p[0].includes("6") && p[0].includes("42.9%"), p[0]);
  assert.ok(text.includes("Boss直聘") && text.includes("猎聘"));

  const d = sectionLines(text, "判定构成");
  assert.equal(d.length, 4);
  assert.ok(d.some((l) => l.includes("已投递") && l.includes("6")));
  assert.ok(d.some((l) => l.includes("待投") && l.includes("4")));
  assert.ok(d.some((l) => l.includes("已排除") && l.includes("3")));
  assert.ok(d.some((l) => l.includes("未知") && l.includes("1")));
});

test("renderFull：火花线用 ▁▂▃▄▅▆▇█ 且标出峰值日", () => {
  const text = renderFull(fixture());
  const rows = sectionLines(text, "投递时间线");
  const spark = rows.find((l) => /[▁▂▃▄▅▆▇█]/.test(l));
  assert.ok(spark, "必须有火花线");
  assert.equal([...spark].filter((c) => "▁▂▃▄▅▆▇█".includes(c)).length, 8, "03-02~03-09 共 8 天");
  assert.ok(rows.some((l) => l.includes("峰值：2026-03-04（3 单）")), `峰值行缺失：${JSON.stringify(rows)}`);
  assert.ok(rows.some((l) => l.includes("有投递的日期")), "完整报告列出有投递的日期");
  assert.ok(rows.some((l) => l.includes("1 条投递事件缺时间")), "坏时间戳要如实说明，不能静默丢");
});

test("renderFull：四类可视化齐全 + 明细表 + 告警分节", () => {
  const text = renderFull(fixture());
  for (const sec of ["概览", "平台分布", "判定构成", "薪资分布", "地点分布", "投递时间线", "日志事件构成", "岗位明细", "误投与被排除", "解析告警"]) {
    assert.ok(text.includes(`── ${sec}`), `缺少小节：${sec}`);
  }
  assert.ok(text.includes("█") && text.includes("░"), "条形图必须有 █ 与 ░");
  assert.ok(text.includes("[!误投]") && text.includes("误投原因"));
  assert.ok(text.includes("[警告] 台账明细:12") && text.includes("[错误] run-zp-B.log:88"));
  assert.ok(!BAD_LITERAL.test(text), "报告里禁止出现 undefined/NaN/null 字面量");
  assert.ok(!/\u001b\[/.test(text), "不得输出 ANSI 转义");
  assert.ok(text.includes("生成 2026-03-12 18:30 · 3 个数据源"));
});

// ───────────────────────────── 6. renderBrief 行数预算 ─────────────────────────────

test("renderBrief：fixture 下 ≤ 25 行且四块内容都在", () => {
  const text = renderBrief(fixture());
  const n = text.split("\n").length;
  assert.ok(n <= 25, `renderBrief 应 ≤ 25 行，实际 ${n} 行`);
  assert.ok(text.includes("── 平台分布"));
  assert.ok(text.includes("── 薪资分布"));
  assert.ok(text.includes("── 地点分布"));
  assert.ok(text.includes("── 投递时间线"));
  assert.ok(text.includes("[警告]"));
  assert.ok(text.includes("日志："), "brief 也要能看到失败面");
  assert.ok(text.includes("岗位 14 · 判定 已投6/待投4/排除3/未知1 · 投递事件 8 · 日志事件 26 · 告警 2"), text.split("\n")[1]);
  assert.ok(!BAD_LITERAL.test(text));
});

test("renderBrief：极端数据（200 岗位 / 60 地点 / 40 告警）仍然 ≤ 25 行", () => {
  const text = renderBrief(bigPayload());
  const n = text.split("\n").length;
  assert.ok(n <= 25, `极端数据也应 ≤ 25 行，实际 ${n} 行`);
  assert.ok(!BAD_LITERAL.test(text));
});

test("renderBrief：预算收紧（briefLines=20）时按优先级丢区块并显式说明", () => {
  const text = renderBrief(bigPayload(), { briefLines: 20 });
  const lines = text.split("\n");
  assert.ok(lines.length <= 20, `实际 ${lines.length} 行`);
  assert.ok(text.includes("已省略"), "被省略的区块要显式提示，不能悄悄少给");
  assert.ok(lines.some((l) => l.includes("投递数据看板")), "标题必须保住");
  assert.ok(text.includes("── 平台分布"), "高优先级图表先于地点分布保留");
  assert.ok(text.includes("── 解析告警"), "告警优先级高于图表");
});

test("renderBrief：schemaVersion 不符时顶部显式警告", () => {
  const text = renderBrief({ ...fixture(), schemaVersion: 99 });
  assert.ok(text.includes("契约版本不符"), "必须显示版本警告");
  assert.ok(text.includes(`预期 v1`));
  assert.ok(text.includes("v99"));
  const missing = renderBrief({ jobs: [] });
  assert.ok(missing.includes("契约版本不符") && missing.includes("缺失"));
  // 版本一致时不出现
  assert.ok(!renderBrief(fixture()).includes("契约版本不符"));
});

// ───────────────────────────── 7. 过滤 ─────────────────────────────

test("opts 过滤：platform / city / decision / top，且支持中文平台别名", () => {
  const f = fixture();
  const boss = renderBrief(f, { platform: "boss" });
  assert.ok(boss.includes("岗位 5"), boss.split("\n")[2] ?? boss);
  assert.ok(boss.includes("筛选：平台=Boss直聘"));

  const alias = renderBrief(f, { platform: "智联" });
  assert.ok(alias.includes("岗位 6"), "中文别名应能识别");

  const skipped = renderBrief(f, { decision: "skipped" });
  assert.ok(skipped.includes("岗位 3"));

  const haidian = renderBrief(f, { city: "海淀" });
  assert.ok(haidian.includes("岗位 4"));

  const cityDistrict = renderBrief(f, { city: "太原·小店" });
  assert.ok(cityDistrict.includes("岗位 3"), "city 支持 city·district");

  const none = renderBrief(f, { city: "不存在的城市" });
  assert.ok(none.includes("岗位 0"), "过滤到空也要正常输出");
  assert.ok(!BAD_LITERAL.test(none));

  const full = renderFull(f, { platform: "liepin", top: 2 });
  assert.ok(full.includes("（3 条，显示前 2 条）"), "top 限制明细表行数");
  assert.ok(full.includes("另有 1 条未显示"));
  assert.ok(full.includes("筛选：平台=猎聘"));

  // 地点/判定筛选不作用于投递事件（事件只有平台字段），必须显式说明
  assert.ok(renderBrief(f, { city: "海淀" }).includes("地点/判定筛选不作用于时间线"), "筛选地点后必须说明时间线口径");
  assert.ok(renderBrief(f, { decision: "skipped" }).includes("地点/判定筛选不作用于时间线"));
  assert.ok(!renderBrief(f, { platform: "boss" }).includes("地点/判定筛选不作用于时间线"), "仅平台筛选不影响时间线口径");
  const withEvents = renderFull(f, { platform: "boss", city: "海淀" });
  assert.ok(withEvents.includes("地点/判定筛选不作用于时间线"));
});

// ───────────────────────────── 8. 空数据 / 脏数据降级 ─────────────────────────────

test("空 payload 不崩：renderBrief / renderFull 都给出占位而不是异常", () => {
  for (const p of [{}, { jobs: [], applied: [], warnings: [], schemaVersion: 1 }, null, undefined, "x", 42]) {
    const brief = renderBrief(p);
    const full = renderFull(p);
    assert.ok(brief.split("\n").length <= 25);
    assert.ok(brief.includes("暂无岗位数据") || brief.includes("契约版本不符"));
    assert.ok(full.includes("（无岗位）"));
    assert.ok(!BAD_LITERAL.test(brief), `brief 出现坏字面量：${brief}`);
    assert.ok(!BAD_LITERAL.test(full), `full 出现坏字面量：${full}`);
  }
});

test("脏数据（null 元素 / 错类型字段 / 坏时间）不崩且不泄漏字面量", () => {
  const dirty = {
    schemaVersion: "1",
    generatedAt: 12345,
    jobs: [
      null,
      42,
      "字符串岗位",
      {},
      { platform: "unknown-site", title: null, company: undefined, city: 0, salaryMin: "abc", salaryMax: NaN, salaryIsDaily: "yes", decision: "bogus", appliedAt: "???" },
      { platform: "boss", title: "正常岗位", company: "正常公司", salaryMin: 12000, salaryMax: 15000, decision: "applied", appliedAt: "2026-13-45T99:99:99" },
    ],
    applied: [null, {}, { at: "" }, { platform: "boss", at: "2026-03-04T09:00:00" }],
    warnings: [null, { level: "fatal", message: "" }, { level: "error", source: "x.log", message: "boom" }],
    sources: "not-an-object",
  };
  const full = renderFull(dirty);
  const brief = renderBrief(dirty);
  assert.ok(!BAD_LITERAL.test(full), `full 泄漏字面量：\n${full}`);
  assert.ok(!BAD_LITERAL.test(brief), `brief 泄漏字面量：\n${brief}`);
  assert.ok(full.includes("── 岗位明细"));
  assert.ok(brief.split("\n").length <= 25);
  assert.ok(full.includes("未知平台") === false, "未知平台直接显示原始键即可");
  assert.ok(full.includes("unknown-site"));
  assert.ok(full.includes("（无说明）"), "空告警说明要占位");
  assert.ok(brief.includes("生成 时间未提供") || full.includes("生成 时间未提供"));
});

test("payload 非对象 / jobs 非数组 / sources 形状异常都安全", () => {
  assert.ok(renderFull({ jobs: "not-an-array", applied: {}, warnings: 7, sources: [1, 2] }).includes("（无岗位）"));
  assert.ok(renderBrief().includes("暂无岗位数据"));
  assert.ok(renderFull({ jobs: [{ title: "只有标题" }] }).includes("只有标题"));
});

// ───────────────────────────── 9. 文本卫生 ─────────────────────────────

test("输出是纯文本：无 ANSI、无控制字符、无尾随空格", () => {
  const text = renderFull(fixture());
  assert.ok(!/\u001b/.test(text), "无 ESC");
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), "无控制字符");
  const trailing = text.split("\n").filter((l) => /\s$/.test(l));
  assert.deepEqual(trailing, [], "不应有行尾空格（表格行以数字/标记收尾）");
});

test("表格列对齐不变量：所有数据行的 │ 偏移完全一致（中文/英文/标记行都不错位）", () => {
  const text = renderFull(fixture());
  const table = text.slice(text.indexOf("── 岗位明细"));
  const lines = table.split("\n").slice(1).filter((l) => l.includes("│"));
  assert.ok(lines.length >= 15, "表头 + 14 行岗位");
  const reference = sepOffsets(lines[0]);
  assert.equal(reference.length, 6, "7 列 6 个分隔符");
  for (const l of lines) {
    assert.deepEqual(sepOffsets(l), reference, `列错位：${JSON.stringify(l)}`);
  }
  // 带 [!误投]/[日薪] 标记的行，标记必须在表格宽度之外，不能挤动列
  const marked = lines.filter((l) => l.includes("[!误投]") || l.includes("[日薪]"));
  assert.ok(marked.length >= 2, "fixture 里有误投行与日薪行");
  for (const l of marked) assert.deepEqual(sepOffsets(l), reference);
});
