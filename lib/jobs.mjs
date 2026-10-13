/**
 * dsh-plugin-cdp — 投递台账抽取（台账 + 运行日志 → DashboardPayload）
 *
 * 输入：`D:\dsh\jw\投递台账.md`（771 行，多张形状不同的 markdown 表格）
 *       `D:\dsh\jw\run-*.log`（智联 / Boss / 猎聘 运行日志）
 * 输出：符合 `lib/contract.mjs` 的 DashboardPayload（契约冻结，本文件不修改契约）。
 *
 * 覆盖的台账表格形状（按表头列名识别，不按行号硬编码）：
 *   1. 台账明细        | # | 平台 | 岗位 | 公司 | 城市·区域 | 薪资 | 经验 | 学历 | 判定 | 依据 |
 *   2. 已投递（A1–A7） | 同前，但第 9/10 列是 投递时间 / 回执
 *   3. 误投记录（X1）  | 编号 | 平台 | 岗位 | 公司 | 薪资 | 误投原因 | 状态
 *   4. 核验表          | 岗位 | 公司 | 薪资 | 状态 | 时间   /   岗位 | 公司 | 薪资 | 时间
 *   5. 核对表（/schedule）| 岗位 | 公司 | 薪资 | 投递时间 | 结论
 *   6. 台账正文岗位清单 | 平台 | 岗位 | 公司 | … | 薪资 | … | 备注（无判定列）
 *
 * 诚实性原则（对应契约第 2、3 条）：
 *   - 未知一律 null / ""，不用 0 或 "—" 冒充；
 *   - 「已投递」表的时间列是轮次标签（"本轮" / "第6轮 14:33"），**不编造日期**：
 *     这些记录 decision=applied 且计入 applied 岗位数，但 appliedAt=null、不生成事件，逐行 warn；
 *   - 任何解析不了的行 / 表 / 代码块都有 warning，禁止静默丢弃；
 *   - 台账明细表要做「实际行数 vs 解析记录数」核对，不一致必须 warn。
 *
 * 去重：id = `${platform}:${title}:${company}`；合并时 applied > pending > skipped > unknown，
 * appliedAt 取最早的非空**真实**时刻（只有日期的 00:00:00 占位不会盖掉真实时刻），
 * keywords 取并集，source/receipt 去重后用 " + " / "；" 连接。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DECISIONS, SCHEMA_VERSION, parseSalary } from "./contract.mjs";
import {
  WINDOW_DATE,
  blankOf,
  clip,
  dateFromText,
  eventsFromLogs,
  isDateOnlyPlaceholder,
  isoFromParts,
  normalizePlatform,
  plainText,
  timeFromText,
  toAppliedEvent,
  countByKind,
} from "./logs.mjs";

export { eventsFromLogs, toAppliedEvent };
export const DEFAULT_LEDGER_PATH = fileURLToPath(new URL("../../jw/投递台账.md", import.meta.url));

/**
 * 解析运行脚本用 NDJSON 落盘的**结构化投递记录**（`applied.ndjson`）。
 *
 * 为什么需要它：运行日志里那行 `OK 岗位名（ok=1）` 只有标题和薪资，**没有地点**，
 * 于是运行日志来源的岗位在地点分布里全部落到「地点未明」（实测 33/81）。
 * 而地点本来就在 `zp-kw.js` 的返回值里（`.job-card__location`）——属于「抓到了却没落盘」。
 * 修法是让运行脚本每投一条就追加一行 JSON，这里把它读回来。
 *
 * 与 `.log` 解析的分工：
 *   - `.log`  → 事件流水（含 miss / nav_timeout 等失败事件），标题+薪资为主
 *   - `.ndjson` → 每条成功投递的完整字段（标题/公司/地点/薪资/关键词），信息更全
 * 两者覆盖的时间段不同，所以是**取并集**，靠 mergeJobRecords 与事件去重收敛。
 *
 * 容错：逐行解析，坏行进 warnings，绝不因为一行坏数据丢掉整个文件。
 *
 * @param {Array<{name: string, text: string}>} files
 * @param {{windowDate?: string}} [options]
 * @returns {{jobs: object[], events: object[], warnings: object[]}}
 */
export function jobsFromAppliedNdjson(files, options = {}) {
  const windowDate = options.windowDate || DEFAULT_WINDOW_DATE;
  const jobs = [];
  const events = [];
  const warnings = [];

  for (const file of files || []) {
    const source = file && file.name ? file.name : "applied.ndjson";
    const lines = String((file && file.text) || "").split(/\r?\n/);
    let bad = 0;
    let parsed = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (!raw) continue;

      let row;
      try {
        row = JSON.parse(raw);
      } catch {
        bad += 1;
        continue;
      }
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        bad += 1;
        continue;
      }

      const title = clip(plainText(row.title));
      if (!title) {
        bad += 1;
        continue;
      }

      const platform = normalizePlatform(row.platform) || "zhaopin";
      const company = clip(plainText(row.company)) || "";
      const locationRaw = clip(plainText(row.location)) || "";
      const salaryRaw = clip(plainText(row.salary)) || "";
      const salary = parseSalary(salaryRaw);

      // 地点拆分：与台账「城市·区域」同口径（·、空格、斜杠都见过）
      let city = "";
      let district = "";
      if (locationRaw) {
        const parts = locationRaw.split(/[·・/\s]+/).filter(Boolean);
        city = parts[0] || "";
        district = parts.slice(1).join(" ").trim();
      }

      // 时间：NDJSON 里是 "YYYY-MM-DDTHH:mm:ss"，已是契约格式；异常则进 warnings
      let at = "";
      const ts = typeof row.ts === "string" ? row.ts.trim() : "";
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ts)) at = ts;
      else if (ts) {
        warnings.push({
          level: "warn",
          source,
          line: i + 1,
          message: `投递时间「${ts}」不是 YYYY-MM-DDTHH:mm:ss 格式，该条事件的 at 记空串`,
        });
      }

      const keyword = clip(plainText(row.keyword)) || "";
      const id = `${platform}:${title}:${company}`;

      jobs.push({
        id,
        platform,
        title,
        company,
        city,
        district,
        locationRaw,
        salaryRaw,
        salaryMin: salary.salaryMin,
        salaryMax: salary.salaryMax,
        salaryMonths: salary.salaryMonths,
        salaryIsDaily: salary.salaryIsDaily,
        experience: "",
        education: "",
        decision: "applied",
        basis: "",
        appliedAt: at || null,
        receipt: "",
        misapplied: "",
        keywords: keyword ? [keyword] : [],
        source: `NDJSON ${source}`,
      });

      events.push(
        toAppliedEvent({
          platform,
          kind: "applied",
          title,
          salaryRaw,
          salaryMin: salary.salaryMin,
          salaryMax: salary.salaryMax,
          at: at || `${windowDate}T00:00:00`,
          // 这是脚本自报的成功，**未经平台记录页核验**，因此 verified=false 如实标注。
          verified: false,
          keyword,
        }),
      );
      parsed += 1;
    }

    if (bad > 0) {
      warnings.push({
        level: "warn",
        source,
        line: "",
        message: `${source} 有 ${bad} 行无法解析为结构化投递记录（已跳过，未静默丢弃计数）`,
      });
    }
    if (parsed > 0) {
      warnings.push({
        level: "info",
        source,
        line: "",
        message: `${source} 解析出 ${parsed} 条结构化投递记录（含公司/地点/关键词，verified=false 表示未在平台记录页核验）`,
      });
    }
  }

  return { jobs, events, warnings };
}
export const DEFAULT_LOG_DIR = fileURLToPath(new URL("../../jw/", import.meta.url));
export const DEFAULT_WINDOW_DATE = WINDOW_DATE;

