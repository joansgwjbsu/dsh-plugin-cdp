/**
 * dsh-plugin-cdp — 投递运行器（rule-free worker）
 *
 * 用户 2026-10-13 要求：
 *   「要留一个窗口支持用户随时进行修改，如果用户进行修改在原进程的基础上
 *     进行复制另开一个进程并逐步替换原进程」
 *   「插件本身不要携带我给你投递规则，其他用户需要自己设定规则，
 *     你只需要给插件一个能跑通的能力」
 *
 * 所以这个 worker 是**纯能力**：
 *   - 它不认识任何岗位、城市、薪资、平台规则；
 *   - 规则是它启动时读到的一份**快照**（rules.json），谁写的、写了什么它不关心；
 *   - 它只做四件事：读快照 → 按间隔调用用户给的命令 → 写心跳/状态 → 快照变了自己退位。
 *
 * 状态交接靠两个 **append-only** 文件，天然允许多代进程并存而不互相踩：
 *   - state\done.ndjson   已处理的键（各代只追加，不重写）
 *   - state\events.ndjson 事件流水（各代只追加）
 * 这正是「逐步替换」能安全进行的原因：新一代不需要等老一代退出才能开始工作，
 * 两者共享同一份完成记录，重叠期最多导致同一件事被两边都跳过（幂等），
 * 而不是互相覆盖状态。
 *
 * 用法（由 lib/supervisor.mjs 派生，一般不手工调用）：
 *   node lib/worker.mjs --generation 2 --snapshot <path> --state-dir <dir> --log <path>
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const generation = Number(args.generation ?? 0);
const snapshotPath = args.snapshot ? resolve(args.snapshot) : "";
const stateDir = resolve(args["state-dir"] || ".");
const logPath = args.log ? resolve(args.log) : "";
const scope = args.scope || "default";

/* ---------------- 日志与事件 ---------------- */

function appendLine(file, text) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // 显式 UTF-8 无 BOM：PowerShell 的 Add-Content -Encoding UTF8 会写出 BOM，
    // 与其他脚本读回时产生乱码，这里统一用 Node 的 utf8 追加。
    appendFileSync(file, `${text}\n`, "utf8");
  } catch {
    /* 日志写失败不应让 worker 崩掉 */
  }
}

const log = (msg) => {
  const line = `[${new Date().toISOString()}] [gen${generation}] ${msg}`;
  if (logPath) appendLine(logPath, line);
  else process.stdout.write(`${line}\n`);
};

const emit = (event) => {
  appendLine(resolve(stateDir, "events.ndjson"), JSON.stringify({ ...event, generation, at: new Date().toISOString() }));
};

/* ---------------- 快照 ---------------- */

function readSnapshot() {
  if (!snapshotPath || !existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    return null;
  }
}

/* ---------------- 状态：append-only，多代并存安全 ---------------- */

const donePath = resolve(stateDir, "done.ndjson");

/** 读取已处理键集合。文件损坏的行跳过而不抛错 —— 宁可重做一次也不整体卡死。 */
function loadDone() {
  const set = new Set();
  if (!existsSync(donePath)) return set;
  for (const line of readFileSync(donePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && row.key) set.add(String(row.key));
    } catch {
      /* 跳过坏行 */
    }
  }
  return set;
}

const markDone = (key, extra = {}) =>
  appendLine(donePath, JSON.stringify({ key: String(key), generation, at: new Date().toISOString(), ...extra }));

/* ---------------- 命令执行 ---------------- */

async function runCommand(ctx) {
  // 用户的命令由快照里的 runner 指定；插件不预设任何命令。
  // 没有配置 runner 时进入「心跳模式」：只证明运行器活着、能看到规则，
  // 这样用户可以先确认链路通了，再逐步把自己的脚本接进来。
  const runner = ctx.snapshot?.runner;
  if (!runner || !runner.command) return { mode: "heartbeat" };

  const { spawn } = await import("node:child_process");
  return await new Promise((res) => {
    const child = spawn(runner.command, runner.args || [], {
      cwd: runner.cwd || process.cwd(),
      env: { ...process.env, ...(runner.env || {}), CDP_RULES: JSON.stringify(ctx.rules || {}) },
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, runner.timeoutMs || 120000);
    if (typeof timer.unref === "function") timer.unref();
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      res({ mode: "command", code: code ?? -1, signal: signal || "" });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      res({ mode: "command", code: -1, error: String(err?.message || err) });
    });
  });
}

