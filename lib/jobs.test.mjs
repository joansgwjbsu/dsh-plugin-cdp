/**
 * dsh-plugin-cdp — lib/jobs.mjs + lib/logs.mjs 单元测试
 *
 * 运行：node --test D:\dsh\dsh-plugin-cdp\lib\jobs.test.mjs
 *
 * 覆盖：
 *   1. parseSalary 契约里列出的**全部**真实样本（含日薪、多区间、面议）
 *   2. 平台归一（智联/Boss/猎聘/文件名/ZP 前缀）与空值写法
 *   3. 台账四种表格形状：明细 / 已投递 / 误投 / 核验（含粗体剥离、地点括注拆分）
 *   4. 去重合并：applied > pending > skipped、已投时间取最早的真实时刻、keywords 并集
 *   5. warnings：解析不了的行/表都要有 source + message + line
 *   6. 日志事件：kind / keyword 传播 / title=null / 多行 steps / 日期补全推断告警
 *   7. 真实数据集成：jobs ≥ 30、kind=applied ≥ 20、契约字段形状、确定性、sources 为数组
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { DECISIONS, LOG_EVENT_KINDS, PLATFORMS, SCHEMA_VERSION, parseSalary } from "./contract.mjs";
import { eventsFromLogs, extract, jobIdOf, jobsFromAppliedNdjson, jobsFromLedger, mergeJobRecords, DEFAULT_WINDOW_DATE } from "./jobs.mjs";
import {
  blankOf,
  dateFromText,
  isoFromParts,
  normalizePlatform,
  parseLogText,
  plainText,
  platformFromFileName,
  timeFromText,
} from "./logs.mjs";

const JW_DIR = fileURLToPath(new URL("../../jw/", import.meta.url));
const LEDGER_PATH = join(JW_DIR, "投递台账.md");

/** 契约 JobRecord 的字段集合（顺序不强制，但集合必须一致）。 */
const JOB_KEYS = [
  "id", "platform", "title", "company", "city", "district", "locationRaw", "salaryRaw",
  "salaryMin", "salaryMax", "salaryMonths", "salaryIsDaily", "experience", "education",
  "decision", "basis", "appliedAt", "receipt", "misapplied", "keywords", "source",
];
/** 契约 AppliedEvent 的字段集合。 */
const EVENT_KEYS = [
  "platform", "kind", "title", "salaryRaw", "salaryMin", "salaryMax", "at", "verified", "keyword",
];
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function assertWarningShape(warning) {
  assert.ok(["info", "warn", "error"].includes(warning.level), `非法 level: ${warning.level}`);
  assert.equal(typeof warning.source, "string");
  assert.ok(warning.source.length > 0, "warning.source 不能为空");
  assert.equal(typeof warning.message, "string");
  assert.ok(warning.message.length > 0, "warning.message 不能为空");
  assert.ok(typeof warning.line === "number" || warning.line === "", "warning.line 必须是数字或空串");
}

function keysOf(object) {
  return Object.keys(object).sort();
}

/* ------------------------------------------------------------------ *
 * 1. parseSalary：契约 JSDoc 列出的全部真实样本
 * ------------------------------------------------------------------ */