const DECISION_PRIORITY = { applied: 3, pending: 2, skipped: 1, unknown: 0 };
/** 判定为「核验类」表格的章节标题关键词。 */
const VERIFY_HEADING_RE = /核验|记录页|战果|求职进展|权威核对|schedule/i;
/** 章节标题里出现这些词 → 岗位清单的 decision 推断为 pending。 */
const PENDING_HEADING_RE = /pending|待下轮|待投|可投|符合规则/i;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function unique(values) {
  const out = [];
  for (const value of values || []) if (value && !out.includes(value)) out.push(value);
  return out;
}

function priorityOf(decision) {
  return Object.prototype.hasOwnProperty.call(DECISION_PRIORITY, decision)
    ? DECISION_PRIORITY[decision]
    : 0;
}

/** "北京·海淀" → { city, district, locationRaw }；"—"/"" → 三者皆 ""。 */
function splitLocation(raw) {
  const text = blankOf(raw);
  if (!text) return { city: "", district: "", locationRaw: "" };
  const at = text.indexOf("·");
  if (at < 0) return { city: text, district: "", locationRaw: text };
  return {
    city: text.slice(0, at).trim(),
    district: text.slice(at + 1).trim(),
    locationRaw: text,
  };
}

/** 构造契约形状的 JobRecord（字段顺序与 JSDoc 一致；keywords 一定是数组）。 */
function makeJob(init = {}) {
  const salaryRaw = init.salaryRaw || "";
  const salary = parseSalary(salaryRaw);
  return {
    id: "",
    platform: init.platform || "",
    title: init.title || "",
    company: init.company || "",
    city: init.city || "",
    district: init.district || "",
    locationRaw: init.locationRaw || "",
    salaryRaw,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    salaryMonths: salary.salaryMonths,
    salaryIsDaily: salary.salaryIsDaily,
    experience: init.experience || "",
    education: init.education || "",
    decision: DECISIONS.includes(init.decision) ? init.decision : "unknown",
    basis: init.basis || "",
    appliedAt: init.appliedAt || null,
    receipt: init.receipt || "",
    misapplied: init.misapplied || "",
    keywords: Array.isArray(init.keywords) ? unique(init.keywords) : [],
    source: init.source || "",
  };
}

/** 契约去重键。 */
export function jobIdOf(job) {
  return `${job.platform}:${job.title}:${job.company}`;
}

function makeLedgerEvent(fields) {
  return {
    platform: fields.platform,
    kind: "applied",
    keyword: "",
    title: fields.title,
    salaryRaw: fields.salaryRaw || "",
    salaryMin: fields.salaryMin,
    salaryMax: fields.salaryMax,
    at: fields.at,
    verified: true,
    reason: fields.reason || "",
    steps: null,
    counts: null,
    queueId: "",
    source: fields.source,
    line: fields.line,
    raw: fields.raw || "",
  };
}

/* ------------------------------------------------------------------ *
 * markdown 表格解析
 * ------------------------------------------------------------------ */

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const SEPARATOR_CELL_RE = /^:?-{2,}:?$/;

function isTableRow(line) {
  return TABLE_ROW_RE.test(line) && line.includes("|");
}

/** 按未转义的 `|` 切分；`慧策\|旺店通` 视为一个单元格。 */
function splitRow(line) {
  let text = String(line).trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL_RE.test(cell.replace(/\s+/g, "")));
}

/** 收集全部 markdown 表格（跳过 ``` 代码块内的内容）。 */
function parseMarkdownTables(lines) {
  const tables = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (inFence || !isTableRow(line)) {
      i += 1;
      continue;
    }
    const startIndex = i;
    const rows = [];
    while (i < lines.length && isTableRow(lines[i])) {
      rows.push({ line: i + 1, cells: splitRow(lines[i]) });
      i += 1;
    }
    const hasSeparator = rows.length >= 2 && isSeparatorRow(rows[1].cells);
    tables.push({
      startIndex,
      headerLine: rows[0].line,
      header: rows[0].cells,
      hasSeparator,
      dataRows: hasSeparator ? rows.slice(2) : [],
      rawRowCount: rows.length,
    });
  }
  return tables;
}

function headingBefore(lines, index) {
  for (let i = index; i >= 0; i -= 1) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m) return { line: i + 1, level: m[1].length, text: plainText(m[2]) };
  }
  return null;
}

/** 章节日期：先向上找带日期的标题，再退回到 40 行内最近的一处日期。 */
function sectionDate(lines, index) {
  for (let i = index; i >= 0; i -= 1) {
    const m = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    const date = dateFromText(m[1]);
    if (date) return { date, line: i + 1, heading: plainText(m[1]) };
  }
  for (let i = index; i >= 0 && i >= index - 40; i -= 1) {
    const date = dateFromText(lines[i]);
    if (date) return { date, line: i + 1, heading: "" };
  }
  return null;
}

/** 章节平台：标题优先，其次标题前后 12 行上下文。 */
function sectionPlatform(lines, heading, index) {
  if (heading) {
    const fromHeading = normalizePlatform(heading.text);
    if (fromHeading) return { platform: fromHeading, from: `章节标题「${clip(heading.text, 40)}」` };
  }
  const center = heading ? heading.line - 1 : index;
  const from = Math.max(0, center - 12);
  const to = Math.min(lines.length - 1, center + 12);
  const fromWindow = normalizePlatform(lines.slice(from, to + 1).join(" "));
  if (fromWindow) return { platform: fromWindow, from: `章节上下文（第 ${from + 1}-${to + 1} 行）` };
  return { platform: "", from: "" };
}

function columnIndex(header, ...keywords) {
  for (let i = 0; i < header.length; i += 1) {
    const cell = plainText(header[i]);
    if (keywords.some((keyword) => cell.includes(keyword))) return i;
  }
  return -1;
}

function cellAt(row, index) {
  return index >= 0 && index < row.cells.length ? row.cells[index] : "";
}

function headerHasJobColumn(header) {
  return header.some((cell) => plainText(cell).includes("岗位"));
}

