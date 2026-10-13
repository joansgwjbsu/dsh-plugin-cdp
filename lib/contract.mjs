/**
 * dsh-plugin-cdp — 投递数据契约（FROZEN v1）
 *
 * ⚠️ 这是三个并行工作流之间唯一的接口约定，改动需 Lead 同意：
 *   - 数据抽取（lib/jobs.mjs）       → 生产 DashboardPayload
 *   - 前端页面（lib/web/index.html） → 消费 DashboardPayload
 *   - HTTP 服务（lib/web/server.mjs）→ 只做传输，不改字段
 *
 * 设计原则：
 *   1. 抽取值只放「事实」，不放派生指标。统计数字（各平台计数、薪资分桶、
 *      城市分布、时间线）一律由前端从 jobs 现算，避免两处口径不一致。
 *   2. 取值未知时用 null，不要用 0 或空串冒充。0 薪资和「未解析出薪资」
 *      在页面上必须能区分。
 *   3. 任何被解析器拒绝的内容，进 warnings，不静默丢弃。
 */

/** 契约版本。前端与后端不一致时页面应显式提示。 */
export const SCHEMA_VERSION = 1;

/** 站点标识。 */
export const PLATFORMS = /** @type {const} */ ({
  zhaopin: "智联招聘",
  boss: "Boss直聘",
  liepin: "猎聘",
});

/**
 * 投递判定结果。
 *  applied  已投递（有应用事件或台账标记为已投）
 *  pending  合规待投（台账判定 pending）
 *  skipped  被规则表排除（台账判定 skipped）
 *  unknown  无法判定（解析不出判定列）
 */
export const DECISIONS = ["applied", "pending", "skipped", "unknown"];

/**
 * 一条岗位记录。
 *
 * @typedef {object} JobRecord
 * @property {string}  id           稳定去重键：`${platform}:${title}:${company}`，同名同公司同平台视为同一岗位
 * @property {string}  platform     PLATFORMS 的键（zhaopin/boss/liepin）
 * @property {string}  title        岗位名称（原文，不做清洗）
 * @property {string}  company      公司名称；未知为 ""
 * @property {string}  city         城市，如 "城市名"；未知为 ""
 * @property {string}  district     区县，如 "区县名"；未知为 ""
 * @property {string}  locationRaw  原始地点串，如 "城市·区县"；未知为 ""
 * @property {string}  salaryRaw    原始薪资串，如 "1.1-1.3万" / "8000-12000元·13薪" / "面议"
 * @property {number|null} salaryMin 区间下限，单位「元/月」；月薪未标明者按元；无法解析为 null
 * @property {number|null} salaryMax 区间上限，单位「元/月」；无法解析为 null
 * @property {number}  salaryMonths 年薪月数（如 13、14、15）；无标注为 12
 * @property {boolean} salaryIsDaily 是否为日薪（如 "180-220元/天"）。日薪岗位属排除项，页面需单独标红
 * @property {string}  experience  经验要求原文，如 "3-5年" / "经验不限"；未知为 ""
 * @property {string}  education   学历要求原文，如 "大专" / "本科"；未知为 ""
 * @property {string}  decision    DECISIONS 之一
 * @property {string}  basis       判定依据原文（台账「依据」列）；无则 ""
 * @property {string}  appliedAt   投递时间，ISO 8601 本地时间 "YYYY-MM-DDTHH:mm:ss"；未投为 null
 * @property {string}  receipt     回执/状态原文，如 "已向对方发送简历和打招呼语"；无则 ""
 * @property {string}  misapplied  误投原因；非误投为 ""
 * @property {string[]} keywords   该岗位被哪个搜索词命中过（来自运行日志）；无则 []
 * @property {string}  source      数据来源，如 "台账明细" / "台账已投递" / "运行日志 run-zp-B.log"
 */

/**
 * 一次投递应用事件（来自运行日志或台账「已投递」表）。
 *
 * 与 JobRecord 的区别：这是「发生的事」，一条岗位可以有多条事件（重投/换关键词命中）。
 *
 * ⚠️ 消费方约定（2026-10-13 与 data-extractor 确认）：
 *   - `kind === "applied"` 时 title/salaryRaw 才有意义；
 *   - 失败类事件（miss / nav_timeout / error）`title` 为 null、`salaryRaw` 为空串，
 *     只用于统计「哪个关键词命中率低、导航超时多少次」。消费前必须先看 kind，
 *     不要把失败事件当成投递记录计数。
 *
 * @typedef {object} AppliedEvent
 * @property {string}  platform
 * @property {string}  kind      LOG_EVENT_KINDS 之一
 * @property {string|null} title  岗位名；失败类事件为 null
 * @property {string}  salaryRaw  薪资原文；无则 ""
 * @property {number|null} salaryMin
 * @property {number|null} salaryMax
 * @property {string}  at        "YYYY-MM-DDTHH:mm:ss"；仅有日期无时刻时为当日 00:00:00
 * @property {boolean} verified  是否经平台官方记录页核验
 * @property {string}  keyword   触发本次投递的搜索关键词；未知为 ""
 */

/**
 * 解析过程中的非致命问题。禁止静默丢弃任何一行数据。
 *
 * @typedef {object} Warning
 * @property {string} level   "info" | "warn" | "error"
 * @property {string} source  出问题的文件
 * @property {string} line    行号（数字）或 "" 
 * @property {string} message 人可读说明
 */

