/**
 * dsh-plugin-cdp — 运行日志解析 + 公共归一工具（零依赖，仅 node: 内置模块）
 *
 * 职责：
 *   1. 把 `D:\dsh\jw\run-*.log` 解析成结构化事件：platform / keyword / kind /
 *      title / salaryRaw / salaryMin / salaryMax / at / verified；
 *   2. 导出与契约无关的小工具（平台别名归一、时间补日期、markdown 文本清洗），
 *      由 `lib/jobs.mjs` 复用，避免两份实现漂移。
 *
 * 契约：`lib/contract.mjs`（FROZEN v1 + 2026-10-13 扩展）
 *   - JobRecord.keywords: string[]          该岗位被哪些搜索关键词命中过
 *   - AppliedEvent.kind: LOG_EVENT_KINDS    事件类型（applied/miss/nav_timeout/error/cycle/start/summary）
 *   - AppliedEvent.title: string|null       失败类事件没有岗位名，用 null（不要用空串冒充）
 *   - AppliedEvent.keyword: string          触发本次投递的搜索关键词；未知为 ""
 *   - DashboardPayload.sources: 数组（非 map）
 *
 * 设计约定：
 *   - 失败类事件（miss / nav_timeout / error）的 title 一律 null，salaryRaw 一律 ""：
 *     例如 `miss 薪资下限 5000 < 7000` 里的 5000 是「被拒绝的门槛」，不是岗位薪资，
 *     绝不能写进 salaryMin 冒充岗位薪资（消费方按 kind === "applied" 过滤计数）。
 *   - 猎聘日志的 `[1985241231]` 行是「队列岗位 id」，不是搜索关键词：keyword 记 ""
 *     （契约语义是搜索关键词），id 保留在事件的 queueId / raw 里，由 jobs.mjs 汇总进 warnings。
 *   - 日志行解析不了的（缺时间戳、既非 OK 也非 miss 等）一律进 warnings，不静默丢弃。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { LOG_EVENT_KINDS, PLATFORMS, parseSalary } from "./contract.mjs";

/**
 * 台账投递窗口日期。日志文件名不含日期时用它补全（task-1 规定），
 * 依据：jw/投递台账.md「# 2026-10-13 上午投递窗口（10:00–11:30）」与
 * 「## 12:03 复盘」——全部 run-*.log 的 10:2x–12:0x 都属于 2026-10-13。
 */
export const WINDOW_DATE = "2026-10-13";

const LOG_EVENT_KIND_SET = new Set(LOG_EVENT_KINDS);

/** markdown 表格里的「空值」写法，一律归成 ""，不要用 0 或 "—" 冒充。 */
const BLANK_MARKERS = new Set([
  "", "—", "–", "－", "-", "--", "---", "/", "\\", "…", "...", "n/a", "N/A", "无",
]);

/** 平台别名：归一成 PLATFORMS 的键。 */
const PLATFORM_ALIASES = [
  [/智联|zhaopin|\bzp\b/i, "zhaopin"],
  [/boss|直聘|zhipin/i, "boss"],
  [/猎聘|liepin|\blp\b/i, "liepin"],
];

/* ------------------------------------------------------------------ *
 * 文本 / 平台 / 时间 归一
 * ------------------------------------------------------------------ */

/** 是否是「空值」写法（"—" / "" / "n/a" …）。 */
export function isBlankMarker(raw) {
  if (raw === null || raw === undefined) return true;
  return BLANK_MARKERS.has(String(raw).trim());
}