function classifyTable(table, headingText) {
  const header = table.header.map(plainText);
  const has = (keyword) => header.some((cell) => cell.includes(keyword));
  if (has("误投原因")) return "misapplied";
  if (has("判定") && has("岗位") && has("薪资")) return "detail";
  if (has("回执") && has("岗位")) return "applied";
  if (has("投递时间") && has("岗位")) return "verify_schedule";
  if (has("状态") && has("时间") && has("岗位")) return "verify_status";
  if (has("时间") && has("岗位") && (has("薪资") || has("公司"))) return "verify_dated";
  if (has("岗位") && has("薪资") && has("公司") && VERIFY_HEADING_RE.test(headingText)) {
    return "verify_dated";
  }
  if (has("平台") && has("岗位") && has("公司") && has("薪资")) return "job_list";
  return "skip";
}

/* ------------------------------------------------------------------ *
 * 台账各形状的解析
 * ------------------------------------------------------------------ */

function handleDetail(ctx) {
  const { table, source, jobs, warnings, jobSource } = ctx;
  const header = table.header;
  const cols = {
    platform: columnIndex(header, "平台"),
    title: columnIndex(header, "岗位"),
    company: columnIndex(header, "公司"),
    loc: columnIndex(header, "城市", "区域"),
    salary: columnIndex(header, "薪资"),
    exp: columnIndex(header, "经验"),
    edu: columnIndex(header, "学历"),
    decision: columnIndex(header, "判定"),
    basis: columnIndex(header, "依据"),
    no: columnIndex(header, "#", "编号"),
  };
  let parsed = 0;
  let unknownDecision = 0;

  for (const row of table.dataRows) {
    if (row.cells.length !== header.length) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `列数不一致（表头 ${header.length} 列，本行 ${row.cells.length} 列），按列序尽力解析`,
      });
    }
    const platform = normalizePlatform(cellAt(row, cols.platform));
    const title = blankOf(cellAt(row, cols.title));
    if (!platform || !title) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message:
          `台账明细第 ${blankOf(cellAt(row, cols.no)) || "?"} 行无法解析：` +
          `平台「${plainText(cellAt(row, cols.platform))}」→ ${platform || "无法归一"}，岗位「${title}」，已跳过该行`,
      });
      continue;
    }
    const decisionRaw = blankOf(cellAt(row, cols.decision)).toLowerCase();
    const decision = DECISIONS.includes(decisionRaw) ? decisionRaw : "unknown";
    if (decisionRaw && decision === "unknown") {
      unknownDecision += 1;
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `判定列「${decisionRaw}」不在 DECISIONS 内，记为 unknown`,
      });
    }
    const loc = splitLocation(cellAt(row, cols.loc));
    jobs.push(
      makeJob({
        platform,
        title,
        company: blankOf(cellAt(row, cols.company)),
        city: loc.city,
        district: loc.district,
        locationRaw: loc.locationRaw,
        salaryRaw: blankOf(cellAt(row, cols.salary)),
        experience: blankOf(cellAt(row, cols.exp)),
        education: blankOf(cellAt(row, cols.edu)),
        decision,
        basis: blankOf(cellAt(row, cols.basis)),
        source: jobSource,
      }),
    );
    parsed += 1;
    if (decision === "applied") {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `台账明细第 ${blankOf(cellAt(row, cols.no)) || "?"} 行判定为 applied，但本表没有投递时间列：appliedAt=null`,
      });
    }
  }

  const matched = parsed === table.dataRows.length;
  warnings.push({
    level: matched ? "info" : "warn",
    source,
    line: table.headerLine,
    message:
      `台账明细表行数核对（第 ${table.headerLine} 行表头）：实际数据行 ${table.dataRows.length} 行，` +
      `解析出岗位记录 ${parsed} 条${matched ? "，一致" : "，不一致（见本表其它告警）"}`,
  });
  return { rows: table.dataRows.length, parsed, unknownDecision };
}

function handleAppliedTable(ctx) {
  const { table, source, jobs, warnings, jobSource } = ctx;
  const header = table.header;
  const cols = {
    platform: columnIndex(header, "平台"),
    title: columnIndex(header, "岗位"),
    company: columnIndex(header, "公司"),
    loc: columnIndex(header, "城市", "区域"),
    salary: columnIndex(header, "薪资"),
    exp: columnIndex(header, "经验"),
    edu: columnIndex(header, "学历"),
    time: columnIndex(header, "投递时间"),
    receipt: columnIndex(header, "回执"),
    no: columnIndex(header, "#", "编号"),
  };
  let parsed = 0;
  let withoutAt = 0;

  for (const row of table.dataRows) {
    if (row.cells.length !== header.length) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `列数不一致（表头 ${header.length} 列，本行 ${row.cells.length} 列），按列序尽力解析`,
      });
    }
    const platform = normalizePlatform(cellAt(row, cols.platform));
    const title = blankOf(cellAt(row, cols.title));
    const no = blankOf(cellAt(row, cols.no));
    if (!platform || !title) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `${no || "?"} 行无法解析（平台→${platform || "无法归一"}，岗位「${title}」），已跳过`,
      });
      continue;
    }
    const timeRaw = plainText(cellAt(row, cols.time));
    const date = dateFromText(timeRaw);
    const time = timeFromText(timeRaw);
    const at = date ? isoFromParts(date, time) : "";
    if (!at) {
      withoutAt += 1;
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message:
          `${no || "?"}「${title}」的投递时间「${timeRaw}」是轮次标签，无法归一为 YYYY-MM-DDTHH:mm:ss：` +
          `该岗位仍计入 decision=applied，但 appliedAt=null、不生成 AppliedEvent（不编造日期）`,
      });
    }
    const loc = splitLocation(cellAt(row, cols.loc));
    jobs.push(
      makeJob({
        platform,
        title,
        company: blankOf(cellAt(row, cols.company)),
        city: loc.city,
        district: loc.district,
        locationRaw: loc.locationRaw,
        salaryRaw: blankOf(cellAt(row, cols.salary)),
        experience: blankOf(cellAt(row, cols.exp)),
        education: blankOf(cellAt(row, cols.edu)),
        decision: "applied",
        appliedAt: at || null,
        receipt: blankOf(cellAt(row, cols.receipt)),
        source: jobSource,
      }),
    );
    parsed += 1;
  }

  warnings.push({
    level: parsed === table.dataRows.length ? "info" : "warn",
    source,
    line: table.headerLine,
    message:
      `台账已投递表：数据行 ${table.dataRows.length} 行，解析出记录 ${parsed} 条，全部计入 jobs 的 applied；` +
      `其中 ${withoutAt} 条因投递时间是轮次标签而无 appliedAt（见逐行告警）`,
  });
  return { rows: table.dataRows.length, parsed };
}

