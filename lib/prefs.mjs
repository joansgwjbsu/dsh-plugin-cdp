/**
 * dsh-plugin-cdp — 投递偏好（弹窗询问的落盘形态）
 *
 * 用户明确要求「不要走页面，使用弹窗」，并且首次使用时要主动询问：
 *   投什么岗位 / 工作地点在哪 / 薪资范围多少 / 使用什么软件（平台）/ 用哪个浏览器。
 *
 * 本模块只负责**存取与校验**，不负责「怎么问」。问由模型调用内置的
 * ask_user_question 工具完成（它支持每题自定义文本输入），本模块负责：
 *   1. 给出问卷模板（askUserQuestionPayload）
 *   2. 把用户答案合并进偏好并落盘（mergeAnswers）
 *   3. 告诉调用方「还缺什么」→ 决定是否需要弹窗（missingRequired）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ 设计红线：本文件**不得携带任何投递规则**（用户 2026-10-13 明确要求：
 *    「插件本身不要携带我给你投递规则，其他用户需要自己设定规则，
 *      你只需要给插件一个能跑通的能力」）。
 *
 *    因此：
 *      - 默认值一律为空（[] / {} / ""），不预置任何城市、岗位方向、薪资数字；
 *      - 问卷**不生成 options**，也不标 (Recommended) —— 一旦预置选项，
 *        等于把某个人（我）的规则当成新用户的默认答案，这本身就是携带规则；
 *      - 只允许出现「格式示例」，且必须显式标注为示例，用占位符而非真实规则；
 *      - 规则的内容、严格程度、判定口径全部由用户自己填。
 *
 *    插件提供的是**能力**（问得出、存得下、读得回、能热替换），不是内容。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 偏好文件位置：与 .cdp-target.json 同级的插件自有目录。 */
export const DEFAULT_PREFS_PATH = "D:\\dsh\\.cdp-prefs.json";

export const PREFS_SCHEMA_VERSION = 2;

/** 平台可选值。key 是内部标识，label 是给用户看的选项文案。 */
export const PLATFORM_CHOICES = [
  { key: "zhaopin", label: "智联招聘" },
  { key: "boss", label: "Boss直聘" },
  { key: "liepin", label: "猎聘" },
];

/** 浏览器可选值。key 是内部标识，exe 是 ChromeHost 需要的可执行文件候选。 */
export const BROWSER_CHOICES = [
  {
    key: "chrome",
    label: "Google Chrome",
    exe: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  {
    key: "edge",
    label: "Microsoft Edge",
    exe: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
];

/**
 * 「格式示例」常量 —— 只用于告诉用户**怎么写**，绝不作为默认值或推荐答案。
 * 用占位符保持中性，避免任何人的真实规则沉淀进来。
 */
const FORMAT_HINT = {
  titles: "多个方向用逗号或顿号分隔，例如：方向A、方向B、方向C",
  locations: "多个城市用逗号分隔，第一个最优先，例如：城市A、城市B",
  salary: "每个城市的最低薪资下限，例如：城市A 数字，城市B 数字",
};

/**
 * 空偏好。**所有规则字段都为空** —— 插件不预设任何规则内容。
 */
export function defaultPrefs() {
  return {
    schemaVersion: PREFS_SCHEMA_VERSION,
    /** 目标岗位方向（用户填的自由文本）。 */
    titles: [],
    /** 目标城市，按优先级排序（第一个最优先）。 */
    locations: [],
    /** 每个城市的最低薪资下限（元/月）。只按区间下限判断。 */
    salaryFloor: {},
    /** 薪资区间上限（元/月），null 表示不限。 */
    salaryCeil: null,
    /** 要投的平台 key 列表。 */
    platforms: [],
    /** 使用哪个浏览器 key（chrome / edge）。 */
    browser: "",
    /**
     * 用户的排除规则 / 附加约束（自由文本行）。
     * 插件不理解其内容，只负责原样保存与展示；判定逻辑由用户提供的
     * 运行器（runner）自行解释。这是「用户自己设定规则」的落点。
     */
    excludeNotes: [],
    /** 用户自定义的问答之外的自由说明。 */
    notes: "",
    /** 是否在投递前要求确认。 */
    confirmBeforeApply: true,
    /** 首次询问完成时间；为空表示还没问过。 */
    confirmedAt: "",
  };
}

/** 把用户答案里的数字/列表做一次清洗，避免脏数据进配置。 */
function normalizeList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[,，、;；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeFloor(v) {
  const out = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v)) {
      const num = Number(n);
      if (k && Number.isFinite(num) && num > 0) out[String(k).trim()] = Math.round(num);
    }
  }
  return out;
}