/** 去掉 markdown 粗体/行内代码标记与转义竖线，压缩空白。不做其它清洗。 */
export function plainText(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replace(/\\\|/g, "|")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 空值写法 → ""；其余走 plainText。 */
export function blankOf(raw) {
  return isBlankMarker(raw) ? "" : plainText(raw);
}

/** 平台归一：智联/zhaopin/zp → zhaopin，Boss/直聘 → boss，猎聘/liepin → liepin。 */
export function normalizePlatform(raw) {
  if (raw === null || raw === undefined) return "";
  const text = plainText(raw);
  if (!text) return "";
  if (Object.prototype.hasOwnProperty.call(PLATFORMS, text)) return text;
  for (const [re, key] of PLATFORM_ALIASES) if (re.test(text)) return key;
  return "";
}

/** 从文件名推断平台：run-zp-B.log → zhaopin，run-boss.log → boss，run-liepin.log → liepin。 */
export function platformFromFileName(name) {
  const base = String(name || "").toLowerCase();
  if (!base) return "";
  if (/boss|zhipin/.test(base)) return "boss";
  if (/liepin/.test(base)) return "liepin";
  if (/zhaopin|(^|[^a-z])zp([^a-z]|$)/.test(base)) return "zhaopin";
  return "";
}

export function pad2(value) {
  return String(value).padStart(2, "0");
}

/** 取文本里第一个合法 YYYY-MM-DD；没有则 ""。 */
export function dateFromText(text) {
  const m = String(text ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 取文本里第一个 HH:MM[:SS]，归一成 HH:mm:ss；没有则 ""。 */
export function timeFromText(text) {
  const m = String(text ?? "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] ? Number(m[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return "";
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

/** 文件名里的日期，如 run-2026-10-13.log / run_zp_2026_10_13.log。 */
export function dateFromFileName(name) {
  return dateFromText(String(name ?? "").replace(/[_.]/g, "-"));
}

/** 日期 + 时刻 → "YYYY-MM-DDTHH:mm:ss"；没有日期则 ""（缺时刻按 00:00:00）。 */
export function isoFromParts(date, time) {
  const day = dateFromText(date);
  if (!day) return "";
  return `${day}T${timeFromText(time) || "00:00:00"}`;
}

/** 契约约定的「只有日期没有时刻」占位：当日 00:00:00。 */
export function isDateOnlyPlaceholder(at) {
  return typeof at === "string" && at.length === 19 && at.endsWith("T00:00:00");
}

/** 截断长文本，避免 warnings / 报告被整行原文撑爆。 */
export function clip(text, max = 120) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/* ------------------------------------------------------------------ *
 * 日志解析
 * ------------------------------------------------------------------ */

const LOG_LINE_RE = /^\[(\d{1,2}:\d{2}:\d{2})\]\s?(.*)$/;
const ROUND_RE = /^#+\s*第\s*(\d+)\s*轮/;
/** 形如 1.1-1.3万 / 8000-15000元 / 180-220元/天 / 9-18k·14薪 的整段薪资 token。 */
const SALARY_TOKEN_RE =
  /^\d+(?:\.\d+)?\s*[-–—~至]\s*\d+(?:\.\d+)?\s*(?:万|[kK千])?\s*元?(?:\s*[·/]\s*(?:\d{2}\s*薪|天|月))?$/;
/** 兜底：尾部带单位的薪资（8000元 / 1.2万 / 9-18k·14薪）。 */
const SALARY_TAIL_RE =
  /(\d[\d.]*(?:\s*[-–—~至]\s*[\d.]+)?\s*(?:万|[kK千]|元)(?:\s*[·/]\s*(?:\d{2}\s*薪|天|月))?)\s*$/;

function extractCounts(text) {
  const counts = {};
  const re = /([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(\d+)/g;
  for (const m of String(text ?? "").matchAll(re)) {
    if (/^tab$/i.test(m[1])) continue; // tab=0F50… 会被误读，跳过
    counts[m[1]] = Number(m[2]);
  }
  return Object.keys(counts).length ? counts : null;
}

/** `steps=["未找到聊一聊/继续聊",…]` → string[]。 */
function parseSteps(raw) {
  const body = String(raw ?? "")
    .replace(/\]\s*$/, "")
    .replace(/,\s*$/, "")
    .trim();
  if (!body) return [];
  try {
    const parsed = JSON.parse(`[${body}]`);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
  } catch {
    /* 不是合法 JSON，退回引号抽取 */
  }
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** `OK <岗位> <薪资>（ok=N）` → { title, salaryRaw }；解析不出薪资就留 ""（不编造）。 */
function splitTitleSalary(raw) {
  let text = plainText(raw).replace(/^OK\s+/i, "").trim();
  text = text
    .replace(/[（(][^（()）]*(?:ok|miss|navfail)\s*=[^（()）]*[)）]\s*$/i, "")
    .trim();
  const tokens = text.split(/\s+/);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (SALARY_TOKEN_RE.test(last)) {
      return { title: tokens.slice(0, -1).join(" ").trim(), salaryRaw: last };
    }
  }
  const tail = text.match(SALARY_TAIL_RE);
  if (tail && tail.index > 0) {
    return { title: text.slice(0, tail.index).trim(), salaryRaw: tail[1].trim() };
  }
  return { title: text, salaryRaw: "" };
}

function makeEvent(base, fields) {
  return {
    platform: fields.platform || "",
    kind: LOG_EVENT_KIND_SET.has(fields.kind) ? fields.kind : "error",
    keyword: fields.keyword || "",
    title: fields.title === undefined || fields.title === null || fields.title === ""
      ? null
      : String(fields.title),
    salaryRaw: fields.salaryRaw ? String(fields.salaryRaw) : "",
    salaryMin: typeof fields.salaryMin === "number" ? fields.salaryMin : null,
    salaryMax: typeof fields.salaryMax === "number" ? fields.salaryMax : null,
    verified: fields.verified === true,
    reason: fields.reason ? String(fields.reason) : "",
    steps: fields.steps || null,
    counts: fields.counts || null,
    queueId: fields.queueId || "",
    ...base,
  };
}

/**
 * 解析单个日志文件的全部内容。
 *
 * @param {string} text 日志原文
 * @param {{ name?: string, platform?: string, date?: string, windowDate?: string }} [options]
 * @returns {{ events: object[], warnings: object[] }}
 */
export function parseLogText(text, options = {}) {
  const name = options.name || "run.log";
  const filePlatform =
    options.platform !== undefined && options.platform !== null
      ? options.platform
      : platformFromFileName(name);
  const fileDate = options.date ? dateFromText(options.date) : dateFromFileName(name);
  const windowDate = dateFromText(options.windowDate) || WINDOW_DATE;
  const date = fileDate || windowDate;

  const events = [];
  const warnings = [];
  const state = { platform: filePlatform, keyword: "" };

  if (!fileDate) {
    warnings.push({
      level: "info",
      source: name,
      line: "",
      message:
        `日志文件名不含日期，文件内 HH:MM:SS 一律按台账投递窗口补成 ${date}` +
        `（推断依据：台账「2026-10-13 上午投递窗口」与「12:03 复盘」）`,
    });
  }

  const lines = String(text ?? "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const lm = trimmed.match(LOG_LINE_RE);
    if (!lm) {
      // 仅 `steps=[...]` 的续行会走到这里，且已被上一行消费 → 其余都是真·无法识别的行
      warnings.push({
        level: "warn",
        source: name,
        line: lineNo,
        message: `无法识别的日志行（缺少 [HH:MM:SS] 时间戳）：${clip(trimmed)}`,
      });
      i += 1;
      continue;
    }

    const time = timeFromText(lm[1]);
    const at = `${date}T${time}`;
    const rest = lm[2].trim();
    i += 1;
    const base = { date, time, at, source: name, line: lineNo, raw: trimmed };

    // === 启动 / 收工 / 调度器 ===
    if (rest.startsWith("===")) {
      const inner = rest.replace(/^=+/, "").replace(/=+$/, "").trim();
      const headToken = (inner.match(/^([^\s=[]+)/) || [])[1] || "";
      const tagPlatform = normalizePlatform(headToken);
      const platform = tagPlatform || state.platform || "";
      if (platform) state.platform = platform;
      const kind = /收工|完成|结束/.test(inner) ? "summary" : /启动|开始/.test(inner) ? "start" : "summary";
      events.push(makeEvent(base, { kind, platform, keyword: state.keyword, counts: extractCounts(inner), reason: inner }));
      if (!platform) {
        warnings.push({
          level: "info",
          source: name,
          line: lineNo,
          message: `该行不属于任何单一平台（全局调度器行），platform 记为 "": ${clip(inner)}`,
        });
      }
      continue;
    }

    // [n] 关键词 / [队列岗位 id]
    const cm = rest.match(/^\[(\d+)\]\s*(.*)$/);
    if (cm) {
      const num = cm[1];
      const tail = cm[2].trim();
      const token = tail.replace(/^kw\s*=\s*/i, "").trim();
      // 猎聘队列条目形如 [10:23:18] [1985241231]：括号里是 10 位岗位 id、后面没有关键词；
      // 而 [1] 运维 的括号里是 1–2 位轮次序号，后面才是关键词。
      const isQueueId = token === "" && num.length >= 4;
      if (isQueueId) {
        state.keyword = "";
        events.push(
          makeEvent(base, {
            kind: "cycle",
            platform: state.platform,
            keyword: "",
            queueId: num,
            reason: `队列条目 ${num}`,
          }),
        );
      } else if (/^\d+$/.test(token)) {
        // 防御：把 id 写在轮次序号后面的写法 [1] 1985241231
        state.keyword = "";
        events.push(
          makeEvent(base, {
            kind: "cycle",
            platform: state.platform,
            keyword: "",
            queueId: token,
            reason: `队列条目 ${token}`,
          }),
        );
      } else {
        state.keyword = token;
        events.push(
          makeEvent(base, {
            kind: "cycle",
            platform: state.platform,
            keyword: token,
            counts: { cycle: Number(num) },
            reason: token ? `关键词 ${token}` : "",
          }),
        );
      }
      continue;
    }

    // [平台] kw=关键词（run-all.log 的全局调度行）
    const tm = rest.match(/^\[([^\]]{1,16})\]\s*(.*)$/);
    if (tm) {
      const tag = normalizePlatform(tm[1]);
      const tail = tm[2].trim();
      const keyword = tail.replace(/^kw\s*=\s*/i, "").trim();
      if (tag) state.platform = tag;
      if (keyword) state.keyword = keyword;
      events.push(
        makeEvent(base, {
          kind: "cycle",
          platform: state.platform,
          keyword: state.keyword,
          reason: tag ? "" : tail,
        }),
      );
      if (!tag) {
        warnings.push({
          level: "info",
          source: name,
          line: lineNo,
          message: `[${tm[1]}] 不是平台名，平台沿用「${state.platform || "未知"}」：${clip(rest)}`,
        });
      }
      continue;
    }

    // OK <岗位> <薪资>（ok=N） —— 真·投递成功行
    const om = rest.match(/^OK\s+(.*)$/);
    if (om) {
      const { title, salaryRaw } = splitTitleSalary(om[1]);
      const salary = parseSalary(salaryRaw);
      events.push(
        makeEvent(base, {
          kind: "applied",
          platform: state.platform,
          keyword: state.keyword,
          title,
          salaryRaw,
          salaryMin: salary.salaryMin,
          salaryMax: salary.salaryMax,
          verified: false,
          counts: extractCounts(om[1]),
        }),
      );
      if (!state.platform) {
        warnings.push({
          level: "warn",
          source: name,
          line: lineNo,
          message: `OK 行无法确定平台，该 applied 事件不进 jobs：${clip(rest)}`,
        });
      }
      if (!salaryRaw) {
        warnings.push({
          level: "warn",
          source: name,
          line: lineNo,
          message: `OK 行未解析出薪资（不编造，salaryRaw 记 ""）：${clip(rest)}`,
        });
      }
      continue;
    }

    // miss ...（可能带多行 steps=[...]）
    const mm = rest.match(/^miss\b\s*(.*)$/);
    if (mm) {
      let tail = mm[1].trim();
      let steps = null;
      const si = tail.indexOf("steps=[");
      if (si >= 0) {
        let buf = tail.slice(si + "steps=[".length);
        tail = tail.slice(0, si).trim();
        if (!/\]\s*$/.test(buf)) {
          while (i < lines.length && !/\]\s*$/.test(lines[i].trim())) {
            buf += ` ${lines[i].trim()}`;
            i += 1;
          }
          if (i < lines.length) {
            buf += ` ${lines[i].trim()}`;
            i += 1;
          }
        }
        steps = parseSteps(buf);
      }
      // 尾部的计数括号（miss=1）已经在 counts 里，从 reason 里去掉，保留可读原因
      const reason = tail
        .replace(/[（(]\s*[A-Za-z_][A-Za-z_0-9]*\s*=\s*\d+\s*[)）]\s*$/, "")
        .trim();
      events.push(
        makeEvent(base, {
          kind: "miss",
          platform: state.platform,
          keyword: state.keyword,
          reason,
          steps,
          counts: extractCounts(mm[1]),
        }),
      );
      continue;
    }

    // 导航超时（可能带「→ 跳过本轮 eval…累计 navFail=N」）
    if (/^导航超时/.test(rest)) {
      events.push(
        makeEvent(base, {
          kind: "nav_timeout",
          platform: state.platform,
          keyword: state.keyword,
          reason: rest,
          counts: extractCounts(rest),
        }),
      );
      continue;
    }

    // 候选 N，未处理 M（Boss 列表采集行）
    const candm = rest.match(/^候选\s*(\d+)\s*[，,]\s*未处理\s*(\d+)/);
    if (candm) {
      events.push(
        makeEvent(base, {
          kind: "summary",
          platform: state.platform,
          keyword: state.keyword,
          counts: { candidates: Number(candm[1]), unprocessed: Number(candm[2]) },
          reason: rest,
        }),
      );
      continue;
    }

    // 队列剩余 N（猎聘）
    const qm = rest.match(/^队列剩余\s*(\d+)/);
    if (qm) {
      events.push(
        makeEvent(base, {
          kind: "summary",
          platform: state.platform,
          keyword: state.keyword,
          counts: { queue: Number(qm[1]) },
          reason: rest,
        }),
      );
      continue;
    }

    // ########## 第 N 轮 ##########
    const rm = rest.match(ROUND_RE);
    if (rm) {
      events.push(
        makeEvent(base, {
          kind: "cycle",
          platform: state.platform,
          keyword: state.keyword,
          counts: { round: Number(rm[1]) },
          reason: rest,
        }),
      );
      if (!state.platform) {
        warnings.push({
          level: "info",
          source: name,
          line: lineNo,
          message: `轮次分隔行未标明平台（platform 记为 ""）：${clip(rest)}`,
        });
      }
      continue;
    }

    // 其它：含错误关键词的记 error 事件，其余只进 warnings
    if (/错误|失败|异常|error|fail/i.test(rest)) {
      events.push(makeEvent(base, { kind: "error", platform: state.platform, keyword: state.keyword, reason: rest }));
      warnings.push({
        level: "warn",
        source: name,
        line: lineNo,
        message: `异常行（已记 error 事件）：${clip(rest)}`,
      });
      continue;
    }

    warnings.push({
      level: "warn",
      source: name,
      line: lineNo,
      message: `无法识别的日志行：${clip(rest)}`,
    });
  }

  return { events, warnings };
}

/**
 * 解析多个日志文件。
 *
 * @param {Array<string | { name?: string, path?: string, text?: string, date?: string, platform?: string }>} files
 * @param {{ windowDate?: string }} [options]
 * @returns {{ events: object[], warnings: object[] }}
 */
export function eventsFromLogs(files, options = {}) {
  const events = [];
  const warnings = [];
  const list = Array.isArray(files) ? files : files ? [files] : [];

  for (const item of list) {
    let name = "run.log";
    let text = "";
    let platform;
    let date;
    try {
      if (typeof item === "string") {
        name = basename(item);
        text = readFileSync(item, "utf8");
      } else if (item && typeof item === "object") {
        name = item.name || (item.path ? basename(item.path) : "run.log");
        platform = item.platform;
        date = item.date;
        if (typeof item.text === "string") text = item.text;
        else if (item.path) text = readFileSync(item.path, "utf8");
      } else {
        continue;
      }
    } catch (error) {
      warnings.push({
        level: "error",
        source: name,
        line: "",
        message: `日志读取失败：${error && error.code ? error.code : String(error)}`,
      });
      continue;
    }

    const result = parseLogText(text, { name, platform, date, windowDate: options.windowDate });
    events.push(...result.events);
    warnings.push(...result.warnings);
  }

  return { events, warnings };
}

/**
 * 事件 → 契约 AppliedEvent（严格 9 个字段，按 JSDoc 顺序）。
 * 失败类事件：title 为 null、salaryRaw 为 ""、salaryMin/Max 为 null。
 */
export function toAppliedEvent(event) {
  return {
    platform: event.platform || "",
    kind: LOG_EVENT_KIND_SET.has(event.kind) ? event.kind : "error",
    title: event.title === null || event.title === undefined || event.title === "" ? null : String(event.title),
    salaryRaw: event.salaryRaw ? String(event.salaryRaw) : "",
    salaryMin: typeof event.salaryMin === "number" ? event.salaryMin : null,
    salaryMax: typeof event.salaryMax === "number" ? event.salaryMax : null,
    at: event.at || "",
    verified: event.verified === true,
    keyword: event.keyword ? String(event.keyword) : "",
  };
}

/** 按 kind 统计事件数。 */
export function countByKind(events) {
  const counts = {};
  for (const event of events || []) {
    const kind = event.kind || "unknown";
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}