function handleMisapplied(ctx) {
  const { table, source, jobs, warnings, jobSource } = ctx;
  const header = table.header;
  const cols = {
    platform: columnIndex(header, "平台"),
    title: columnIndex(header, "岗位"),
    company: columnIndex(header, "公司"),
    salary: columnIndex(header, "薪资"),
    reason: columnIndex(header, "误投原因"),
    status: columnIndex(header, "状态"),
    no: columnIndex(header, "编号", "#"),
  };
  let parsed = 0;

  for (const row of table.dataRows) {
    const platform = normalizePlatform(cellAt(row, cols.platform));
    const title = blankOf(cellAt(row, cols.title));
    const no = blankOf(cellAt(row, cols.no));
    if (!platform || !title) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `${no || "?"} 误投行无法解析（平台→${platform || "无法归一"}，岗位「${title}」），已跳过`,
      });
      continue;
    }
    let company = blankOf(cellAt(row, cols.company));
    let loc = { city: "", district: "", locationRaw: "" };
    const paren = company.match(/^(.+?)\s*[（(]([^（）()]{1,24})[)）]$/);
    if (paren && paren[2].includes("·")) {
      company = paren[1].trim();
      loc = splitLocation(paren[2]);
      warnings.push({
        level: "info",
        source,
        line: row.line,
        message:
          `${no || "?"} 公司列含地点括注「${paren[2]}」，已拆到 locationRaw/city/district（company=${company}）——` +
          `本表没有地点列，这是台账自身写法，不是清洗`,
      });
    }
    jobs.push(
      makeJob({
        platform,
        title,
        company,
        city: loc.city,
        district: loc.district,
        locationRaw: loc.locationRaw,
        salaryRaw: blankOf(cellAt(row, cols.salary)),
        decision: "applied",
        misapplied: blankOf(cellAt(row, cols.reason)),
        receipt: blankOf(cellAt(row, cols.status)),
        source: jobSource,
      }),
    );
    parsed += 1;
  }

  if (parsed > 0) {
    warnings.push({
      level: "info",
      source,
      line: table.headerLine,
      message: `误投记录表：${parsed} 条，decision=applied（事实是投了）+ misapplied 记原因；本表没有时间列，appliedAt=null`,
    });
  }
  return { rows: table.dataRows.length, parsed };
}

/** 核验类表格的公共落库：JobRecord(applied) + AppliedEvent(verified=true)。 */
function addVerifiedApplication(ctx, spec) {
  const { jobs, applied, source, jobSource } = ctx;
  const salary = parseSalary(spec.salaryRaw || "");
  jobs.push(
    makeJob({
      platform: spec.platform,
      title: spec.title,
      company: spec.company,
      salaryRaw: spec.salaryRaw || "",
      decision: "applied",
      appliedAt: spec.at,
      receipt: spec.receipt || "",
      source: jobSource,
    }),
  );
  applied.push(
    makeLedgerEvent({
      platform: spec.platform,
      title: spec.title,
      salaryRaw: spec.salaryRaw || "",
      salaryMin: salary.salaryMin,
      salaryMax: salary.salaryMax,
      at: spec.at,
      reason: spec.receipt || "",
      source,
      line: spec.line,
      raw: spec.raw || "",
    }),
  );
}

function handleVerifySchedule(ctx) {
  const { table, source, warnings, lines } = ctx;
  const header = table.header;
  const cols = {
    platform: columnIndex(header, "平台"),
    title: columnIndex(header, "岗位"),
    company: columnIndex(header, "公司"),
    salary: columnIndex(header, "薪资"),
    time: columnIndex(header, "投递时间"),
    conclusion: columnIndex(header, "结论"),
  };
  const resolved = sectionPlatform(lines, ctx.heading, table.startIndex);
  const dated = sectionDate(lines, table.startIndex);
  let parsed = 0;

  for (const row of table.dataRows) {
    const title = blankOf(cellAt(row, cols.title));
    if (!title) {
      warnings.push({ level: "warn", source, line: row.line, message: "核对表行缺少岗位名，已跳过" });
      continue;
    }
    const timeRaw = plainText(cellAt(row, cols.time));
    const conclusion = blankOf(cellAt(row, cols.conclusion));
    if (/查无|无记录|未入账/.test(timeRaw) || /查无记录/.test(conclusion)) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message:
          `核对结论「${clip(conclusion, 80)}」且投递时间列为「${timeRaw}」：该投递**未入账**，` +
          `不生成 AppliedEvent（台账教训：成功弹窗 ≠ 投递成功，一律以平台记录页为准）`,
      });
      continue;
    }
    const platform = normalizePlatform(cellAt(row, cols.platform)) || resolved.platform;
    if (!platform) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `核对表「${title}」无法确定平台（表内无平台列，章节也没写），已跳过`,
      });
      continue;
    }
    let date = dateFromText(timeRaw);
    const time = timeFromText(timeRaw);
    if (!date && time) {
      date = dated ? dated.date : "";
      if (!date) {
        warnings.push({
          level: "warn",
          source,
          line: row.line,
          message: `核对表「${title}」时间「${timeRaw}」只有时刻且找不到章节日期，已跳过`,
        });
        continue;
      }
      warnings.push({
        level: "info",
        source,
        line: row.line,
        message: `核对表「${title}」时间「${timeRaw}」只有时刻，日期按章节推断为 ${date}`,
      });
    }
    if (!date) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `核对表「${title}」时间「${timeRaw}」无法解析出日期，已跳过`,
      });
      continue;
    }
    addVerifiedApplication(ctx, {
      platform,
      title,
      company: blankOf(cellAt(row, cols.company)),
      salaryRaw: blankOf(cellAt(row, cols.salary)),
      at: isoFromParts(date, time),
      receipt: conclusion,
      line: row.line,
      raw: row.cells.join(" | "),
    });
    parsed += 1;
  }

  if (parsed > 0 && resolved.from) {
    warnings.push({
      level: "info",
      source,
      line: table.headerLine,
      message: `核对表（第 ${table.headerLine} 行表头）无平台列，平台由${resolved.from}推断为 ${resolved.platform}`,
    });
  }
  return { rows: table.dataRows.length, parsed };
}