/* ---------------- 主循环 ---------------- */

const startedAt = Date.now();
let cycles = 0;
let snapshot = readSnapshot();
let fingerprint = snapshot?.fingerprint || "";
let intervalMs = Number(snapshot?.intervalMs) || 10000;
let lastResult = null;

log(`启动（scope=${scope}）快照=${snapshotPath || "(未提供)"} 指纹=${fingerprint || "(无)"}`);

if (!snapshot) {
  log("⚠️ 读不到规则快照，worker 以心跳模式运行；请先用 cdp_rules 写入规则");
} else {
  log(`规则快照已载入：指纹=${fingerprint} 间隔=${intervalMs}ms runner=${snapshot?.runner?.command || "(未配置，心跳模式)"}`);
}

let stopping = false;
const stop = (reason) => {
  if (stopping) return;
  stopping = true;
  log(`收到退出请求（${reason}），正在收尾`);
  writeStatus("stopped", reason);
  process.exit(0);
};

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

function writeStatus(state = "running", note = "") {
  const status = {
    generation,
    scope,
    state,
    note,
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
    cycles,
    fingerprint,
    intervalMs,
    lastResult,
    runnerConfigured: !!snapshot?.runner?.command,
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    // ⚠️ 只写**自己这一代**的状态文件，绝不写共享的 status.json。
    //    踩过的坑（2026-10-13）：两代进程都写 status.json，老一代退出前的
    //    最后一次写入会盖掉新一代的心跳，于是 supervisor 看到「gen1 已停止」
    //    而实际上 gen2 正在跑 —— 恰好是热替换最需要看清的时刻报错。
    //    每代写自己的文件，由 supervisor 按快照代次去读，就不存在这个竞争。
    writeFileSync(resolve(stateDir, `status.gen${generation}.json`), JSON.stringify(status, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeStatus();
emit({ kind: "worker_start", scope, fingerprint, intervalMs });

// eslint-disable-next-line no-constant-condition
while (true) {
  if (stopping) break;

  // 1) 快照变更检测 —— 这就是「用户随时改规则」的窗口。
  //    注意：worker 自己**不**做替换，只报告退休；替换由 supervisor 负责，
  //    因为「起新进程」是需要外部视角的动作。
  const fresh = readSnapshot();
  const freshFp = fresh?.fingerprint || "";
  if (freshFp && freshFp !== fingerprint) {
    log(`检测到规则变更：${fingerprint} → ${freshFp} 本代退休，交由 supervisor 启用新一代`);
    emit({ kind: "worker_retire", reason: "rules_changed", from: fingerprint, to: freshFp });
    snapshot = fresh;
    fingerprint = freshFp;
    intervalMs = Number(fresh?.intervalMs) || intervalMs;
    writeStatus("retiring", "rules_changed");
    process.exit(0);
  }

  // 2) 干一轮活
  cycles += 1;
  const ctx = { snapshot: fresh || snapshot, rules: (fresh || snapshot)?.rules || {} };
  let result;
  try {
    result = await runCommand(ctx);
  } catch (err) {
    result = { mode: "error", error: String(err?.message || err) };
  }
  lastResult = { cycle: cycles, ...result, at: new Date().toISOString() };
  emit({ kind: "cycle", cycle: cycles, result });

  const done = loadDone();
  if (done.size) lastResult.doneCount = done.size;

  if (cycles % 5 === 1) log(`第 ${cycles} 轮完成：${JSON.stringify(result)}`);
  writeStatus();

  await sleep(intervalMs);
}