test("parseSalary 覆盖契约里的全部真实样本", () => {
  const samples = [
    ["1.1-1.3万", 11000, 13000, 12, false],
    ["8000-12000元", 8000, 12000, 12, false],
    ["8000-12000元·13薪", 8000, 12000, 13, false],
    ["1-1.5万·13薪", 10000, 15000, 13, false],
    ["9000-13000元", 9000, 13000, 12, false],
    ["1.2-1.3万", 12000, 13000, 12, false],
    ["1.5-3万·14薪", 15000, 30000, 14, false],
    ["6001-7000元", 6001, 7000, 12, false],
    ["9-18k·14薪", 9000, 18000, 14, false],
    ["10-12k", 10000, 12000, 12, false],
    ["8-13k", 8000, 13000, 12, false],
    ["180-220元/天", 180, 220, 12, true],
    ["面议", null, null, 12, false],
    ["—", null, null, 12, false],
    ["", null, null, 12, false],
    ["7000-11000元·13薪", 7000, 11000, 13, false],
    ["1-1.2万", 10000, 12000, 12, false],
    ["9000-11000元", 9000, 11000, 12, false],
    ["1.2-1.4万·13薪", 12000, 14000, 13, false],
    ["2.3-2.5万·13薪", 23000, 25000, 13, false],
    ["8000-9000元", 8000, 9000, 12, false],
    ["1-2万·14薪", 10000, 20000, 14, false],
    ["1-1.8万", 10000, 18000, 12, false],
    ["1.1-1.8万", 11000, 18000, 12, false],
    ["8000-16000元", 8000, 16000, 12, false],
    ["9000-10000 / 1-1.1万", 9000, 10000, 12, false],
    ["6000-7000 / 6000-8000元", 6000, 7000, 12, false],
    // 台账里另外出现过的真实串
    ["2.5-3万", 25000, 30000, 12, false],
    ["1-1.7万", 10000, 17000, 12, false],
    ["6000-8000元·13薪", 6000, 8000, 13, false],
    ["3000-6000元", 3000, 6000, 12, false],
    ["6000-7000元·14薪", 6000, 7000, 14, false],
  ];
  for (const [raw, min, max, months, daily] of samples) {
    assert.deepEqual(
      parseSalary(raw),
      { salaryMin: min, salaryMax: max, salaryMonths: months, salaryIsDaily: daily },
      `parseSalary(${JSON.stringify(raw)}) 不符合契约`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 2. 文本 / 平台 / 时间归一
 * ------------------------------------------------------------------ */

test("平台归一：智联 / Boss / 猎聘 / 未知", () => {
  assert.equal(normalizePlatform("智联"), "zhaopin");
  assert.equal(normalizePlatform("智联[B]"), "zhaopin");
  assert.equal(normalizePlatform("zhaopin 调度器启动"), "zhaopin");
  assert.equal(normalizePlatform("Boss"), "boss");
  assert.equal(normalizePlatform("Boss直聘"), "boss");
  assert.equal(normalizePlatform("boss直聘"), "boss");
  assert.equal(normalizePlatform("猎聘"), "liepin");
  assert.equal(normalizePlatform("liepin 调度器启动"), "liepin");
  assert.equal(normalizePlatform("boss"), "boss");
  assert.equal(normalizePlatform("前程无忧"), "");
  assert.equal(normalizePlatform(""), "");
  assert.equal(normalizePlatform(null), "");
});

test("平台归一：从日志文件名推断", () => {
  assert.equal(platformFromFileName("run-zp-B.log"), "zhaopin");
  assert.equal(platformFromFileName("run-zp-VERIFY.log"), "zhaopin");
  assert.equal(platformFromFileName("run-zhaopin.log"), "zhaopin");
  assert.equal(platformFromFileName("run-boss.log"), "boss");
  assert.equal(platformFromFileName("run-liepin.log"), "liepin");
  assert.equal(platformFromFileName("run-all.log"), "");
  assert.equal(platformFromFileName("run-zp-2026-10-13.log"), "zhaopin");
});

test("markdown 清洗与空值写法", () => {
  assert.equal(plainText("**A7**"), "A7");
  assert.equal(plainText("**1-2万·14薪**"), "1-2万·14薪");
  assert.equal(plainText("慧策\\|旺店通"), "慧策|旺店通");
  assert.equal(plainText("`code` 文本"), "code 文本");
  assert.equal(blankOf("—"), "");
  assert.equal(blankOf("  "), "");
  assert.equal(blankOf("面议"), "面议");
  assert.equal(blankOf("**本科**"), "本科");
});

test("时间归一：HH:mm / HH:mm:ss / 日期", () => {
  assert.equal(timeFromText("10:29:24"), "10:29:24");
  assert.equal(timeFromText("9:05"), "09:05:00");
  assert.equal(timeFromText("2026-10-13 09:21"), "09:21:00");
  assert.equal(timeFromText("1-1.5万"), "");
  assert.equal(dateFromText("2026-10-13 09:21"), "2026-10-13");
  assert.equal(dateFromText("10-11 / 10-12"), "");
  assert.equal(isoFromParts("2026-10-13", "10:29:24"), "2026-10-13T10:29:24");
  assert.equal(isoFromParts("2026-10-13", ""), "2026-10-13T00:00:00");
  assert.equal(isoFromParts("", "10:29:24"), "");
});

/* ------------------------------------------------------------------ *
 * 3. 台账解析
 * ------------------------------------------------------------------ */

const LEDGER_FIXTURE = [
  "# 测试台账",
  "",
  "## 台账明细",
  "",
  "| # | 平台 | 岗位 | 公司 | 城市·区域 | 薪资 | 经验 | 学历 | 判定 | 依据 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 1 | 智联 | 云平台运维工程师 | 重庆软维科技 | 北京·海淀 | 1.1-1.3万 | 3-5年 | 大专 | skipped | 夜班轮值排除 |",
  "| 2 | Boss直聘 | 网络工程师 | 某公司 | 太原·小店 | 8000-12000元·13薪 | **5-10年** | — | pending | 合规 |",
  "| 3 | 猎聘 | 桌面运维 | 另一公司 | 北京 | 面议 | — | — | skipped | — |",
  "| 4 | 前程无忧 | 未知岗 | 某公司 | 北京 | 9000-11000元 | 1-3年 | 大专 | pending | 平台不识别 |",
  "| 5 | 智联 | 日薪岗 | 某公司 | 北京·朝阳 | 180-220元/天 | — | — | skipped | 日薪排除 |",
  "",
  "## 已投递（applied）",
  "",
  "| # | 平台 | 岗位 | 公司 | 城市·区域 | 薪资 | 经验 | 学历 | 投递时间 | 回执 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| **A1** | 智联 | 网络运维工程师 | 北京京必达科技有限公司 | 北京·房山区 | 1-1.8万 | 经验不限 | 学历不限 | 本轮 | 已向对方发送简历和打招呼语 |",
  "| A2 | 智联 | 网络运维工程师 | 北京京必达科技有限公司 | 北京·房山区 | 1-1.8万 | 经验不限 | 学历不限 | 2026-10-12 09:00 | 已投递 |",
  "",
  "## 误投记录（必须处理）",
  "",
  "| 编号 | 平台 | 岗位 | 公司 | 薪资 | 误投原因 | 状态 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| **X1** | 智联 | 售前销售经理 | 山西琦兰科技有限公司（太原·万柏林） | 6000-10000元 | 投错了岗位 | 已投递，需撤回 |",
  "",
  "## 核验",
  "",
  "| 岗位 | 公司 | 薪资 | 状态 | 时间 |",
  "| --- | --- | --- | --- | --- |",
  "| 云运维工程师 | 中电金信 | 1.2-1.4万·13薪 | **已投递** | 2026-10-09 11:14 |",
  "",
].join("\n");

test("台账明细：字段抽取、粗体剥离、空值、行数核对", () => {
  const result = jobsFromLedger(LEDGER_FIXTURE, "fixture.md");
  const first = result.jobs.find((job) => job.title === "云平台运维工程师");
  assert.deepEqual(
    {
      id: first.id,
      platform: first.platform,
      company: first.company,
      city: first.city,
      district: first.district,
      locationRaw: first.locationRaw,
      salaryRaw: first.salaryRaw,
      salaryMin: first.salaryMin,
      salaryMax: first.salaryMax,
      salaryMonths: first.salaryMonths,
      salaryIsDaily: first.salaryIsDaily,
      experience: first.experience,
      education: first.education,
      decision: first.decision,
      basis: first.basis,
      appliedAt: first.appliedAt,
      receipt: first.receipt,
      misapplied: first.misapplied,
      keywords: first.keywords,
      source: first.source,
    },
    {
      id: "zhaopin:云平台运维工程师:重庆软维科技",
      platform: "zhaopin",
      company: "重庆软维科技",
      city: "北京",
      district: "海淀",
      locationRaw: "北京·海淀",
      salaryRaw: "1.1-1.3万",
      salaryMin: 11000,
      salaryMax: 13000,
      salaryMonths: 12,
      salaryIsDaily: false,
      experience: "3-5年",
      education: "大专",
      decision: "skipped",
      basis: "夜班轮值排除",
      appliedAt: null,
      receipt: "",
      misapplied: "",
      keywords: [],
      source: "台账明细",
    },
  );

  const boss = result.jobs.find((job) => job.title === "网络工程师");
  assert.equal(boss.platform, "boss");
  assert.equal(boss.experience, "5-10年", "**5-10年** 的粗体标记必须剥离");
  assert.equal(boss.education, "", "「—」要归成空串而不是保留破折号");
  assert.equal(boss.salaryMonths, 13);
  assert.equal(boss.decision, "pending");

  const liepin = result.jobs.find((job) => job.title === "桌面运维");
  assert.equal(liepin.platform, "liepin");
  assert.equal(liepin.city, "北京");
  assert.equal(liepin.district, "");
  assert.equal(liepin.salaryRaw, "面议");
  assert.equal(liepin.salaryMin, null);
  assert.equal(liepin.salaryMax, null);

  const daily = result.jobs.find((job) => job.title === "日薪岗");
  assert.equal(daily.salaryIsDaily, true);
  assert.equal(daily.salaryMin, 180);

  // 平台无法归一的第 4 行必须进 warnings，不能静默丢弃
  const platformWarning = result.warnings.find((warning) => warning.message.includes("前程无忧"));
  assert.ok(platformWarning, "平台无法归一的明细行必须有 warning");
  assert.equal(platformWarning.level, "warn");
  assert.equal(typeof platformWarning.line, "number");

  // 明细表行数核对：5 行数据、解析出 4 条 → 必须 warn
  const countWarning = result.warnings.find((warning) => warning.message.includes("台账明细表行数核对"));
  assert.ok(countWarning);
  assert.equal(countWarning.level, "warn");
  assert.ok(countWarning.message.includes("实际数据行 5 行"));
  assert.ok(countWarning.message.includes("解析出岗位记录 4 条"));
});

test("台账已投递：轮次标签不编造日期、同名合并、回执保留", () => {
  const result = jobsFromLedger(LEDGER_FIXTURE, "fixture.md");
  const job = result.jobs.find((candidate) => candidate.id === "zhaopin:网络运维工程师:北京京必达科技有限公司");
  assert.ok(job, "A1/A2 同名同公司必须合并成一条");
  assert.equal(job.decision, "applied");
  assert.equal(job.appliedAt, "2026-10-12T09:00:00", "已投时间取最早的非空真实值");
  assert.equal(job.receipt, "已向对方发送简历和打招呼语；已投递");
  assert.equal(result.jobs.filter((candidate) => candidate.id === job.id).length, 1);

  const labelWarning = result.warnings.find((warning) => warning.message.includes("A1") && warning.message.includes("轮次标签"));
  assert.ok(labelWarning, "轮次标签必须逐行 warn");
  assert.equal(labelWarning.level, "warn");
});

test("误投记录：misapplied/receipt 落地、公司括注拆地点", () => {
  const result = jobsFromLedger(LEDGER_FIXTURE, "fixture.md");
  const job = result.jobs.find((candidate) => candidate.title === "售前销售经理");
  assert.equal(job.company, "山西琦兰科技有限公司");
  assert.equal(job.city, "太原");
  assert.equal(job.district, "万柏林");
  assert.equal(job.locationRaw, "太原·万柏林");
  assert.equal(job.decision, "applied");
  assert.equal(job.misapplied, "投错了岗位");
  assert.equal(job.receipt, "已投递，需撤回");
  assert.equal(job.appliedAt, null);
});

test("核验表：生成 verified 事件并补充 JobRecord", () => {
  const result = jobsFromLedger(LEDGER_FIXTURE, "fixture.md");
  const event = result.applied.find((candidate) => candidate.title === "云运维工程师");
  assert.equal(event.platform, "zhaopin");
  assert.equal(event.kind, "applied");
  assert.equal(event.at, "2026-10-09T11:14:00");
  assert.equal(event.verified, true);
  assert.equal(event.salaryMin, 12000);
  assert.equal(event.salaryMax, 14000);
  assert.equal(event.keyword, "");
  const job = result.jobs.find((candidate) => candidate.id === "zhaopin:云运维工程师:中电金信");
  assert.equal(job.decision, "applied");
  assert.equal(job.appliedAt, "2026-10-09T11:14:00");
});

test("台账：跳过非投递形状的表格也要有 warning（不静默丢弃）", () => {
  const text = [
    "# 台账",
    "",
    "## 消息处理记录",
    "",
    "| # | 对方 | 岗位 | 类型 | 处理 | 结果 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| M1 | 张先生·某公司 | 网络安全工程师 1.2-1.8万 | 是否同意发简历 | 已发 | 已同意 |",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    "| 插件目录 | `D:\\dsh\\dsh-plugin-cdp` |",
    "",
    "| 半张表 |",
    "| 没表头 |",
    "| 也没分隔行 |",
  ].join("\n");
  const result = jobsFromLedger(text, "fixture.md");
  assert.equal(result.jobs.length, 0);
  assert.ok(
    result.warnings.some((warning) => warning.message.includes("未纳入 jobs") && warning.message.includes("消息处理记录")),
    "有岗位列但不属投递形状的表必须逐表说明",
  );
  assert.ok(
    result.warnings.some((warning) => warning.message.includes("无表头") || warning.message.includes("无表头的表格片段")),
    "无表头片段要单独说明",
  );
  const skipped = result.warnings.find((warning) => warning.message.includes("跳过"));
  assert.ok(skipped, "其它无关表格要有汇总说明");
  for (const warning of result.warnings) assertWarningShape(warning);
});

/* ------------------------------------------------------------------ *
 * 4. 合并规则
 * ------------------------------------------------------------------ */

function fakeJob(init) {
  const salaryRaw = init.salaryRaw || "";
  const salary = parseSalary(salaryRaw);
  return {
    id: "",
    platform: "zhaopin",
    title: "运维工程师",
    company: "某公司",
    city: "",
    district: "",
    locationRaw: "",
    salaryRaw,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    salaryMonths: salary.salaryMonths,
    salaryIsDaily: salary.salaryIsDaily,
    experience: "",
    education: "",
    decision: "unknown",
    basis: "",
    appliedAt: null,
    receipt: "",
    misapplied: "",
    keywords: [],
    source: "",
    ...init,
  };
}

test("合并：applied > pending > skipped，最早真实时刻优先，keywords 取并集", () => {
  const merged = mergeJobRecords([
    fakeJob({ decision: "skipped", basis: "先出现的依据", source: "台账明细", appliedAt: "2026-10-13T00:00:00" }),
    fakeJob({ decision: "pending", source: "台账正文", salaryRaw: "1-1.5万" }),
    fakeJob({
      decision: "applied",
      source: "运行日志 run-zp-B.log",
      appliedAt: "2026-10-13T10:29:24",
      keywords: ["网络工程师"],
      receipt: "已投递",
    }),
    fakeJob({ decision: "applied", source: "运行日志 run-zp-C.log", appliedAt: "2026-10-13T11:00:00", keywords: ["网络工程师", "桌面运维"] }),
  ]);
  assert.equal(merged.jobs.length, 1);
  const job = merged.jobs[0];
  assert.equal(job.id, "zhaopin:运维工程师:某公司");
  assert.equal(job.decision, "applied");
  assert.equal(job.appliedAt, "2026-10-13T10:29:24", "只有日期的 00:00:00 占位不能盖过真实时刻");
  assert.deepEqual(job.keywords, ["网络工程师", "桌面运维"]);
  assert.equal(job.salaryMin, 10000);
  assert.equal(job.salaryMax, 15000);
  assert.equal(job.basis, "先出现的依据");
  assert.ok(job.source.includes("运行日志 run-zp-B.log"));
  assert.equal(merged.merged.length, 1);
  assert.equal(merged.merged[0].count, 4);
  assert.equal(jobIdOf(job), job.id);
});

test("合并：决策优先级 pending > skipped > unknown", () => {
  const merged = mergeJobRecords([
    fakeJob({ decision: "unknown", title: "A" }),
    fakeJob({ decision: "skipped", title: "B" }),
    fakeJob({ decision: "pending", title: "C" }),
  ]);
  const byTitle = new Map(merged.jobs.map((job) => [job.title, job.decision]));
  assert.equal(byTitle.get("A"), "unknown");
  assert.equal(byTitle.get("B"), "skipped");
  assert.equal(byTitle.get("C"), "pending");
});

/* ------------------------------------------------------------------ *
 * 5. 日志解析
 * ------------------------------------------------------------------ */

const LOG_FIXTURE = [
  "[10:22:37] === 调度器 v2 启动；窗口至 11:30；猎聘待投 9 条；超时 nav=40s eval=90s ===",
  "[10:22:37] ########## 第 1 轮 ##########",
  "[10:22:37] [智联] kw=运维",
  "[10:27:43] === 智联[B] 启动 tab=ACA18BCDA4E6A5243AD9A09F33AE574B 至 11:30 ===",
  "[10:27:43] [1] 网络工程师",
  "[10:28:23]   导航超时",
  "[10:29:24]   OK 解决方案工程师 8000-15000元（ok=1）",
  "[10:29:25] [2] 桌面运维",
  "[10:39:33]   miss 列表内已无\\(miss=1)",
  "[10:40:00] [3] 系统运维",
  "[10:41:00]   miss 无明确薪资 steps=[",
  '    "未找到聊一聊/继续聊",',
  '    "未找到发简历"',
  "  ]",
  "[10:42:00] === 智联[B] 收工 ok=1 miss=2 navFail=1 ===",
].join("\n");

test("日志：kind / keyword 传播 / 失败事件 title=null / 多行 steps", () => {
  // 这一份 fixture 含全局调度器的行，对应真实文件 run-all.log（文件名推不出平台）
  const { events, warnings } = parseLogText(LOG_FIXTURE, { name: "run-all.log" });
  const kinds = events.map((event) => event.kind);
  assert.deepEqual(kinds, ["start", "cycle", "cycle", "start", "cycle", "nav_timeout", "applied", "cycle", "miss", "cycle", "miss", "summary"]);

  for (const event of events) {
    assert.ok(LOG_EVENT_KINDS.includes(event.kind), `非法 kind: ${event.kind}`);
    assert.ok(AT_RE.test(event.at), `非法时间：${event.at}`);
  }
  // 全局调度行 / 轮次行没有平台，必须 warn，且不能瞎认领平台
  assert.equal(events[0].platform, "");
  assert.equal(events[1].platform, "");
  assert.ok(warnings.some((warning) => warning.line === 1 && warning.message.includes("不属于任何单一平台")));
  assert.ok(warnings.some((warning) => warning.line === 2 && warning.message.includes("未标明平台")));
  // [智联] 标签之后全部归到 zhaopin
  assert.ok(events.slice(2).every((event) => event.platform === "zhaopin"));

  const applied = events.find((event) => event.kind === "applied");
  assert.equal(applied.title, "解决方案工程师");
  assert.equal(applied.salaryRaw, "8000-15000元");
  assert.equal(applied.salaryMin, 8000);
  assert.equal(applied.salaryMax, 15000);
  assert.equal(applied.keyword, "网络工程师");
  assert.equal(applied.at, "2026-10-13T10:29:24");
  assert.equal(applied.verified, false);
  assert.deepEqual(applied.counts, { ok: 1 });

  const nav = events.find((event) => event.kind === "nav_timeout");
  assert.equal(nav.title, null, "失败事件没有岗位名，必须是 null 而不是空串");
  assert.equal(nav.salaryRaw, "");
  assert.equal(nav.salaryMin, null);
  assert.equal(nav.keyword, "网络工程师");

  const missList = events.filter((event) => event.kind === "miss");
  assert.equal(missList[0].reason, "列表内已无\\");
  assert.deepEqual(missList[0].counts, { miss: 1 });
  assert.equal(missList[1].reason, "无明确薪资");
  assert.deepEqual(missList[1].steps, ["未找到聊一聊/继续聊", "未找到发简历"]);
  assert.equal(missList[1].keyword, "系统运维", "keyword 要从最近的 [n] 关键词行传播下来");

  const summary = events.find((event) => event.kind === "summary");
  assert.deepEqual(summary.counts, { ok: 1, miss: 2, navFail: 1 });
});

test("日志：文件名无日期时按台账窗口补日期并产出推断告警", () => {
  const { events, warnings } = parseLogText(LOG_FIXTURE, { name: "run-zp-B.log" });
  assert.ok(events.every((event) => event.date === "2026-10-13"));
  const inferred = warnings.find((warning) => warning.message.includes("文件名不含日期"));
  assert.ok(inferred, "日期推断必须留 warning");
  assert.equal(inferred.source, "run-zp-B.log");
  assert.equal(inferred.level, "info");

  // 显式给出日期时不应再产生推断告警
  const explicit = parseLogText(LOG_FIXTURE, { name: "run-zp-2026-10-09.log" });
  assert.ok(!explicit.warnings.some((warning) => warning.message.includes("文件名不含日期")));
  assert.ok(explicit.events.every((event) => event.date === "2026-10-09"));
});

test("日志：无法识别的行必须进 warnings，不静默丢弃", () => {
  const text = [
    "[10:00:00] [1] 运维",
    "[10:00:01]   这是谁也没见过的一行",
    "这一行连时间戳都没有",
    "[10:00:02]   OK 有薪资 9000-10000元（ok=1）",
  ].join("\n");
  const { events, warnings } = parseLogText(text, { name: "run-x.log" });
  const unknown = warnings.filter((warning) => warning.message.includes("无法识别"));
  assert.equal(unknown.length, 2);
  assert.equal(unknown[0].line, 2);
  assert.equal(unknown[1].line, 3);
  for (const warning of warnings) assertWarningShape(warning);
  assert.equal(events.filter((event) => event.kind === "applied").length, 1);
});

test("日志：猎聘队列 id 不是搜索关键词（keyword 记空串，id 留在 queueId）", () => {
  const text = [
    "[10:23:18] === liepin 调度器启动 tab=EC96B8FF 窗口至 11:30 ===",
    "[10:23:18] 队列剩余 9",
    "[10:23:18] [1985241231]",
    "[10:23:58]   导航超时",
  ].join("\n");
  const { events } = parseLogText(text, { name: "run-liepin.log" });
  const cycle = events.find((event) => event.kind === "cycle" && event.queueId);
  assert.equal(cycle.queueId, "1985241231");
  assert.equal(cycle.keyword, "");
  const nav = events.find((event) => event.kind === "nav_timeout");
  assert.equal(nav.platform, "liepin");
  assert.equal(nav.keyword, "");
  const queue = events.find((event) => event.kind === "summary");
  assert.deepEqual(queue.counts, { queue: 9 });
});

test("eventsFromLogs：支持 {name,text} 与文件路径两种入参", () => {
  const fromText = eventsFromLogs([{ name: "run-zp-B.log", text: LOG_FIXTURE }]);
  assert.equal(fromText.events.length, 12);
  const fromPath = eventsFromLogs([join(JW_DIR, "run-zp-B.log")]);
  assert.ok(fromPath.events.length > 50);
  assert.ok(fromPath.events.every((event) => event.platform === "zhaopin"));
  const missing = eventsFromLogs([join(JW_DIR, "run-not-exist.log")]);
  assert.equal(missing.events.length, 0);
  assert.equal(missing.warnings[0].level, "error");
  assertWarningShape(missing.warnings[0]);
});

test("真实日志 run-zp-B.log：applied 8 条、关键词配对、失败事件不计入投递", () => {
  const text = readFileSync(join(JW_DIR, "run-zp-B.log"), "utf8");
  const { events } = parseLogText(text, { name: "run-zp-B.log" });
  const applied = events.filter((event) => event.kind === "applied");
  assert.equal(applied.length, 8);
  assert.equal(events[0].kind, "start");
  assert.equal(events[0].platform, "zhaopin", "平台文件名可推断时，单平台日志的启动行用它");
  assert.ok(applied.every((event) => event.platform === "zhaopin"));
  assert.ok(applied.every((event) => event.verified === false));
  const first = applied[0];
  assert.equal(first.title, "解决方案工程师");
  assert.equal(first.keyword, "网络工程师");
  assert.equal(first.at, "2026-10-13T10:29:24");
  const navTimeouts = events.filter((event) => event.kind === "nav_timeout");
  assert.ok(navTimeouts.length >= 20, `run-zp-B.log 应有多条导航超时，实际 ${navTimeouts.length}`);
  assert.ok(navTimeouts.every((event) => event.title === null && event.salaryMin === null));
  const tofu = applied.find((event) => event.title === "网络运维技术员/五险一金/双休");
  assert.equal(tofu.salaryMin, 11000);
  assert.equal(tofu.salaryMax, 13000);
});

/* ------------------------------------------------------------------ *
 * 6. 真实数据集成（台账 + 全部 run-*.log）
 * ------------------------------------------------------------------ */

test("extract 真实数据：契约形状、规模下限与告警质量", async () => {
  const payload = await extract({ now: new Date("2026-10-13T12:00:00Z") });

  assert.equal(payload.schemaVersion, SCHEMA_VERSION);
  assert.equal(payload.generatedAt, "2026-10-13T12:00:00.000Z");

  // 验收下限
  assert.ok(payload.jobs.length >= 30, `jobs 应 ≥ 30，实际 ${payload.jobs.length}`);
  const appliedKind = payload.applied.filter((event) => event.kind === "applied");
  assert.ok(appliedKind.length >= 20, `kind=applied 事件应 ≥ 20，实际 ${appliedKind.length}`);
  assert.ok(payload.applied.length > appliedKind.length, "applied 数组还应包含 miss/导航超时等失败事件");
  assert.ok(payload.applied.filter((event) => event.kind === "nav_timeout").length > 50);

  // 契约形状
  for (const job of payload.jobs) {
    assert.deepEqual(keysOf(job), [...JOB_KEYS].sort(), `JobRecord 字段集合不符: ${job.title}`);
    assert.equal(job.id, jobIdOf(job));
    assert.ok(Object.prototype.hasOwnProperty.call(PLATFORMS, job.platform), `非法平台 ${job.platform}`);
    assert.ok(DECISIONS.includes(job.decision), `非法 decision ${job.decision}`);
    assert.ok(Array.isArray(job.keywords));
    assert.ok(job.appliedAt === null || AT_RE.test(job.appliedAt));
    assert.ok(job.salaryMin === null || typeof job.salaryMin === "number");
    assert.ok(job.salaryMax === null || typeof job.salaryMax === "number");
    assert.ok(Number.isInteger(job.salaryMonths) && job.salaryMonths >= 12);
    assert.equal(typeof job.salaryIsDaily, "boolean");
  }
  const ids = payload.jobs.map((job) => job.id);
  assert.equal(new Set(ids).size, ids.length, "jobs 不允许有重复 id");

  for (const event of payload.applied) {
    assert.deepEqual(keysOf(event), [...EVENT_KEYS].sort(), `AppliedEvent 字段集合不符: ${event.kind}`);
    assert.ok(LOG_EVENT_KINDS.includes(event.kind), `非法 kind ${event.kind}`);
    assert.ok(AT_RE.test(event.at), `非法时间 ${event.at}`);
    assert.equal(typeof event.verified, "boolean");
    assert.equal(typeof event.keyword, "string");
    if (event.kind === "applied") {
      assert.equal(typeof event.title, "string");
      assert.ok(event.title.length > 0);
      assert.equal(typeof event.salaryRaw, "string");
    } else {
      assert.equal(event.title, null, "失败事件 title 必须是 null");
      assert.equal(event.salaryRaw, "");
    }
  }
  assert.ok(
    payload.applied.every((event, index) => index === 0 || payload.applied[index - 1].at <= event.at),
    "applied 必须按 at 升序",
  );
  assert.ok(appliedKind.some((event) => event.verified), "应有台账核验来源的事件");
  assert.ok(appliedKind.some((event) => !event.verified), "应有运行日志来源的事件");

  // warnings：每条都要有 source + message；三种 level 合法
  assert.ok(payload.warnings.length > 0);
  for (const warning of payload.warnings) assertWarningShape(warning);
  assert.ok(payload.warnings.some((warning) => warning.level === "warn"), "轮次标签等真问题必须是 warn");
  assert.ok(
    payload.warnings.some((warning) => warning.message.includes("成功弹窗") && warning.message.includes("未入账")),
    "A5/A7 的「成功弹窗 ≠ 入账」必须留痕",
  );

  // keywords（契约新增字段）确实落地：日志 OK 行 → 岗位
  assert.ok(payload.jobs.some((job) => job.keywords.length > 0), "至少要有岗位带上搜索关键词");
  const solution = payload.jobs.find((job) => job.title === "解决方案工程师");
  assert.deepEqual(solution.keywords, ["网络工程师"]);
  assert.equal(solution.decision, "applied");
  assert.equal(solution.appliedAt, "2026-10-13T10:29:24");

  // A7 与 X1 两个关键案例
  const a7 = payload.jobs.find((job) => job.title.includes("J12132"));
  assert.equal(a7.decision, "applied");
  assert.equal(a7.appliedAt, null, "轮次标签无法归一 → appliedAt 必须是 null");
  assert.ok(a7.receipt.includes("已向对方发送简历和打招呼语"));
  const misapplied = payload.jobs.filter((job) => job.misapplied.length > 0);
  assert.ok(misapplied.length >= 1, "误投记录必须落到 misapplied");
  assert.equal(misapplied[0].decision, "applied");
  assert.equal(misapplied[0].appliedAt, "2026-10-09T11:37:18", "误投记录与 10-09 核对表应合并出真实时刻");

  // sources 是数组（契约明确写了数组，非 map）
  assert.ok(Array.isArray(payload.sources));
  assert.equal(payload.sources.length, 1 + 15, "1 个台账 + 15 个 run-*.log");
  for (const source of payload.sources) {
    assert.deepEqual(keysOf(source), ["bytes", "mtime", "path"]);
    assert.ok(source.bytes > 0);
    assert.ok(!Number.isNaN(Date.parse(source.mtime)));
  }
  assert.ok(payload.sources.some((source) => source.path === LEDGER_PATH));
});

test("extract 确定性：同样的输入与 now 产出完全一致的 payload", async () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const first = await extract({ now });
  const second = await extract({ now });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("extract 容错：台账缺失/日志目录缺失都只告警不抛异常", async () => {
  const payload = await extract({
    ledgerPath: join(JW_DIR, "不存在的台账.md"),
    logDir: join(JW_DIR, "不存在的目录"),
    now: new Date("2026-10-13T12:00:00Z"),
  });
  assert.equal(payload.jobs.length, 0);
  assert.equal(payload.applied.length, 0);
  assert.equal(payload.sources.length, 0);
  const levels = payload.warnings.map((warning) => warning.level);
  // 3 条 error = 台账读取失败 + 运行日志目录读取失败 + 结构化投递记录(applied.ndjson)读取失败。
  // 第 3 条是新增 applied.ndjson 摄入后加入的：目录不存在时两个读取块各自报错，
  // 分别对应不同数据源，因此这里是 3 而不是 2。
  assert.equal(levels.filter((level) => level === "error").length, 3);
  for (const warning of payload.warnings) assertWarningShape(warning);

  const noLogs = await extract({ logDir: null, now: new Date("2026-10-13T12:00:00Z") });
  assert.ok(noLogs.jobs.length >= 30, "只解析台账也应产出岗位");
  assert.equal(noLogs.applied.filter((event) => !event.verified).length, 0, "没有日志就没有未核验事件");
});

/* ------------------------------------------------------------------ *
 * 结构化投递记录（applied.ndjson）摄入
 *
 * 这条路径存在的理由：运行日志的 `OK 岗位名（ok=N）` 行**没有地点**，
 * 导致运行日志来源的岗位在地点分布里全部落到「地点未明」（实测 33/81）。
 * 地点本来就在 zp-kw.js 的返回值里，属于抓到了却没落盘。运行脚本改为
 * 每投一条追加一行 JSON 后，由这里读回来。
 * ------------------------------------------------------------------ */

const ndjsonFile = (rows) => [{ name: "applied.ndjson", text: rows.map((r) => JSON.stringify(r)).join("\n") }];

test("applied.ndjson：地点的城市/区域拆分（这是补地点覆盖率的唯一来源）", () => {
  const { jobs, events } = jobsFromAppliedNdjson(
    ndjsonFile([
      {
        ts: "2026-10-13T10:28:29",
        platform: "zhaopin",
        title: "服务器运维工程师",
        company: "北京华创方舟科技有限公司",
        location: "北京·顺义",
        salary: "1-1.5万·13薪",
        keyword: "系统运维",
      },
    ]),
  );

  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.city, "北京");
  assert.equal(job.district, "顺义");
  assert.equal(job.locationRaw, "北京·顺义");
  assert.equal(job.company, "北京华创方舟科技有限公司");
  assert.equal(job.salaryMin, 10000);
  assert.equal(job.salaryMax, 15000);
  assert.equal(job.salaryMonths, 13);
  assert.equal(job.decision, "applied");
  assert.equal(job.appliedAt, "2026-10-13T10:28:29");
  assert.deepEqual(job.keywords, ["系统运维"]);
  assert.equal(job.id, "zhaopin:服务器运维工程师:北京华创方舟科技有限公司");

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "applied");
  assert.equal(events[0].platform, "zhaopin");
  assert.equal(events[0].keyword, "系统运维");
  assert.equal(events[0].at, "2026-10-13T10:28:29");
});

test("applied.ndjson：脚本自报的成功必须 verified=false（不得冒充已核验）", () => {
  const { events } = jobsFromAppliedNdjson(
    ndjsonFile([{ ts: "2026-10-13T10:00:00", platform: "zhaopin", title: "岗位X", location: "北京·海淀" }]),
  );
  assert.equal(events[0].verified, false, "NDJSON 是脚本自报，未经平台记录页核验，不能标 verified");
});

test("applied.ndjson：地点缺失时优雅降级，不编造也不报错", () => {
  const { jobs, events, warnings } = jobsFromAppliedNdjson(
    ndjsonFile([{ ts: "2026-10-13T10:00:00", platform: "zhaopin", title: "岗位Y", company: "某公司" }]),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].city, "");
  assert.equal(jobs[0].district, "");
  assert.equal(jobs[0].locationRaw, "");
  assert.equal(jobs[0].company, "某公司");
  assert.equal(events.length, 1);
  assert.equal(warnings.filter((w) => w.level === "warn").length, 0, "地点缺失是正常情况，不该报警");
});

test("applied.ndjson：坏行必须计数告警，且不能拖垮同文件的好行", () => {
  const text = [
    JSON.stringify({ ts: "2026-10-13T10:00:00", platform: "zhaopin", title: "好岗位1" }),
    "{ 这不是合法 JSON",
    JSON.stringify({ ts: "2026-10-13T10:01:00", platform: "zhaopin" }), // 缺 title
    "[1,2,3]", // 不是对象
    "",
    JSON.stringify({ ts: "2026-10-13T10:02:00", platform: "zhaopin", title: "好岗位2" }),
  ].join("\n");

  const { jobs, warnings } = jobsFromAppliedNdjson([{ name: "applied.ndjson", text }]);
  assert.equal(jobs.length, 2, "两条好行必须都保留");
  const bad = warnings.find((w) => /无法解析/.test(w.message));
  assert.ok(bad, "坏行必须有告警");
  assert.match(bad.message, /3 行/, "坏行数应为 3（非法 JSON + 缺 title + 非对象）");
});

test("applied.ndjson：非法时间戳要告警，且不得伪造时间", () => {
  const { events, warnings } = jobsFromAppliedNdjson(
    ndjsonFile([{ ts: "昨天下午", platform: "zhaopin", title: "岗位Z" }]),
  );
  assert.equal(events.length, 1);
  // 时间非法 → at 退化为窗口日占位，但必须留下告警说明，不能静默编造
  assert.equal(events[0].at, `${DEFAULT_WINDOW_DATE}T00:00:00`);
  assert.ok(
    warnings.some((w) => /不是 YYYY-MM-DDTHH:mm:ss/.test(w.message)),
    "非法时间必须有告警",
  );
});

test("applied.ndjson：平台缺失或未知时按 zhaopin 兜底（脚本只由智联运行器写这个文件）", () => {
  const { jobs } = jobsFromAppliedNdjson(ndjsonFile([{ title: "岗位W", location: "北京·朝阳" }]));
  assert.equal(jobs[0].platform, "zhaopin");
});