function handleVerifyStatus(ctx) {
  const { table, source, applied, warnings, lines } = ctx;
  const header = table.header;
  const cols = {
    platform: columnIndex(header, "平台"),
    title: columnIndex(header, "岗位"),
    company: columnIndex(header, "公司"),
    salary: columnIndex(header, "薪资"),
    status: columnIndex(header, "状态"),
    time: columnIndex(header, "时间"),
  };
  const resolved = sectionPlatform(lines, ctx.heading, table.startIndex);
  const dated = sectionDate(lines, table.startIndex);
  let parsed = 0;

  for (const row of table.dataRows) {
    const title = blankOf(cellAt(row, cols.title));
    if (!title) {
      warnings.push({ level: "warn", source, line: row.line, message: "核验表行缺少岗位名，已跳过" });
      continue;
    }
    const platform = normalizePlatform(cellAt(row, cols.platform)) || resolved.platform;
    if (!platform) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `核验表「${title}」无法确定平台，已跳过`,
      });
      continue;
    }
    const timeRaw = plainText(cellAt(row, cols.time));
    let date = dateFromText(timeRaw);
    const time = timeFromText(timeRaw);
    if (!date && time && dated) date = dated.date;
    if (!date) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `核验表「${title}」时间「${timeRaw}」无法解析出日期，已跳过`,
      });
      continue;
    }
    addVerifiedApplication(ctx, {
      platform,
      title,
      company: blankOf(cellAt(row, cols.company)),
      salaryRaw: blankOf(cellAt(row, cols.salary)),
      at: isoFromParts(date, time),
      receipt: blankOf(cellAt(row, cols.status)),
      line: row.line,
      raw: row.cells.join(" | "),
    });
    parsed += 1;
  }

  if (parsed > 0 && resolved.from) {
    warnings.push({
      level: "info",
      source,
      line: table.headerLine,
      message: `核验表（第 ${table.headerLine} 行表头）无平台列，平台由${resolved.from}推断为 ${resolved.platform}；applied 数组共新增 ${parsed} 条`,
    });
  }
  return { rows: table.dataRows.length, parsed };
}

function handleVerifyDated(ctx) {
  const { table, source, warnings, lines } = ctx;
  const header = table.header;
  const cols = {
    title: columnIndex(header, "岗位"),
    company: columnIndex(header, "公司"),
    salary: columnIndex(header, "薪资"),
    time: columnIndex(header, "时间"),
  };
  const resolved = sectionPlatform(lines, ctx.heading, table.startIndex);
  const dated = sectionDate(lines, table.startIndex);
  let parsed = 0;
  let placeholder = 0;
  let dateInferred = 0;
  let missingDate = 0;

  if (!resolved.platform) {
    warnings.push({
      level: "warn",
      source,
      line: table.headerLine,
      message: `核验表（第 ${table.headerLine} 行表头）没有平台列且章节未标平台，整表跳过（不猜平台）`,
    });
    return { rows: table.dataRows.length, parsed };
  }

  for (const row of table.dataRows) {
    const title = blankOf(cellAt(row, cols.title));
    if (!title) {
      warnings.push({ level: "warn", source, line: row.line, message: "核验表行缺少岗位名，已跳过" });
      continue;
    }
    const timeRaw = cols.time >= 0 ? plainText(cellAt(row, cols.time)) : "";
    let date = dateFromText(timeRaw);
    const time = timeFromText(timeRaw);
    let at = "";

    if (date) {
      at = isoFromParts(date, time);
      if (!time) placeholder += 1;
    } else if (time && dated) {
      date = dated.date;
      dateInferred += 1;
      at = isoFromParts(date, time);
    } else if (!timeRaw && dated) {
      date = dated.date;
      placeholder += 1;
      at = isoFromParts(date, "");
    } else if (dated) {
      date = dated.date;
      missingDate += 1;
      at = isoFromParts(date, "");
    }

    if (!at) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `核验表「${title}」时间「${timeRaw}」无法解析、且找不到章节日期，已跳过（不生成事件）`,
      });
      continue;
    }

    addVerifiedApplication(ctx, {
      platform: resolved.platform,
      title,
      company: blankOf(cellAt(row, cols.company)),
      salaryRaw: blankOf(cellAt(row, cols.salary)),
      at,
      receipt: "",
      line: row.line,
      raw: row.cells.join(" | "),
    });
    parsed += 1;
  }

  const notes = [];
  if (dateInferred) notes.push(`${dateInferred} 行只有时刻，日期按章节推断为 ${dated ? dated.date : "?"}`);
  if (placeholder) notes.push(`${placeholder} 行没有时刻，按契约记当日 00:00:00（JobRecord.appliedAt 同样是该占位值）`);
  if (missingDate) notes.push(`${missingDate} 行的时间无法解析，按章节日期 ${dated ? dated.date : "?"} 记 00:00:00`);
  if (notes.length) {
    warnings.push({
      level: "info",
      source,
      line: table.headerLine,
      message: `核验表（第 ${table.headerLine} 行表头，平台由${resolved.from || "章节"}推断为 ${resolved.platform}）：${notes.join("；")}`,
    });
  }
  return { rows: table.dataRows.length, parsed };
}

function handleJobList(ctx) {
  const { table, source, jobs, warnings } = ctx;
  const header = table.header;
  const headingText = ctx.heading ? ctx.heading.text : "";
  const decision = PENDING_HEADING_RE.test(headingText) ? "pending" : "unknown";
  const shortHeading = clip(headingText.split("（")[0].trim() || headingText, 24);
  const cols = {
    platform: columnIndex(header, "平台"),
    title: columnIndex(header, "岗位"),
    company: columnIndex(header, "公司"),
    loc: columnIndex(header, "城市", "区域"),
    salary: columnIndex(header, "薪资"),
    exp: columnIndex(header, "经验"),
    edu: columnIndex(header, "学历"),
    note: columnIndex(header, "备注", "活跃度"),
  };
  let parsed = 0;

  for (const row of table.dataRows) {
    const platform = normalizePlatform(cellAt(row, cols.platform));
    const title = blankOf(cellAt(row, cols.title));
    if (!platform || !title) {
      warnings.push({
        level: "warn",
        source,
        line: row.line,
        message: `台账正文岗位清单行无法解析（平台→${platform || "无法归一"}，岗位「${title}」），已跳过`,
      });
      continue;
    }
    const loc = splitLocation(cellAt(row, cols.loc));
    jobs.push(
      makeJob({
        platform,
        title,
        company: blankOf(cellAt(row, cols.company)),
        city: loc.city,
        district: loc.district,
        locationRaw: loc.locationRaw,
        salaryRaw: blankOf(cellAt(row, cols.salary)),
        experience: blankOf(cellAt(row, cols.exp)),
        education: blankOf(cellAt(row, cols.edu)),
        decision,
        basis: blankOf(cellAt(row, cols.note)),
        source: `台账正文 ${shortHeading}`,
      }),
    );
    parsed += 1;
  }

  if (parsed > 0) {
    warnings.push({
      level: "info",
      source,
      line: table.headerLine,
      message:
        `台账正文岗位清单（第 ${table.headerLine} 行表头，无判定列）：${parsed} 行按章节「${shortHeading}」` +
        `推断 decision=${decision}，备注列进 basis`,
    });
  }
  return { rows: table.dataRows.length, parsed };
}

const ROLE_HANDLERS = {
  detail: handleDetail,
  applied: handleAppliedTable,
  misapplied: handleMisapplied,
  verify_schedule: handleVerifySchedule,
  verify_status: handleVerifyStatus,
  verify_dated: handleVerifyDated,
  job_list: handleJobList,
};

/* ------------------------------------------------------------------ *
 * 台账事件去重 + 代码块时间戳提示
 * ------------------------------------------------------------------ */