/** 读取偏好；文件不存在或损坏时返回 defaultPrefs() 而不是抛错。 */
export function loadPrefs(path = DEFAULT_PREFS_PATH) {
  const base = defaultPrefs();
  if (!existsSync(path)) return { ...base, _exists: false };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...base,
      ...raw,
      titles: normalizeList(raw.titles),
      locations: normalizeList(raw.locations),
      salaryFloor: normalizeFloor(raw.salaryFloor),
      platforms: normalizeList(raw.platforms),
      excludeNotes: normalizeList(raw.excludeNotes),
      notes: typeof raw.notes === "string" ? raw.notes : "",
      salaryCeil: Number.isFinite(Number(raw.salaryCeil)) && Number(raw.salaryCeil) > 0 ? Number(raw.salaryCeil) : null,
      browser: typeof raw.browser === "string" ? raw.browser : "",
      confirmBeforeApply: raw.confirmBeforeApply !== false,
      _exists: true,
    };
  } catch {
    // 文件损坏：不要静默用默认值开跑，标记出来让调用方去问用户。
    return { ...base, _exists: false, _corrupt: true };
  }
}

/** 原子写入：先写临时文件再 rename，避免半截 JSON 把偏好打坏。 */
export function savePrefs(prefs, path = DEFAULT_PREFS_PATH) {
  const clean = {
    schemaVersion: PREFS_SCHEMA_VERSION,
    titles: normalizeList(prefs.titles),
    locations: normalizeList(prefs.locations),
    salaryFloor: normalizeFloor(prefs.salaryFloor),
    salaryCeil: Number.isFinite(Number(prefs.salaryCeil)) && Number(prefs.salaryCeil) > 0 ? Number(prefs.salaryCeil) : null,
    platforms: normalizeList(prefs.platforms).filter((p) => PLATFORM_CHOICES.some((c) => c.key === p)),
    browser: BROWSER_CHOICES.some((c) => c.key === prefs.browser) ? prefs.browser : "",
    excludeNotes: normalizeList(prefs.excludeNotes),
    notes: typeof prefs.notes === "string" ? prefs.notes : "",
    confirmBeforeApply: prefs.confirmBeforeApply !== false,
    confirmedAt: typeof prefs.confirmedAt === "string" ? prefs.confirmedAt : "",
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8");
  renameSync(tmp, path);
  return clean;
}

/**
 * 判断还缺哪些必填项 —— 这就是「首次使用时主动询问」的触发器。
 * @returns {string[]} 缺失项的中文说明；空数组表示配置完整，可直接开跑。
 */
export function missingRequired(prefs) {
  const missing = [];
  if (!prefs.titles || prefs.titles.length === 0) missing.push("目标岗位方向");
  if (!prefs.locations || prefs.locations.length === 0) missing.push("工作地点");
  if (!prefs.platforms || prefs.platforms.length === 0) missing.push("投递平台（使用什么软件）");
  if (!prefs.browser) missing.push("使用哪个浏览器");
  const floor = prefs.salaryFloor || {};
  const noFloor = (prefs.locations || []).filter((c) => !Number.isFinite(floor[c]));
  if (prefs.locations && prefs.locations.length > 0 && noFloor.length > 0) {
    missing.push(`这些城市还没定薪资下限：${noFloor.join("、")}`);
  }
  if (!prefs.confirmedAt) missing.push("尚未完成首次确认");
  return missing;
}

/**
 * 构造给 ask_user_question 的问卷。
 *
 * ⚠️ 这里**故意不生成 options**：一旦预置选项，就等于把某个人的规则当成
 *    新用户的默认答案。5 个问题全部依赖 ask_user_question 的自由文本输入
 *    （答案回在 `custom` 字段），用户必须自己写下规则。
 *    只有「平台」和「浏览器」给选项 —— 它们是**枚举选择**而非规则内容。
 *
 * @param {object} prefs 当前偏好（若已有值则作为 detail 回显，不回填成选项）
 * @returns {{questions: Array<object>}} 可直接作为 ask_user_question 的 questions 参数
 */
export function askUserQuestionPayload(prefs = defaultPrefs()) {
  const echo = (v, fallback = "（尚未设置）") => (v && v.length ? v.join("、") : fallback);
  return {
    questions: [
      {
        id: "titles",
        header: "岗位方向",
        question: "想投什么岗位？请直接输入你的目标方向。",
        detail: `${FORMAT_HINT.titles}\n当前：${echo(prefs.titles)}`,
        multiSelect: true,
      },
      {
        id: "locations",
        header: "工作地点",
        question: "工作地点在哪？多个城市用逗号分隔，第一个最优先。",
        detail: `${FORMAT_HINT.locations}\n当前：${echo(prefs.locations)}`,
        multiSelect: true,
      },
      {
        id: "salary",
        header: "薪资范围",
        question: "每个城市的薪资下限是多少？请按「城市 数字」的格式填写。",
        detail: `${FORMAT_HINT.salary}\n判定口径由你的规则决定；插件只负责记录。`,
      },
      {
        id: "platforms",
        header: "投递平台",
        question: "用哪些软件投递？可多选。",
        detail: "三个平台各自独立统计。未登录的平台会被跳过并提示你登录。",
        options: PLATFORM_CHOICES.map((c) => ({ label: c.label })),
        multiSelect: true,
      },
      {
        id: "browser",
        header: "浏览器",
        question: "用哪个浏览器做自动化？",
        detail: "插件会用它自己的独立用户目录启动一个受控实例，不会碰你日常浏览器的配置。",
        options: BROWSER_CHOICES.map((c) => ({ label: c.label })),
      },
      {
        id: "excludeNotes",
        header: "排除规则",
        question: "有哪些岗位是你要排除的？可以逐条写，用换行或逗号分隔。",
        detail: "插件不理解这些内容，只原样保存并交给你的运行器判定。留空表示你不需要额外排除项。",
        multiSelect: true,
      },
    ],
  };
}

/**
 * 把一次 ask_user_question 的答案合并进偏好。
 *
 * 答案形状（见 dsh-user-questions 类型）：
 *   { answers: [{ id, selected: string[], custom?: string }] }
 * 单选的 `custom` 会**替换** selected，多选的 `custom` 是**补充**。
 * 对自由文本类问题，只信 custom；对枚举类问题（平台/浏览器），把 selected 的
 * label 反查回内部 key。
 *
 * @param {object} prefs 现有偏好
 * @param {{answers?: Array<object>}} answer ask_user_question 的返回
 * @returns {{prefs: object, notes: string[]}} 合并结果与人类可读说明
 */
export function mergeAnswers(prefs, answer) {
  const next = { ...defaultPrefs(), ...prefs };
  const notes = [];
  const items = Array.isArray(answer?.answers) ? answer.answers : [];
  const byId = new Map(items.map((a) => [a.id, a]));

  const pick = (id) => {
    const a = byId.get(id);
    if (!a) return { selected: [], custom: "" };
    return {
      selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
      custom: typeof a.custom === "string" ? a.custom.trim() : "",
    };
  };

  /**
   * 自由文本类问题：custom 优先，selected 作为补充。
   *
   * ⚠️ 返回 null 表示「本次没回答这个问题」，空数组表示「用户明确清空」。
   * 这个区分是必须的 —— 否则一旦填过就再也删不掉：
   * 踩过的坑（2026-10-13 真实踩到）：用户想清掉 3 条排除规则、传了空 custom，
   * 结果偏好里仍是 3 条。因为 mergeAnswers 只做「合并」，空答案被当成
   * 「没回答」，旧值原样保留 → 排除规则、城市、岗位方向全都只能加不能删。
   */
  const freeText = (id) => {
    const a = byId.get(id);
    if (!a) return null; // 本次没问/没答，保留旧值
    const { selected, custom } = pick(id);
    const text = typeof a.custom === "string" ? a.custom.trim() : "";
    const merged = normalizeList([...normalizeList(text), ...normalizeList(selected.join("、"))]);
    return merged; // 可能是 []，表示明确清空
  };

  // ---- 岗位方向 ----
  {
    const merged = freeText("titles");
    if (merged !== null) {
      // 空数组 = 用户明确清空，必须真的清掉（见 freeText 的注释）
      next.titles = merged;
      notes.push(merged.length ? `岗位方向：${merged.join("、")}` : "岗位方向：已清空");
    }
  }

  // ---- 地点 ----
  {
    const merged = freeText("locations");
    if (merged !== null) {
      next.locations = merged;
      notes.push(merged.length ? `工作地点：${merged.join("、")}` : "工作地点：已清空");
    }
  }

  // ---- 薪资下限：格式「城市 数字」 ----
  {
    const a = byId.get("salary");
    const { selected, custom } = pick("salary");
    const text = custom || selected.join("，");
    const floor = { ...(next.salaryFloor || {}) };
    // 城市名允许中英混合：早先写成 [\u4e00-\u9fa5]{2,6} 只认纯中文，
    // 遇到「城市A 1000」这类名字会静默漏掉（连数字都一起跳过，只报一句没解析出来）。
    // 现在放宽到中英文字母 1-8 位。
    const re = /([A-Za-z\u4e00-\u9fa5]{1,8})\s*[:：]?\s*(\d+(?:\.\d+)?)\s*([kK千])?/g;
    let m;
    let hit = 0;
    while ((m = re.exec(text)) !== null) {
      const city = m[1].trim();
      const mult = m[3] ? 1000 : 1;
      const val = Math.round(Number(m[2]) * mult);
      if (city && Number.isFinite(val) && val > 0) {
        floor[city] = val;
        hit += 1;
      }
    }
    // 兜底：如果用户只给了数字没给城市，且只有一个目标城市，就套用到它
    if (hit === 0) {
      const nums = text.match(/\d+(?:\.\d+)?\s*[kK千]?/g) || [];
      if (nums.length && next.locations.length === 1) {
        const raw = nums[0];
        const mult = /[kK千]/.test(raw) ? 1000 : 1;
        floor[next.locations[0]] = Math.round(Number(raw.replace(/[kK千]/g, "")) * mult);
        hit += 1;
      }
    }
    if (a === undefined) {
      // 本次没回答薪资 → 完全不碰 salaryFloor（保持原样）
    } else if (hit > 0) {
      /* ⚠️ 这里是**按城市合并**，不是整体替换：本次提到的城市覆盖，未提到的保留。
         后果是「删城市」没有入口 —— 比如误写入的城市用问答清不掉。
         因此 cdp_prefs 额外提供 salaryCities 参数来显式限定城市集合。
         改动本段语义时请一并考虑那个参数。 */
      next.salaryFloor = floor;
      notes.push(`薪资下限：${Object.entries(floor).map(([c, v]) => `${c} ${v}`).join("，")}`);
    } else if (text.trim()) {
      notes.push(`⚠️ 薪资下限没解析出来（原文「${text.trim()}」），请按「城市 数字」重填`);
    }
  }

  // ---- 平台（枚举） ----
  {
    const { selected, custom } = pick("platforms");
    // ⚠️ 必须先把「智联招聘、Boss直聘、猎聘」这种多选 label 拆开再逐个匹配。
    //    早期写法直接拿整串去 find()，只匹配到第一个平台，静默丢掉其余两个。
    const all = [...selected, ...(custom ? normalizeList(custom) : [])];
    const keys = [];
    for (const s of all) {
      for (const piece of normalizeList(s.replace(/\(Recommended\)/gi, ""))) {
        const hit = PLATFORM_CHOICES.find(
          (c) => piece === c.label || piece === c.key || piece.includes(c.label),
        );
        if (hit && !keys.includes(hit.key)) keys.push(hit.key);
      }
    }
    if (keys.length) {
      next.platforms = keys;
      notes.push(`投递平台：${keys.map((k) => PLATFORM_CHOICES.find((c) => c.key === k).label).join("、")}`);
    }
  }

  // ---- 浏览器（枚举） ----
  {
    const { selected, custom } = pick("browser");
    const all = [...selected, ...normalizeList(custom)];
    let key = "";
    for (const s of all) {
      const clean = s.replace(/\(Recommended\)/gi, "").trim().toLowerCase();
      const hit = BROWSER_CHOICES.find((c) => clean.includes(c.key) || clean.includes(c.label.toLowerCase()));
      if (hit) {
        key = hit.key;
        break;
      }
    }
    if (key) {
      next.browser = key;
      notes.push(`浏览器：${BROWSER_CHOICES.find((c) => c.key === key).label}`);
    }
  }

  // ---- 排除规则（用户自己的内容，原样保存） ----
  {
    const merged = freeText("excludeNotes");
    if (merged !== null) {
      next.excludeNotes = merged;
      notes.push(merged.length ? `排除规则：${merged.length} 条` : "排除规则：已清空");
    }
  }

  next.confirmedAt = new Date().toISOString();
  return { prefs: next, notes };
}

/** 把偏好渲染成一段人可读的文本摘要（给弹窗/聊天确认用）。 */
export function describePrefs(prefs) {
  const lines = [];
  const t = (prefs.titles || []).join("、") || "（未设置）";
  const l = (prefs.locations || []).join("、") || "（未设置）";
  lines.push(`岗位方向：${t}`);
  lines.push(`工作地点：${l}`);
  const floor = prefs.salaryFloor || {};
  const floorText = Object.entries(floor).map(([c, v]) => `${c} ≥ ${v} 元`).join("，") || "（未设置）";
  lines.push(`薪资下限：${floorText}${prefs.salaryCeil ? `，上限 ≤ ${prefs.salaryCeil} 元` : "，上限不限"}`);
  const pf = (prefs.platforms || []).map((k) => PLATFORM_CHOICES.find((c) => c.key === k)?.label || k).join("、") || "（未设置）";
  lines.push(`投递平台：${pf}`);
  const br = BROWSER_CHOICES.find((c) => c.key === prefs.browser)?.label || "（未设置）";
  lines.push(`浏览器：${br}`);
  const ex = (prefs.excludeNotes || []).length;
  lines.push(`排除规则：${ex ? `${ex} 条（用户自定义）` : "（无）"}`);
  lines.push(`投递前确认：${prefs.confirmBeforeApply ? "需要" : "不需要"}`);
  if (prefs.confirmedAt) lines.push(`上次确认：${prefs.confirmedAt}`);
  return lines.join("\n");
}

/** 解析浏览器 key 或用户自填路径 → 可执行文件路径候选列表。 */
export function browserCandidates(browserKey) {
  const hit = BROWSER_CHOICES.find((c) => c.key === browserKey);
  return hit ? hit.exe : [];
}

/**
 * 规则指纹：用于检测「用户改了规则」。
 *
 * 只对**规则字段**取指纹，不含 confirmedAt、_exists 这类元数据 ——
 * 否则每次读盘（confirmedAt 被刷新）都会误判成规则变更，导致进程反复重启。
 * 这是热替换能否稳定工作的关键：指纹必须只随规则内容变化。
 *
 * @param {object} prefs
 * @returns {string} 稳定的短指纹
 */
export function rulesFingerprint(prefs) {
  const rules = {
    titles: prefs?.titles || [],
    locations: prefs?.locations || [],
    salaryFloor: prefs?.salaryFloor || {},
    salaryCeil: prefs?.salaryCeil ?? null,
    platforms: prefs?.platforms || [],
    browser: prefs?.browser || "",
    excludeNotes: prefs?.excludeNotes || [],
    notes: prefs?.notes || "",
    confirmBeforeApply: prefs?.confirmBeforeApply !== false,
  };
  // 键排序 + 数组保持用户给定顺序（顺序有意义：locations 第一个最优先）
  const canonical = JSON.stringify(rules, Object.keys(rules).sort());
  let h = 2166136261; // FNV-1a 32-bit
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function prefsPathFrom(configuredPath) {
  return resolve(configuredPath || DEFAULT_PREFS_PATH);
}