/**
 * HTTP GET /api/data 的响应体，也是前端唯一的输入。
 *
 * @typedef {object} DashboardPayload
 * @property {number} schemaVersion   必须等于 SCHEMA_VERSION，否则页面报错
 * @property {string} generatedAt     ISO 8601
 * @property {JobRecord[]} jobs       全部岗位，未排序要求；前端自行排序
 * @property {AppliedEvent[]} applied **全部事件**（含 applied / miss / nav_timeout / error），按 at 升序。
 *                                    统计投递数时**必须过滤 kind === "applied"**。
 * @property {Warning[]} warnings    解析告警，页面需有入口展示
 * @property {Array<{path: string, bytes: number, mtime: string}>} sources 数据源清单（数组，非 map）
 */

/**
 * 薪资解析：把各平台五花八门的薪资串统一成「元/月上/下限 + 月数」。
 * 这是全项目最容易出错的一环，单独导出以便单测。
 *
 * 需要覆盖的真实样本（来自台账与日志，必须全部正确）。
 * 注意：这些是**解析器的测试输入**（薪资字符串格式），不是投递规则 ——
 * 规则由用户自己设定，见 lib/prefs.mjs 的设计红线。
 *
 *   "1.1-1.3万"            → min 11000, max 13000, months 12
 *   "8000-12000元"         → min 8000,  max 12000, months 12
 *   "8000-12000元·13薪"    → min 8000,  max 12000, months 13
 *   "1-1.5万·13薪"         → min 10000, max 15000, months 13
 *   "9000-13000元"         → min 9000,  max 13000, months 12
 *   "1.2-1.3万"            → min 12000, max 13000, months 12
 *   "1.5-3万·14薪"         → min 15000, max 30000, months 14
 *   "6001-7000元"          → min 6001,  max 7000,  months 12
 *   "9-18k·14薪"           → min 9000,  max 18000, months 14
 *   "10-12k"               → min 10000, max 12000, months 12
 *   "8-13k"                → min 8000,  max 13000, months 12
 *   "180-220元/天"         → min 180,   max 220,   months 12, isDaily true
 *   "面议" / "—" / 空      → min null,  max null,  months 12
 *   "7000-11000元·13薪"    → min 7000,  max 11000, months 13
 *   "1-1.2万"              → min 10000, max 12000, months 12
 *   "9000-11000元"         → min 9000,  max 11000, months 12
 *   "1.2-1.4万·13薪"       → min 12000, max 14000, months 13
 *   "2.3-2.5万·13薪"       → min 23000, max 25000, months 13
 *   "8000-9000元"          → min 8000,  max 9000,  months 12
 *   "1-2万·14薪"           → min 10000, max 20000, months 14
 *   "1-1.8万"              → min 10000, max 18000, months 12
 *   "1.1-1.8万"            → min 11000, max 18000, months 12
 *   "8000-16000元"         → min 8000,  max 16000, months 12
 *   "9000-10000 / 1-1.1万" → min 9000,  max 10000,  months 12（多区间取第一个）
 *   "6000-7000 / 6000-8000元" → min 6000, max 7000, months 12（多区间取第一个）
 *
 * 注意 "万" 与 "k" 的倍数、小数（1.2 万 = 12000）、以及 "元/天" 的日薪标记。
 *
 * @param {string} raw
 * @returns {{ salaryMin: number|null, salaryMax: number|null, salaryMonths: number, salaryIsDaily: boolean }}
 */
export function parseSalary(raw) {
  const out = { salaryMin: null, salaryMax: null, salaryMonths: 12, salaryIsDaily: false };
  if (raw === null || raw === undefined) return out;

  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) return out;

  // 月数：13薪 / 14薪 / 15薪 / 16薪
  const months = text.match(/(\d{2})\s*薪/);
  if (months) out.salaryMonths = Number(months[1]);

  // 日薪：180-220元/天
  const daily = text.match(/(\d+)\s*-\s*(\d+)\s*元?\s*\/\s*天/);
  if (daily) {
    out.salaryIsDaily = true;
    out.salaryMin = Number(daily[1]);
    out.salaryMax = Number(daily[2]);
    return out;
  }

  // 多区间取第一个：「9000-10000 / 1-1.1万」→ 9000-10000
  const first = text.split(/\s*\/\s*/)[0];

  // 单位判定：万 / k|K|千 / 元（默认元）
  const unit =
    /万/.test(first) ? 10000 : /[kK千]/.test(first) ? 1000 : 1;

  // 数值对：支持小数。允许 "1.1-1.3"、"8000-12000"、"9-18"
  const pair = first.match(/(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)/);
  if (pair) {
    out.salaryMin = Math.round(Number(pair[1]) * unit);
    out.salaryMax = Math.round(Number(pair[2]) * unit);
    return out;
  }

  // 单个数值：「10k以上」「8000元」→ 仅下限可知
  const single = first.match(/(\d+(?:\.\d+)?)\s*(万|[kK千])?/);
  if (single && /[0-9]/.test(single[0])) {
    const mult = single[2] === "万" ? 10000 : single[2] && /[kK千]/.test(single[2]) ? 1000 : unit;
    const v = Math.round(Number(single[1]) * mult);
    out.salaryMin = v;
    out.salaryMax = null;
  }

  // 「面议」「—」「保密」等一律保持 null（不要用 0 冒充）
  if (/面议|保密|薪资面议/.test(text)) {
    out.salaryMin = null;
    out.salaryMax = null;
  }

  return out;
}

/** 运行日志里一行的解析结果类型（供 lib/logs.mjs 对齐）。 */
export const LOG_EVENT_KINDS = ["applied", "miss", "nav_timeout", "error", "cycle", "start", "summary"];