function dedupeLedgerEvents(events, source, warnings) {
  const out = [];
  const index = new Map();
  let merged = 0;
  for (const event of events) {
    const key = `${event.platform}|${event.title}|${event.salaryRaw}`;
    const prev = index.get(key);
    if (prev && (prev.at === event.at || isDateOnlyPlaceholder(prev.at) || isDateOnlyPlaceholder(event.at))) {
      const keepNew = isDateOnlyPlaceholder(prev.at) && !isDateOnlyPlaceholder(event.at);
      if (keepNew) {
        out[out.indexOf(prev)] = event;
        index.set(key, event);
      }
      merged += 1;
      warnings.push({
        level: "info",
        source,
        line: event.line,
        message:
          `与台账 @L${prev.line} 是同一投递的重复登记（${event.platform} ${event.title} ${event.salaryRaw}）：` +
          `已合并为 1 条，保留 ${keepNew ? `${event.at}（本行更精确）` : `${prev.at}（@L${prev.line} 更精确）`}`,
      });
      continue;
    }
    index.set(key, event);
    out.push(event);
  }
  return { events: out, merged };
}

function warnTimestampBlocks(lines, source, warnings) {
  let inFence = false;
  let fenceStart = 0;
  let buffer = [];
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      if (!inFence) {
        inFence = true;
        fenceStart = i;
        buffer = [];
      } else {
        inFence = false;
        blocks.push({ fenceStart, firstLine: fenceStart + 2, text: buffer.join(" ") });
      }
      continue;
    }
    if (inFence) buffer.push(lines[i]);
  }
  for (const block of blocks) {
    const times = block.text.match(/\d{1,2}:\d{2}:\d{2}/g) || [];
    if (times.length < 5) continue;
    const context = lines.slice(Math.max(0, block.fenceStart - 20), block.fenceStart).join(" ");
    if (!/核验|成功投递|记录页|schedule/.test(context)) continue;
    warnings.push({
      level: "info",
      source,
      line: block.firstLine,
      message:
        `代码块 @L${block.firstLine} 列出 ${times.length} 个已核验投递时间戳（${times[0]} … ${times[times.length - 1]}），` +
        `但台账没有给出「时间 ↔ 岗位名」的对应关系，未生成 AppliedEvent（不把时间随机配到岗位上）`,
    });
  }
}

/* ------------------------------------------------------------------ *
 * 合并 / 冲突提示
 * ------------------------------------------------------------------ */

/** 按契约去重键合并，返回 { jobs, merged }。 */
export function mergeJobRecords(records) {
  const groups = new Map();
  for (const record of records || []) {
    const job = record;
    job.keywords = Array.isArray(job.keywords) ? unique(job.keywords) : [];
    job.id = jobIdOf(job);
    const group = groups.get(job.id);
    if (group) group.push(job);
    else groups.set(job.id, [job]);
  }

  const jobs = [];
  const merged = [];
  for (const [id, parts] of groups) {
    if (parts.length === 1) {
      jobs.push(parts[0]);
      continue;
    }
    const sorted = parts.slice().sort((a, b) => priorityOf(b.decision) - priorityOf(a.decision));
    const first = (pick) => {
      for (const part of sorted) {
        const value = pick(part);
        if (value !== null && value !== undefined && value !== "") return value;
      }
      return "";
    };
    const salaryMinPart = sorted.find((part) => part.salaryMin !== null);
    const salaryMaxPart = sorted.find((part) => part.salaryMax !== null);
    const monthsPart = sorted.find((part) => part.salaryMonths !== 12);
    const realTimes = parts
      .map((part) => part.appliedAt)
      .filter((at) => at && !isDateOnlyPlaceholder(at))
      .sort();
    const placeholderTimes = parts
      .map((part) => part.appliedAt)
      .filter((at) => at && isDateOnlyPlaceholder(at))
      .sort();
    const job = makeJob({
      platform: first((part) => part.platform),
      title: first((part) => part.title),
      company: first((part) => part.company),
      city: first((part) => part.city),
      district: first((part) => part.district),
      locationRaw: first((part) => part.locationRaw),
      salaryRaw: first((part) => part.salaryRaw),
      experience: first((part) => part.experience),
      education: first((part) => part.education),
      decision: sorted[0].decision,
      basis: first((part) => part.basis),
      appliedAt: realTimes[0] || placeholderTimes[0] || null,
      receipt: unique(parts.map((part) => part.receipt)).join("；"),
      misapplied: first((part) => part.misapplied),
      keywords: unique(sorted.flatMap((part) => part.keywords || [])),
      source: unique(sorted.map((part) => part.source)).join(" + "),
    });
    job.id = id;
    job.salaryMin = salaryMinPart ? salaryMinPart.salaryMin : null;
    job.salaryMax = salaryMaxPart ? salaryMaxPart.salaryMax : null;
    job.salaryMonths = monthsPart ? monthsPart.salaryMonths : 12;
    job.salaryIsDaily = sorted.some((part) => part.salaryIsDaily);
    jobs.push(job);
    merged.push({ id, count: parts.length, decisions: unique(parts.map((part) => part.decision)) });
  }
  return { jobs, merged };
}

function warnMerges(merged, source, warnings, note) {
  if (!merged.length) return;
  const listed = merged
    .slice(0, 12)
    .map((item) => `${item.id}（${item.count} 条：${item.decisions.join("/")}）`);
  warnings.push({
    level: "info",
    source,
    line: "",
    message:
      `${note}按 id=platform:title:company 合并 ${merged.length} 组重复岗位：${listed.join("、")}` +
      (merged.length > listed.length ? ` …等 ${merged.length} 组` : ""),
  });
}

