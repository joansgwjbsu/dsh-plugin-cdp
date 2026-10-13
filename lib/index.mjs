/**
 * dsh-plugin-cdp — Chrome DevTools Protocol automation for DeepSeek Harness.
 *
 * Why this plugin exists: the extension-based browser channel cannot drive some
 * job sites (Boss直聘 blanks the controlled tab; 猎聘 requires a borrowed user
 * tab and blanks on borrow), and that channel reports a success dialog even when
 * no application was recorded. This plugin owns its own Chrome instance, talks
 * raw CDP, and exposes scriptable tools so the model can run a *verifiable*
 * apply flow (select -> wait for panel to settle -> compare salary -> apply).
 *
 * Zero runtime dependencies: uses Node's global fetch + WebSocket (Node >= 22).
 */
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_PREFS_PATH,
  PLATFORM_CHOICES,
  BROWSER_CHOICES,
  defaultPrefs,
  loadPrefs,
  savePrefs,
  missingRequired,
  mergeAnswers,
  describePrefs,
  askUserQuestionPayload,
  browserCandidates,
} from "./prefs.mjs";
import { Supervisor } from "./supervisor.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render a tool's JSON value as a text result (required by the host for every `output`). */
const renderJson = (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }];

/** 按某个取值函数统计数组，返回 { 取值: 计数 }。 */
const countBy = (rows, pick) =>
  rows.reduce((acc, row) => {
    const k = pick(row);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

/** Resolve Chrome's executable path across common install locations. */
function defaultChromePath() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : "",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

/* ------------------------------------------------------------------ *
 * Chrome process management
 * ------------------------------------------------------------------ */

class ChromeHost {
  constructor(config) {
    this.port = config.port;
    this.profile = config.userDataDir;
    this.chromePath = config.chromePath || config.chromePathOverride || defaultChromePath();
    this.windowSize = config.windowSize;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 120000;
    this.loadEventMs = config.loadEventMs ?? 8000;
    this.settleMs = config.settleMs ?? 600;
    this.statePath = resolve(this.profile, "..", ".cdp-target.json");
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  async alive() {
    try {
      const res = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async launch() {
    mkdirSync(this.profile, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,OptimizationHints",
      "--disable-blink-features=AutomationControlled",
      `--window-size=${this.windowSize}`,
      "about:blank",
    ];
    const child = spawn(this.chromePath, args, { detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 60; i += 1) {
      await sleep(500);
      if (await this.alive()) return { started: true, pid: child.pid };
    }
    throw new Error("Chrome did not expose the debugging port in time");
  }

  async ensure() {
    if (await this.alive()) return { started: false };
    return this.launch();
  }

  async targets() {
    const res = await fetch(`${this.base}/json/list`);
    return (await res.json()).filter((t) => t.type === "page");
  }

  /** The tab this plugin drives. Persisted so consecutive tool calls agree. */
  async currentTarget() {
    let id = null;
    if (existsSync(this.statePath)) {
      try {
        id = JSON.parse(readFileSync(this.statePath, "utf8")).targetId;
      } catch {
        id = null;
      }
    }
    const list = await this.targets();
    if (id) {
      const found = list.find((t) => t.id === id);
      if (found) return found;
    }
    const preferred = list.find((t) => /^https?:/.test(t.url)) || list[0];
    if (!preferred) throw new Error("no page target available");
    this.pin(preferred.id);
    return preferred;
  }

  pin(targetId) {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify({ targetId }, null, 2));
  }

  async newTab(url) {
    const res = await fetch(`${this.base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    const t = await res.json();
    this.pin(t.id);
    return t;
  }
}

/* ------------------------------------------------------------------ *
 * Minimal CDP client
 *
 * ⚠️ 这个类与 D:\dsh\jw\cdp.mjs 里的 `class CDP` 是同源代码的两份副本，
 *   改动必须同步。改完任一份后执行：node D:\dsh\jw\healthcheck.mjs
 *
 * 历史教训：两边的 send()/waitEvent() 曾都带着同一个 bug —— 超时定时器
 * 既不清除也不 unref()，进程干完活后事件循环被吊住整个 timeoutMs
 * （nav 62s、eval 100s+），而症状只表现为「导航超时」，离病根极远。
 * ------------------------------------------------------------------ */

class CdpSession {
  constructor(ws, defaultTimeoutMs = 120000) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.defaultTimeoutMs = defaultTimeoutMs;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = (this.seq += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, reject) => {
      // 超时定时器必须保存、在响应/失败时清除，并用 unref()。
      // 否则它会把事件循环吊住整个 timeoutMs：一次 ensure/navigate 明明 1s 干完，
      // 进程却要空等 120s 才退出（实测把 nav 拖成 62s、eval 拖成 100s+）。
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, this.defaultTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  waitEvent(method, timeoutMs = 30000) {
    return new Promise((res, reject) => {
      const done = (fn) => { clearTimeout(timer); this.listeners.delete(fn); };
      const fn = (msg) => {
        if (msg.method === method) {
          done(fn);
          res(msg.params);
        }
      };
      this.listeners.add(fn);
      const timer = setTimeout(() => {
        done(fn);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function connect(host) {
  const target = await host.currentTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, reject) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
  });
  const cdp = new CdpSession(ws, host.defaultTimeoutMs);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { cdp, target };
}

/* ------------------------------------------------------------------ *
 * Page helpers
 * ------------------------------------------------------------------ */

async function evaluate(cdp, expression, awaitPromise = true) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`page exception: ${d.exception?.description || d.text}`);
  }
  return res.result.value;
}

/** Wrap a function-shaped script so it runs, unless already an IIFE. */
function asInvokedExpression(source) {
  const expr = String(source).trim();
  const stripped = expr.replace(/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/|\s*\n)+/, "").trim();
  if (/\)\s*\([^;]*\)\s*;?\s*$/.test(stripped)) return expr;
  const first = stripped.split("\n")[0].trim();
  const looksFn = /^(async\s+)?function\b/.test(first) || /^(async\s+)?\(?[^=]*\)?\s*=>/.test(first);
  if (!looksFn) return expr;
  // Put leading comments INSIDE the parens, else they comment out the call.
  return `(\n${expr}\n)()`;
}

/**
 * The verified-apply primitive. Selects a list card, waits for the detail panel
 * to actually settle on that job (title stable + salary identical), and only
 * then clicks apply. This exists because clicking apply too early is what
 * silently applied to the *previous* job three times today.
 */
const applyFlow = ({ cardSelector, titleExpr, applySelector, salaryExpr, maxWaitMs }) => `(async () => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cardSel = ${JSON.stringify(cardSelector)};
  const applySel = ${JSON.stringify(applySelector)};

  const card = document.querySelector(cardSel);
  if (!card) return { ok: false, reason: 'card selector matched nothing: ' + cardSel };
  const cardText = norm(card.innerText);

  card.scrollIntoView({ block: 'center' });
  await sleep(500);
  const r = card.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    card.dispatchEvent(new MouseEvent(type, o));
  }

  const readTitle = ${titleExpr};
  const readSalary = ${salaryExpr};

  // Wait for the panel title to be non-empty AND stable for 3 consecutive polls.
  let stable = '', same = 0;
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    const t = norm(readTitle());
    if (t && t === stable) {
      same += 1;
      if (same >= 3) break;
    } else {
      stable = t; same = 0;
    }
  }

  const panelSalary = norm(readSalary());
  const salaryMatch = !!panelSalary && panelSalary.replace(/\\s/g, '') === norm(card.querySelector('[class*="salary"]') ? card.querySelector('[class*="salary"]').innerText : '').replace(/\\s/g, '');

  if (!stable) return { ok: false, reason: 'panel title never rendered', cardText };
  if (!salaryMatch) {
    return { ok: false, reason: 'panel did not settle on the picked job (salary mismatch -> would risk applying to the wrong job)', panelTitle: stable, panelSalary, cardText };
  }

  const btn = document.querySelector(applySel);
  if (!btn) return { ok: false, reason: 'apply button not found: ' + applySel, panelTitle: stable, panelSalary };
  if (/继续沟通|已投递/.test(norm(btn.innerText))) {
    return { ok: false, reason: 'already applied (button reads: ' + norm(btn.innerText) + ')', panelTitle: stable, panelSalary };
  }

  btn.click();
  await sleep(1500);
  const modal = Array.from(document.querySelectorAll('h1,h2,h3,div,span'))
    .map((e) => norm(e.innerText))
    .find((t) => t && (t.includes('已向对方发送简历') || t.includes('投递成功'))) || '';

  return { ok: true, applied: stable, panelSalary, modal, applied_at: new Date().toISOString() };
})()`;

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export const name = "dsh-plugin-cdp";
export const inject = ["tools"];

export const Config = Schema.object({
  chromePath: Schema.string().default(""),
  userDataDir: Schema.string().default("D:\\dsh\\.browser-auto\\profile"),
  port: Schema.number().default(9222),
  windowSize: Schema.string().default("1500,950"),
  defaultTimeoutMs: Schema.number().default(120000),
  loadEventMs: Schema.number().default(8000),
  settleMs: Schema.number().default(600),
  /** 投递偏好落盘位置（弹窗询问的结果存这里）。 */
  prefsPath: Schema.string().default("D:\\dsh\\.cdp-prefs.json"),
  /** 运行器状态目录（规则快照、心跳、日志都在这里）。 */
  stateDir: Schema.string().default("D:\\dsh\\.cdp-runner"),
  /** 由偏好里的浏览器选项解析出的可执行文件路径；优先级高于 chromePath。 */
  chromePathOverride: Schema.string().default(""),
});

export function apply(ctx, config = {}) {
  const resolved = {
    chromePath: config.chromePath || "",
    userDataDir: config.userDataDir || "D:\\dsh\\.browser-auto\\profile",
    port: config.port ?? 9222,
    windowSize: config.windowSize || "1500,950",
    defaultTimeoutMs: config.defaultTimeoutMs ?? 120000,
    loadEventMs: config.loadEventMs ?? 8000,
    settleMs: config.settleMs ?? 600,
    prefsPath: config.prefsPath || DEFAULT_PREFS_PATH,
    stateDir: config.stateDir || "D:\\dsh\\.cdp-runner",
    chromePathOverride: config.chromePathOverride || "",
  };

  /* 用户偏好：由 cdp_prefs 工具在弹窗问答后落盘。 */
  let prefs = loadPrefs(resolved.prefsPath);
  const reloadPrefs = () => {
    prefs = loadPrefs(resolved.prefsPath);
    return prefs;
  };

  /** 偏好里选的浏览器 → 可执行文件路径。找不到就让 ChromeHost 回退默认探测。 */
  const browserExeFromPrefs = () => {
    if (resolved.chromePath) return "";
    for (const exe of browserCandidates(prefs.browser)) if (existsSync(exe)) return exe;
    return "";
  };

  /* 偏好里选的浏览器（Chrome/Edge）优先于默认探测：启动时就固定可执行文件路径，
     避免「用户选了 Edge 却启了 Chrome」。 */
  const host = new ChromeHost(resolved);
  const exeFromPrefs = browserExeFromPrefs();
  if (exeFromPrefs) host.chromePath = exeFromPrefs;

  const withPage = async (fn) => {
    await host.ensure();
    const { cdp, target } = await connect(host);
    try {
      return await fn(cdp, target);
    } finally {
      cdp.close();
    }
  };

  const register = (tool) => ctx.tools.register(defineTool(tool));

  /* ---------------- life cycle ---------------- */

  register({
    name: "cdp_status",
    description:
      "Report the managed Chrome instance for CDP automation: whether the debugging port is reachable, the profile directory, the number of open tabs, and which tab is currently driven. Use this first when CDP tools fail.",
    parameters: {},
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          alive: { type: "boolean", required: true },
          port: { type: "integer", required: true },
          userDataDir: { type: "string", required: true },
          chromePath: { type: "string", required: true },
          tabCount: { type: "integer", required: true },
          currentUrl: { type: "string", required: true },
          tabs: { type: "array", required: true, items: { type: "string" } },
        },
      },
    },
    async execute() {
      const alive = await host.alive();
      if (!alive) {
        return { alive, port: resolved.port, userDataDir: resolved.userDataDir, chromePath: host.chromePath, tabCount: 0, currentUrl: "", tabs: [] };
      }
      const list = await host.targets();
      const cur = await host.currentTarget();
      return {
        alive,
        port: resolved.port,
        userDataDir: resolved.userDataDir,
        chromePath: host.chromePath,
        tabCount: list.length,
        currentUrl: cur.url,
        tabs: list.map((t) => `${t.id} | ${t.url}`),
      };
    },
    presentCall: () => ({ card: "terminal", title: "cdp status", description: "Check the managed Chrome instance" }),
  });

  register({
    name: "cdp_navigate",
    description:
      "Launch the managed Chrome if needed, then navigate the driven tab to a URL and wait for load. This is the channel that works for job sites (Zhaopin, Liepin, Boss) where the extension channel fails.",
    parameters: {
      url: { type: "string", required: true, description: "Absolute http(s) URL." },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          startedChrome: { type: "boolean", required: true },
        },
      },
    },
    async execute(args) {
      const info = await host.ensure();
      return withPage(async (cdp) => {
        const loaded = cdp.waitEvent("Page.loadEventFired", host.loadEventMs).catch(() => null);
        await cdp.send("Page.navigate", { url: args.url });
        await loaded;
        await sleep(host.settleMs);
        const page = await evaluate(cdp, "({url: location.href, title: document.title})");
        return { url: page.url, title: page.title, startedChrome: !!info.started };
      });
    },
    presentCall: (args) => ({ card: "terminal", title: `cdp navigate ${args.url}`, description: "Navigate the managed Chrome" }),
  });

  register({
    name: "cdp_eval",
    description:
      "Evaluate JavaScript in the driven tab and return the value as JSON. Pass a function or an expression. This is how you read lists, click elements and inspect state on sites where selector-based tools are unreliable. Functions are auto-invoked.",
    parameters: {
      script: { type: "string", required: true, description: "JavaScript expression or function source." },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          result: { type: "json", required: true },
        },
      },
    },
    async execute(args) {
      return withPage(async (cdp) => {
        const value = await evaluate(cdp, asInvokedExpression(args.script));
        return { result: value === undefined ? null : value };
      });
    },
    presentCall: () => ({ card: "terminal", title: "cdp eval", description: "Evaluate JavaScript in the driven tab" }),
  });

  register({
    name: "cdp_read",
    description:
      "Read the driven tab: return its URL, title and visible text (optionally truncated). Use it to inspect a page without writing JavaScript.",
    parameters: {
      maxChars: { type: "integer", description: "Truncate the returned text (default 6000)." },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          text: { type: "string", required: true },
        },
      },
    },
    async execute(args) {
      const limit = args.maxChars ?? 6000;
      return withPage(async (cdp) => {
        const page = await evaluate(
          cdp,
          `({url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${limit})})`,
        );
        return page;
      });
    },
    presentCall: () => ({ card: "terminal", title: "cdp read", description: "Read the driven tab" }),
  });

  register({
    name: "cdp_screenshot",
    description: "Capture a PNG screenshot of the driven tab to a local file path and return that path.",
    parameters: {
      path: { type: "string", required: true, description: "Destination .png path." },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          bytes: { type: "integer", required: true },
        },
      },
    },
    async execute(args) {
      const out = resolve(args.path);
      return withPage(async (cdp) => {
        const res = await cdp.send("Page.captureScreenshot", { format: "png" });
        const buf = Buffer.from(res.data, "base64");
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, buf);
        return { path: out, bytes: buf.length };
      });
    },
    presentCall: (args) => ({ card: "terminal", title: `cdp screenshot ${args.path}`, description: "Screenshot the driven tab" }),
  });

  register({
    name: "cdp_new_tab",
    description: "Open a new tab in the managed Chrome and make it the driven tab.",
    parameters: {
      url: { type: "string", required: true, description: "URL to open." },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          targetId: { type: "string", required: true },
          url: { type: "string", required: true },
        },
      },
    },
    async execute(args) {
      await host.ensure();
      const t = await host.newTab(args.url);
      return { targetId: t.id, url: t.url };
    },
    presentCall: (args) => ({ card: "terminal", title: `cdp new tab ${args.url}`, description: "Open a new tab" }),
  });

  register({
    name: "cdp_use_tab",
    description: "Make an existing tab the driven tab, by target id (see cdp_status).",
    parameters: {
      targetId: { type: "string", required: true, description: "Target id from cdp_status." },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { targetId: { type: "string", required: true } },
      },
    },
    async execute(args) {
      host.pin(args.targetId);
      return { targetId: args.targetId };
    },
    presentCall: (args) => ({ card: "terminal", title: `cdp use tab ${args.targetId}`, description: "Switch the driven tab" }),
  });

  register({
    name: "cdp_apply_verified",
    description:
      "Apply to a job with verification, so a wrong-job application cannot happen silently. It clicks the target list card, waits until the detail panel title is stable AND the panel salary equals the card salary, refuses if the button already reads 继续沟通/已投递, then clicks apply and reports the confirmation dialog. Always verify the result afterwards on the site's own application record page (for Zhaopin: i.zhaopin.com/schedule) because a success dialog alone does not prove the application was recorded.",
    parameters: {
      cardSelector: { type: "string", required: true, description: "CSS selector for the job card in the results list." },
      titleSelector: { type: "string", required: true, description: "CSS selector for the detail panel's job title element." },
      applySelector: { type: "string", required: true, description: "CSS selector for the apply button." },
      salarySelector: { type: "string", required: true, description: "CSS selector for the detail panel's salary element." },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
          applied: { type: "string" },
          panelSalary: { type: "string" },
          modal: { type: "string" },
          cardText: { type: "string" },
        },
      },
    },
    async execute(args) {
      return withPage(async (cdp) => {
        const script = applyFlow({
          cardSelector: args.cardSelector,
          applySelector: args.applySelector,
          titleExpr: `() => { const e = document.querySelector(${JSON.stringify(args.titleSelector)}); return e ? e.innerText : ''; }`,
          salaryExpr: `() => { const e = document.querySelector(${JSON.stringify(args.salarySelector)}); return e ? e.innerText : ''; }`,
        });
        const value = await evaluate(cdp, script);
        return {
          ok: !!value.ok,
          reason: value.reason ?? "",
          applied: value.applied ?? "",
          panelSalary: value.panelSalary ?? "",
          modal: value.modal ?? "",
          cardText: value.cardText ?? "",
        };
      });
    },
    presentCall: (args) => ({
      card: "terminal",
      title: `cdp apply (verified) ${args.cardSelector}`,
      description: "Apply with title/salary verification",
    }),
  });

  /* ---------------- 投递偏好（弹窗询问） ---------------- */

  /**
   * 用户明确要求：不要做页面，用弹窗。所以偏好的收集走模型调用内置的
   * ask_user_question 工具，本插件只负责「告诉模型该问什么」和「存答案」。
   */
  register({
    name: "cdp_prefs",
    description:
      "投递偏好的读取/写入（岗位方向、工作地点、薪资下限、投递平台、浏览器）。三种用法：不传参数只读当前偏好并返回 required 缺失项与建议问卷；传 answers 把一次 ask_user_question 的返回合并落盘；传 reset 恢复默认。首次使用时如果 required 非空，必须调用内置的 ask_user_question 工具、把 suggestedQuestions 原样作为 questions 参数去问用户，拿到答案后再用 answers 传回本工具。",
    parameters: {
      answers: {
        type: "json",
        description: "ask_user_question 的返回对象 {answers:[{id,selected,custom}]}。传了就合并落盘。",
      },
      salaryCities: {
        type: "array",
        items: { type: "string" },
        description:
          "显式设定薪资下限的城市集合：不在此列表的城市，其薪资下限会被删除。不传则不动 salaryFloor。" +
          "用途：用户删掉某个目标城市后清掉它遗留的下限；也用于修正误写入的城市名。",
      },
      reset: { type: "boolean", description: "true 则恢复默认偏好（会丢掉已确认的配置）。" },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prefs: { type: "json", required: true },
          summary: { type: "string", required: true },
          required: { type: "array", required: true, items: { type: "string" } },
          needsAsk: { type: "boolean", required: true },
          suggestedQuestions: { type: "json", required: true },
          notes: { type: "array", required: true, items: { type: "string" } },
          prefsPath: { type: "string", required: true },
        },
      },
    },
    async execute(args) {
      const notes = [];
      if (args.reset) {
        prefs = savePrefs(defaultPrefs(), resolved.prefsPath);
        notes.push("已恢复默认偏好");
      }
      if (Array.isArray(args.salaryCities)) {
        // 显式限定城市集合：不在列表里的下限要删掉。
        // 需要这个参数的原因：salaryFloor 的合并语义是「给了哪些城市就覆盖哪些，
        // 没提到的保留」，所以像误写入的测试城市用正常问答清不掉 —— 没有"删城市"的入口。
        const current = reloadPrefs();
        const keep = new Set(args.salaryCities.map((c) => String(c).trim()).filter(Boolean));
        const nextFloor = {};
        for (const [city, floor] of Object.entries(current.salaryFloor || {})) {
          if (keep.has(city)) nextFloor[city] = floor;
        }
        prefs = savePrefs({ ...current, salaryFloor: nextFloor }, resolved.prefsPath);
        const removed = Object.keys(current.salaryFloor || {}).filter((c) => !keep.has(c));
        notes.push(
          removed.length
            ? `薪资下限城市集合已限定为 ${[...keep].join("、") || "（空）"}；已移除：${removed.join("、")}`
            : `薪资下限城市集合已限定为 ${[...keep].join("、") || "（空）"}`,
        );
      }
      if (args.answers) {
        const merged = mergeAnswers(reloadPrefs(), args.answers);
        prefs = savePrefs(merged.prefs, resolved.prefsPath);
        notes.push(...merged.notes);
      } else if (!args.reset) {
        reloadPrefs();
      }
      const required = missingRequired(prefs);
      return {
        prefs: {
          titles: prefs.titles,
          locations: prefs.locations,
          salaryFloor: prefs.salaryFloor,
          salaryCeil: prefs.salaryCeil,
          platforms: prefs.platforms,
          platformLabels: prefs.platforms.map((k) => PLATFORM_CHOICES.find((c) => c.key === k)?.label || k),
          browser: prefs.browser,
          browserLabel: BROWSER_CHOICES.find((c) => c.key === prefs.browser)?.label || "",
          /* 排除规则与自由说明必须一并返回 —— 否则用户设了排除规则却在返回值里
             看不到，无法确认自己填了什么，也无法核对是否生效。 */
          excludeNotes: prefs.excludeNotes,
          notes: prefs.notes,
          confirmBeforeApply: prefs.confirmBeforeApply,
          confirmedAt: prefs.confirmedAt,
        },
        summary: describePrefs(prefs),
        required,
        needsAsk: required.length > 0,
        suggestedQuestions: askUserQuestionPayload(prefs),
        notes,
        prefsPath: resolved.prefsPath,
      };
    },
    presentCall: () => ({ card: "terminal", title: "cdp prefs", description: "读取或写入投递偏好" }),
  });

  register({
    name: "cdp_browser_info",
    description:
      "如实报告本插件会使用的浏览器与平台信息：浏览器名称与可执行文件路径（是否真的存在于磁盘）、独立用户目录、调试端口、受控实例当前是否在运行、以及三个平台的登录态提示。用户问「使用的浏览器是什么软件」时用这个工具回答，不要凭空猜测。",
    parameters: {},
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          browserKey: { type: "string", required: true },
          browserLabel: { type: "string", required: true },
          exePath: { type: "string", required: true },
          exeExists: { type: "boolean", required: true },
          exeSource: { type: "string", required: true },
          userDataDir: { type: "string", required: true },
          port: { type: "integer", required: true },
          alive: { type: "boolean", required: true },
          platforms: { type: "array", required: true, items: { type: "string" } },
          note: { type: "string", required: true },
        },
      },
    },
    async execute() {
      reloadPrefs();
      const exeFromPref = browserCandidates(prefs.browser).find((p) => existsSync(p)) || "";
      const exePath = resolved.chromePath || exeFromPref || host.chromePath;
      const source = resolved.chromePath
        ? "插件配置 chromePath（最高优先级）"
        : exeFromPref
          ? `偏好里选的浏览器（${prefs.browser}）`
          : "自动探测到的默认 Chrome 路径";
      return {
        browserKey: prefs.browser || "(未设置)",
        browserLabel: BROWSER_CHOICES.find((c) => c.key === prefs.browser)?.label || "(未设置，请先用 cdp_prefs 询问用户)",
        exePath,
        exeExists: !!exePath && existsSync(exePath),
        exeSource: source,
        userDataDir: resolved.userDataDir,
        port: resolved.port,
        alive: await host.alive(),
        platforms: prefs.platforms.length
          ? prefs.platforms.map((k) => PLATFORM_CHOICES.find((c) => c.key === k)?.label || k)
          : ["(未设置，请先用 cdp_prefs 询问用户)"],
        note:
          "本插件用独立的用户目录启动一个受控浏览器实例，不复用你日常浏览器的配置，因此需要在该实例里单独登录一次三个平台。" +
          "首次使用时请先用 cdp_prefs 拿到问卷、调用 ask_user_question 问用户，再用 answers 存回。",
      };
    },
    presentCall: () => ({ card: "terminal", title: "cdp browser info", description: "报告使用的浏览器与平台" }),
  });

  /* ---------------- 岗位数据与文本报告 ---------------- */

  /**
   * 数据层与报告层由 lib/jobs.mjs、lib/report.mjs 提供。
   * ⚠️ 用动态 import 而不是顶层 import：这两个模块是后加的，若它们缺失或有语法
   *    错误，顶层 import 会让**整个插件加载失败**，把原本可用的 8 个 CDP 工具
   *    一起拖垮。动态导入把故障限制在报告工具内，并给出可操作的提示。
   */
  const loadData = async () => {
    try {
      const m = await import("./jobs.mjs");
      const payload = await m.extract({});
      return { payload };
    } catch (err) {
      return {
        error:
          `岗位数据模块不可用：${err?.message || err}。` +
          `需要 D:\\dsh\\dsh-plugin-cdp\\lib\\jobs.mjs 存在且可加载（node --test lib/jobs.test.mjs 能跑绿）。`,
      };
    }
  };

  register({
    name: "cdp_jobs_report",
    description:
      "把 D:\\dsh\\jw\\投递台账.md 与运行日志解析成结构化岗位数据，并渲染成纯文本可视化报告（薪资分布条形图、地点分布、平台占比、判定构成、投递火花线、岗位明细表）。这是给用户看「投了什么岗位、薪资多少、地点在哪」的主要工具。mode=brief 适合弹窗里一眼看完，mode=full 含明细表。",
    parameters: {
      mode: { type: "string", description: "brief（默认，紧凑概览）或 full（含明细表）。" },
      platform: { type: "string", description: "只看某个平台：zhaopin / boss / liepin。" },
      city: { type: "string", description: "只看某个城市（按数据里实际出现的城市名过滤）。" },
      decision: { type: "string", description: "只看某种判定：applied / pending / skipped / unknown。" },
      top: { type: "integer", description: "明细表最多显示多少行（默认 40）。" },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          mode: { type: "string", required: true },
          text: { type: "string", required: true },
          jobCount: { type: "integer", required: true },
          appliedCount: { type: "integer", required: true },
          warningCount: { type: "integer", required: true },
          error: { type: "string" },
        },
      },
    },
    async execute(args) {
      const mode = args.mode === "full" ? "full" : "brief";
      const { payload, error } = await loadData();
      if (error) {
        return { ok: false, mode, text: `❌ ${error}`, jobCount: 0, appliedCount: 0, warningCount: 0, error };
      }
      /* ⚠️ applied 数组承载全部日志事件（含 miss / nav_timeout），统计投递数必须
         过滤 kind === "applied"。
         缺 kind 的事件**不计入投递数**：契约规定失败事件必须带 kind，所以缺 kind
         意味着数据不完整，把"不知道"当成"投递成功"是危险方向（会虚报战果）。
         这一点与 lib/report.mjs 的口径强制保持一致，避免同一份数据两处算出不同数字。 */
      const appliedEvents = payload.applied.filter((e) => e.kind === "applied");
      const unknownKind = payload.applied.length - payload.applied.filter((e) => !!e.kind).length;
      const opts = { platform: args.platform, city: args.city, decision: args.decision, top: args.top };
      let text;
      let jobCount = payload.jobs.length;
      // 平台筛选与报告内部口径一致（报告只按 platform 过滤事件，不按 city/decision）
      let appliedCount = appliedEvents.filter((e) => !args.platform || e.platform === args.platform).length;
      try {
        const r = await import("./report.mjs");
        const render = mode === "full" ? r.renderFull : r.renderBrief;
        if (typeof render !== "function") throw new Error(`report.mjs 没有导出 ${mode === "full" ? "renderFull" : "renderBrief"}`);
        text = render(payload, opts);
        /* 复用报告内部的筛选，保证返回值与报告头部显示的是同一个数字。
           曾出现：筛选后报告写「岗位 7」而 jobCount 返回 81，调用方会被误导。 */
        if (typeof r.normalizePayload === "function" && typeof r.filterJobs === "function") {
          jobCount = r.filterJobs(r.normalizePayload(payload).jobs, r.normalizeOpts(opts)).length;
        }
      } catch (err) {
        // 报告层挂了不等于数据层挂了：降级成计数摘要，绝不静默失败。
        text =
          `⚠️ 文本报告模块不可用（${err?.message || err}），已降级为计数摘要：\n` +
          `  岗位总数：${payload.jobs.length}\n` +
          `  投递事件：${appliedEvents.length}（日志事件合计 ${payload.applied.length}）\n` +
          `  解析告警：${payload.warnings.length}\n` +
          `  平台分布：${JSON.stringify(countBy(payload.jobs, (j) => j.platform))}\n` +
          `  判定构成：${JSON.stringify(countBy(payload.jobs, (j) => j.decision))}\n` +
          `如需完整文本报告，请确认 lib\\report.mjs 存在且可加载。`;
      }
      return {
        ok: true,
        mode,
        text,
        // 注意：必须返回上面算好的变量，不要在这里重算 payload.jobs.length。
        // 踩过的坑：计算逻辑写对了但 return 仍用原始表达式，导致筛选后
        // 报告头部「岗位 7」而返回值 81 —— 变量算了却没用上。
        jobCount,
        appliedCount,
        warningCount: payload.warnings.length,
      };
    },
    presentCall: (args) => ({
      card: "terminal",
      title: `cdp jobs report (${args.mode || "brief"})`,
      description: "岗位/薪资/地点文本报告",
    }),
  });

  register({
    name: "cdp_jobs_data",
    description:
      "返回岗位数据的原始 JSON（符合 lib/contract.mjs 的 DashboardPayload），供需要自己加工的场景使用。一般用 cdp_jobs_report 看报告即可。",
    parameters: {},
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          payload: { type: "json" },
          error: { type: "string" },
        },
      },
    },
    async execute() {
      const { payload, error } = await loadData();
      if (error) return { ok: false, payload: null, error };
      return { ok: true, payload };
    },
    presentCall: () => ({ card: "terminal", title: "cdp jobs data", description: "岗位原始 JSON" }),
  });

  /* ---------------- 运行器热替换窗口 ---------------- */
  /*
   * 用户要求：「要留一个窗口支持用户随时进行修改，如果用户进行修改在原进程的
   * 基础上进行复制另开一个进程并逐步替换原进程」
   *
   * 三个工具构成这个「窗口」：
   *   cdp_runner_status  看当前哪一代在跑、规则是否已生效
   *   cdp_runner_reload  把当前规则同步到运行器；规则变了就热替换（先起新的再退旧的）
   *   cdp_runner_stop    停下来（不自动重启）
   *
   * 注意本插件**不携带任何投递规则**：runner.command 由用户自己指定，
   * 规则原样透传（快照 + CDP_RULES 环境变量），插件不解释其含义。
   */

  const runnerStateDir = resolved.stateDir;
  const supervisor = new Supervisor({ prefsPath: resolved.prefsPath, stateDir: runnerStateDir });

  register({
    name: "cdp_runner_status",
    description:
      "报告投递运行器的当前状态：哪一代在跑、pid、轮次、是否配置了用户自己的执行命令、以及「用户改了规则但还没生效」的提示。用户问「现在跑到哪一代了 / 我的修改生效了吗」时用它回答。",
    parameters: {},
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          running: { type: "boolean", required: true },
          generation: { type: "integer", required: true },
          pid: { type: "integer", required: true },
          state: { type: "string", required: true },
          cycles: { type: "integer", required: true },
          runnerConfigured: { type: "boolean", required: true },
          rulesChangedSinceStart: { type: "boolean", required: true },
          currentRulesFingerprint: { type: "string", required: true },
          snapshotFingerprint: { type: "string", required: true },
          /* 以下三个字段是 supervisor.status() 会返回、而初版 schema 漏声明的。
             漏声明的后果很隐蔽：execute() 本身不抛错，本地自检也过，
             只有在真实 DSH 里调用时才会被**输出校验**拒绝：
               tool "cdp_runner_status" returned invalid output:
               "value.uptimeMs" is not a declared property (additionalProperties: false)
             所以 output.schema 必须与 execute() 的返回对象逐一对应，
             不能只写"主要字段"。 */
          uptimeMs: { type: "integer", required: true },
          snapshotGeneration: { type: "integer", required: true },
          workerAliveHint: { type: "boolean", required: true },
          stateDir: { type: "string", required: true },
          logPath: { type: "string", required: true },
          detail: { type: "string", required: true },
        },
      },
    },
    async execute() {
      const s = supervisor.status();
      const detail = !s.running
        ? "运行器未启动。调用 cdp_runner_reload 可以启动。"
        : s.rulesChangedSinceStart
          ? "⚠️ 规则已修改但尚未生效，调用 cdp_runner_reload 进行热替换。"
          : `运行中（第 ${s.generation} 代，已跑 ${s.cycles} 轮）。` +
            (s.runnerConfigured ? "" : " 当前未配置用户执行命令，处于心跳模式——链路是通的，但还没有真正的投递动作。");
      return { ...s, detail };
    },
    presentCall: () => ({ card: "terminal", title: "cdp runner status", description: "运行器状态" }),
  });

  register({
    name: "cdp_runner_reload",
    description:
      "把当前规则同步到投递运行器，并在规则变化时做热替换：先启动新一代进程并等它就绪，确认活着之后才让老一代退位，因此不会出现「没有任何进程在跑」的断档。两代共享 append-only 的完成记录，重叠期不会重复投递。新一代若在就绪窗口内起不来，会保留老一代继续运行而不是停掉投递。用户改完规则后调用这个工具让修改生效。",
    parameters: {
      runnerCommand: { type: "string", description: "用户自己的执行命令（可执行文件路径）。不传则沿用快照里已有的配置。" },
      runnerArgs: { type: "array", items: { type: "string" }, description: "命令参数列表。" },
      runnerCwd: { type: "string", description: "命令的工作目录。" },
      runnerTimeoutMs: { type: "integer", description: "单次命令超时（毫秒，默认 120000）。" },
      intervalMs: { type: "integer", description: "轮询间隔（毫秒，默认 10000）。" },
      force: { type: "boolean", description: "true 则即使规则没变也强制滚动一代（用于手动重启）。" },
    },
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true },
          generation: { type: "integer", required: true },
          pid: { type: "integer", required: true },
          ready: { type: "boolean", required: true },
          retiredGeneration: { type: "integer" },
          retiredPid: { type: "integer" },
          fingerprint: { type: "string", required: true },
          detail: { type: "string", required: true },
        },
      },
    },
    async execute(args) {
      const prev = supervisor.readSnapshot();
      const runner =
        args.runnerCommand !== undefined
          ? {
              command: args.runnerCommand,
              args: args.runnerArgs || [],
              cwd: args.runnerCwd || "",
              timeoutMs: args.runnerTimeoutMs || 120000,
            }
          : prev?.runner || null;
      const result = await supervisor.reconcile({
        runner,
        intervalMs: args.intervalMs || prev?.intervalMs || 10000,
        force: !!args.force,
      });
      /* ⚠️ 可选字段宁可不放，也不要用 undefined 占位。
         踩过的坑（2026-10-13，真实 DSH 报错 `value is not lossless JSON`）：
         reconcile() 在 started/unchanged 时没有 retiredGeneration / retiredPid，
         写成 `retiredGeneration: undefined` 会让 JSON 序列化直接失败 ——
         因为 undefined 不是合法 JSON 值。本自检此前只在本机跑 execute()，
         没有经过序列化，所以完全没暴露。 */
      const out = {
        action: result.action,
        generation: result.generation ?? 0,
        pid: result.pid ?? 0,
        ready: !!result.ready,
        fingerprint: result.fingerprint || "",
        detail: result.detail || "",
      };
      if (typeof result.retiredGeneration === "number") out.retiredGeneration = result.retiredGeneration;
      if (typeof result.retiredPid === "number") out.retiredPid = result.retiredPid;
      return out;
    },
    presentCall: () => ({ card: "terminal", title: "cdp runner reload", description: "同步规则并热替换运行器" }),
  });

  register({
    name: "cdp_runner_stop",
    description: "停止投递运行器（不会自动重启）。之后改规则再调用 cdp_runner_reload 可重新启动。",
    parameters: {},
    output: { render: renderJson,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          stopped: { type: "boolean", required: true },
          pid: { type: "integer" },
          generation: { type: "integer" },
          detail: { type: "string", required: true },
        },
      },
    },
    async execute() {
      const r = supervisor.stop();
      return {
        stopped: !!r.stopped,
        pid: r.pid ?? 0,
        generation: r.generation ?? 0,
        detail: r.detail || (r.stopped ? "已停止" : "没有正在运行的运行器"),
      };
    },
    presentCall: () => ({ card: "terminal", title: "cdp runner stop", description: "停止运行器" }),
  });
}