/** 同名但公司串不同 → 契约去重键不同，不合并，但要说清楚。 */
function warnCompanyCollisions(jobs, source, warnings) {
  const byTitle = new Map();
  for (const job of jobs) {
    const key = `${job.platform}|${job.title}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(job);
  }
  const groups = [];
  for (const [key, list] of byTitle) {
    const companies = unique(list.map((job) => job.company));
    if (companies.length > 1) groups.push({ key, companies });
  }
  if (!groups.length) return 0;
  const listed = groups
    .slice(0, 10)
    .map((group) => `${group.key}（公司：${group.companies.map((c) => c || "未知").join(" / ")}）`);
  warnings.push({
    level: "info",
    source,
    line: "",
    message:
      `同名岗位但公司串不同，按契约未合并 ${groups.length} 组（去重键含 company）：${listed.join("；")}` +
      (groups.length > 10 ? ` …等 ${groups.length} 组` : ""),
  });
  return groups.length;
}

/** 标题前缀包含且公司不同 → 疑似同一岗位的两种写法，只提示不合并。 */
function warnTitlePrefixCollisions(jobs, source, warnings) {
  const byPlatform = new Map();
  for (const job of jobs) {
    if (!byPlatform.has(job.platform)) byPlatform.set(job.platform, []);
    byPlatform.get(job.platform).push(job);
  }
  const pairs = [];
  for (const [platform, list] of byPlatform) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const left = list[a];
        const right = list[b];
        const short = left.title.length <= right.title.length ? left : right;
        const long = short === left ? right : left;
        const gap = long.title.length - short.title.length;
        if (gap > 0 && gap <= 8 && long.title.startsWith(short.title)) {
          pairs.push(`${platform}「${short.title}」vs「${long.title}」(${short.source} / ${long.source})`);
        }
      }
    }
  }
  if (!pairs.length) return 0;
  warnings.push({
    level: "info",
    source,
    line: "",
    message:
      `疑似同一岗位的两种标题写法 ${pairs.length} 组（标题前缀相同、公司串不同，未合并）：` +
      pairs.slice(0, 8).join("；") +
      (pairs.length > 8 ? ` …等 ${pairs.length} 组` : ""),
  });
  return pairs.length;
}

/* ------------------------------------------------------------------ *
 * 台账入口
 * ------------------------------------------------------------------ */

/**
 * 解析台账 markdown 全文。
 *
 * @param {string} text 台账原文
 * @param {string} [source] 告警里显示的来源名（默认 "投递台账.md"）
 * @returns {{ jobs: object[], applied: object[], warnings: object[] }}
 */
export function jobsFromLedger(text, source = "投递台账.md") {
  const warnings = [];
  const jobs = [];
  const applied = [];
  const lines = String(text ?? "").split(/\r?\n/);
  const tables = parseMarkdownTables(lines);

  const skippedJobTables = [];
  const skippedOtherTables = [];
  const malformed = [];
  const roles = {};
  let detailStat = null;

  for (const table of tables) {
    if (!table.hasSeparator) {
      malformed.push(table);
      continue;
    }
    const heading = headingBefore(lines, table.startIndex);
    const headingText = heading ? heading.text : "";
    const role = classifyTable(table, headingText);
    if (role === "skip") {
      if (headerHasJobColumn(table.header)) skippedJobTables.push({ table, headingText });
      else skippedOtherTables.push(table);
      continue;
    }
    roles[role] = (roles[role] || 0) + 1;
    const dated = sectionDate(lines, table.startIndex);
    const ctx = {
      table,
      heading,
      headingText,
      lines,
      source,
      jobs,
      applied,
      warnings,
      jobSource:
        role === "detail"
          ? "台账明细"
          : role === "applied"
            ? "台账已投递"
            : role === "misapplied"
              ? "台账误投记录"
              : role === "job_list"
                ? `台账正文 ${clip(headingText.split("（")[0].trim() || headingText, 24)}`
                : `台账核验表${dated ? ` ${dated.date}` : ""}`,
    };
    const stat = ROLE_HANDLERS[role](ctx);
    if (role === "detail") detailStat = stat;
  }

  warnTimestampBlocks(lines, source, warnings);

  const recognized = Object.entries(roles)
    .map(([role, count]) => `${role}×${count}`)
    .join("、");
  warnings.push({
    level: "info",
    source,
    line: "",
    message:
      `台账表格盘点：共 ${tables.length} 张 markdown 表格，纳入 ${Object.values(roles).reduce((a, b) => a + b, 0)} 张` +
      `（${recognized}），跳过 ${skippedJobTables.length + skippedOtherTables.length} 张，` +
      `无表头片段 ${malformed.length} 处`,
  });

  for (const item of skippedJobTables) {
    warnings.push({
      level: "info",
      source,
      line: item.table.headerLine,
      message:
        `未纳入 jobs：表头「${item.table.header.map(plainText).join(" | ")}」@L${item.table.headerLine}` +
        `（${item.table.dataRows.length} 行，章节「${clip(item.headingText, 30)}」）——` +
        `没有平台/判定/时间列，不属于 task-1 规定的台账形状（消息处理记录等）`,
    });
  }
  if (skippedOtherTables.length) {
    warnings.push({
      level: "info",
      source,
      line: "",
      message:
        `跳过 ${skippedOtherTables.length} 张与投递台账无关的表格（行号：` +
        `${skippedOtherTables.slice(0, 24).map((table) => `L${table.headerLine}`).join("、")}` +
        `${skippedOtherTables.length > 24 ? " …" : ""}）`,
    });
  }
  for (const table of malformed) {
    warnings.push({
      level: "info",
      source,
      line: table.headerLine,
      message: `疑似无表头的表格片段 @L${table.headerLine}（${table.rawRowCount} 行），未纳入（无法确定列义）`,
    });
  }

  const deduped = dedupeLedgerEvents(applied, source, warnings);
  const mergedResult = mergeJobRecords(jobs);
  warnMerges(mergedResult.merged, source, warnings, "台账内部：");
  warnCompanyCollisions(mergedResult.jobs, source, warnings);
  warnTitlePrefixCollisions(mergedResult.jobs, source, warnings);

  if (detailStat) {
    warnings.push({
      level: "info",
      source,
      line: "",
      message:
        `台账产出：岗位记录 ${mergedResult.jobs.length} 条（明细表 ${detailStat.parsed}/${detailStat.rows} 行）、` +
        `投递事件 ${deduped.events.length} 条（合并重复登记 ${deduped.merged} 条）`,
    });
  }

  return { jobs: mergedResult.jobs, applied: deduped.events, warnings };
}

/* ------------------------------------------------------------------ *
 * 运行日志 → 岗位记录
 * ------------------------------------------------------------------ */

function jobsFromLogEvents(events, warnings) {
  const jobs = [];
  const bySource = new Map();
  for (const event of events || []) {
    if (event.kind !== "applied") continue;
    if (!event.platform) continue; // parseLogText 已对无平台行告警
    if (!event.title) {
      warnings.push({
        level: "warn",
        source: event.source,
        line: event.line,
        message: `OK 行缺少岗位名，未生成 JobRecord：${clip(event.raw)}`,
      });
      continue;
    }
    if (!event.at) {
      warnings.push({
        level: "warn",
        source: event.source,
        line: event.line,
        message: `OK 行缺少时间戳，未生成 JobRecord：${clip(event.raw)}`,
      });
      continue;
    }
    jobs.push(
      makeJob({
        platform: event.platform,
        title: event.title,
        company: "",
        salaryRaw: event.salaryRaw,
        decision: "applied",
        appliedAt: event.at,
        keywords: event.keyword ? [event.keyword] : [],
        source: `运行日志 ${event.source}`,
      }),
    );
    bySource.set(event.source, (bySource.get(event.source) || 0) + 1);
  }
  return { jobs, bySource };
}

/* ------------------------------------------------------------------ *
 * extract
 * ------------------------------------------------------------------ */

function generatedAtFrom(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (typeof now === "number" || typeof now === "string") {
    const date = new Date(now);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function logSummaryWarning(name, events) {
  const counts = countByKind(events);
  const parts = Object.keys(counts)
    .sort()
    .map((kind) => `${kind} ${counts[kind]}`);
  const noTitle = events.filter(
    (event) => event.title === null && ["miss", "nav_timeout", "error"].includes(event.kind),
  ).length;
  const queueIds = unique(events.map((event) => event.queueId).filter(Boolean));
  const extra = [];
  if (noTitle) extra.push(`其中 ${noTitle} 条失败事件没有岗位名（日志未给标题），title 记 null`);
  if (queueIds.length) {
    extra.push(`队列 id ${queueIds.join("、")} 不是搜索关键词，keyword 记 ""（在 eventsFromLogs() 里可见）`);
  }
  return {
    level: "info",
    source: name,
    line: "",
    message:
      `日志事件 ${events.length} 条（${parts.join("、")}）：全部进入 payload.applied，` +
      `统计投递数时按 kind === "applied" 过滤` +
      (extra.length ? `；${extra.join("；")}` : ""),
  };
}

/**
 * 抽取全部数据 → DashboardPayload。
 *
 * @param {{ ledgerPath?: string|null, logDir?: string|null, now?: Date|number|string,
 *           windowDate?: string, logPattern?: RegExp }} [options]
 * @returns {Promise<object>} DashboardPayload
 */
export async function extract(options = {}) {
  const ledgerPath = options.ledgerPath === undefined ? DEFAULT_LEDGER_PATH : options.ledgerPath;
  const logDir = options.logDir === undefined ? DEFAULT_LOG_DIR : options.logDir;
  const windowDate = options.windowDate || DEFAULT_WINDOW_DATE;
  const logPattern = options.logPattern || /^run-.*\.log$/;
  const ndjsonPattern = options.ndjsonPattern || /\.ndjson$/;

  const warnings = [];
  const sources = [];

  let ledgerText = "";
  const ledgerSource = ledgerPath ? basename(ledgerPath) : "投递台账.md";
  if (ledgerPath) {
    try {
      const [text, info] = await Promise.all([readFile(ledgerPath, "utf8"), stat(ledgerPath)]);
      ledgerText = text;
      sources.push({ path: ledgerPath, bytes: info.size, mtime: info.mtime.toISOString() });
    } catch (error) {
      warnings.push({
        level: "error",
        source: ledgerSource,
        line: "",
        message: `台账读取失败：${error && error.code ? error.code : String(error)}（${ledgerPath}）`,
      });
    }
  } else {
    warnings.push({ level: "warn", source: ledgerSource, line: "", message: "未提供 ledgerPath，jobs 为空" });
  }

  const ledger = ledgerText
    ? jobsFromLedger(ledgerText, ledgerSource)
    : { jobs: [], applied: [], warnings: [] };
  warnings.push(...ledger.warnings);

  const logFiles = [];
  if (logDir) {
    try {
      const names = (await readdir(logDir)).filter((name) => logPattern.test(name)).sort();
      for (const name of names) {
        const filePath = join(logDir, name);
        const [text, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
        logFiles.push({ name, text });
        sources.push({ path: filePath, bytes: info.size, mtime: info.mtime.toISOString() });
      }
    } catch (error) {
      warnings.push({
        level: "error",
        source: logDir,
        line: "",
        message: `日志目录读取失败：${error && error.code ? error.code : String(error)}（${logDir}）`,
      });
    }
  }

  const logResult = eventsFromLogs(logFiles, { windowDate });
  warnings.push(...logResult.warnings);

  /* 结构化投递记录（applied.ndjson）：由运行脚本每投一条追加一行 JSON。
     运行日志没有地点字段，这份 NDJSON 有 —— 它是把地点覆盖率补上去的关键来源。 */
  const ndjsonFiles = [];
  if (logDir) {
    try {
      const names = (await readdir(logDir)).filter((name) => ndjsonPattern.test(name)).sort();
      for (const name of names) {
        const filePath = join(logDir, name);
        const [text, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
        ndjsonFiles.push({ name, text });
        sources.push({ path: filePath, bytes: info.size, mtime: info.mtime.toISOString() });
      }
    } catch (error) {
      warnings.push({
        level: "error",
        source: logDir,
        line: "",
        message: `结构化投递记录读取失败：${error && error.code ? error.code : String(error)}（${logDir}）`,
      });
    }
  }
  const ndjsonResult = jobsFromAppliedNdjson(ndjsonFiles, { windowDate });
  warnings.push(...ndjsonResult.warnings);

  const byFile = new Map();
  for (const event of logResult.events) {
    if (!byFile.has(event.source)) byFile.set(event.source, []);
    byFile.get(event.source).push(event);
  }
  for (const [name, events] of byFile) warnings.push(logSummaryWarning(name, events));

  const logJobs = jobsFromLogEvents(logResult.events, warnings);
  const ledgerIds = new Set(ledger.jobs.map((job) => job.id));
  let mergedInto = 0;
  const newIds = [];
  for (const id of new Set(logJobs.jobs.map((job) => jobIdOf(job)))) {
    if (ledgerIds.has(id)) mergedInto += 1;
    else newIds.push(id);
  }
  if (logJobs.jobs.length) {
    warnings.push({
      level: "info",
      source: "运行日志",
      line: "",
      message:
        `运行日志 OK 行共 ${logJobs.jobs.length} 条，生成 applied 岗位记录：` +
        `${newIds.length} 条新建（source=运行日志 <文件>，company 未知记 ""）、` +
        `${mergedInto} 条与台账同名同公司记录合并并带入 keywords`,
    });
  }

  const mergedResult = mergeJobRecords([...ledger.jobs, ...logJobs.jobs, ...ndjsonResult.jobs]);
  warnMerges(mergedResult.merged, ledgerSource, warnings, "台账 + 运行日志 + 结构化记录：");
  warnCompanyCollisions(mergedResult.jobs, ledgerSource, warnings);
  warnTitlePrefixCollisions(mergedResult.jobs, ledgerSource, warnings);

  const applied = [...ledger.applied, ...logResult.events, ...ndjsonResult.events]
    .filter((event) => {
      if (event.at) return true;
      warnings.push({
        level: "warn",
        source: event.source || ledgerSource,
        line: event.line || "",
        message: `事件缺少时间戳，未进入 payload.applied：${clip(event.raw || event.reason || event.title || "")}`,
      });
      return false;
    })
    .map(toAppliedEvent)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const counted = countByKind(applied);
  warnings.push({
    level: "info",
    source: ledgerSource,
    line: "",
    message:
      `总览：jobs ${mergedResult.jobs.length} 条、applied 事件 ${applied.length} 条` +
      `（其中 kind=applied ${counted.applied || 0} 条 = 台账核验 + 日志 OK 行；` +
      `nav_timeout ${counted.nav_timeout || 0}、miss ${counted.miss || 0}、cycle ${counted.cycle || 0}、` +
      `start ${counted.start || 0}、summary ${counted.summary || 0}、error ${counted.error || 0}）、` +
      `warnings ${warnings.length + 1} 条（含本条）`,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAtFrom(options.now),
    jobs: mergedResult.jobs,
    applied,
    warnings,
    sources,
  };
}
