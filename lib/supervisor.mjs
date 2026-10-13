/**
 * dsh-plugin-cdp — 投递运行器的进程管理器（rule-free supervisor）
 *
 * 用户要求：「要留一个窗口支持用户随时进行修改，如果用户进行修改在原进程的
 * 基础上进行复制另开一个进程并逐步替换原进程」
 *
 * 本模块实现这个「窗口」与替换机制，且**不携带任何投递规则**：
 *   - 规则由用户写进快照文件（rules.json），插件只负责存取与分发；
 *   - 插件不知道规则的含义，也不预设任何岗位/城市/薪资/平台。
 *
 * ════════════════ 替换机制（为什么这样设计）════════════════
 *
 * 旧方案的问题：如果想「原地重启」，就必须先杀掉老进程 —— 于是总有一段
 * 完全没有进程在跑的真空期，用户的投递会断档。
 *
 * 本方案的顺序是**先起新的，再退旧的**（scale-out 而非 restart）：
 *
 *   1. 用户改规则 → 写新快照，指纹变化
 *   2. 起新一代（gen N+1），它与老一代**并存**
 *   3. 等新一代写出心跳（证明它真的活着），再让老一代退出
 *   4. 老一代退出后，新一代成为唯一在跑的进程
 *
 * 「逐步替换」的关键前提是**状态不冲突**：两代共享同一份 append-only 的
 * done.ndjson / events.ndjson（见 worker.mjs）。重叠期内：
 *   - 已完成的事两边都读得到 → 不会重复做（幂等）
 *   - 新增的完成记录只是追加 → 不会互相覆盖
 * 所以重叠不仅安全，反而是「不断档」的实现手段。
 *
 * 反过来，如果状态是可覆盖的（比如整份 JSON 反复重写），重叠期就会互相
 * 丢更新，那时「先起后杀」反而不安全。这一点是本设计成立的前提，改动
 * worker 的状态落盘方式时必须一起考虑。
 *
 * 失败回滚：如果新一代在就绪窗口内没写出心跳，视为启动失败，把老一代
 * **保留**下来（不让它退位），并把状态标记为 failed。宁可保留旧规则继续
 * 跑，也不要在新规则起不来时把投递彻底停掉。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrefs, rulesFingerprint } from "./prefs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "worker.mjs");

/** 新一代必须在这么长时间内写出心跳，否则视为启动失败。 */
const READY_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  // 直接同步写入。（早期版本先写 .tmp 再删原文件重写，那**不是**原子替换 ——
  // 删掉之后崩溃就会丢状态。这些文件都很小且只在本地读，同步覆盖已足够。）
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
};

/** 进程是否还活着。 */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 结束一个进程及其子进程树。
 *
 * ⚠️ 不能只看 taskkill 的退出码来判断成败。实测（2026-10-13）出现：
 *   worker 自己也检测到规则变更并优雅退出，与我发出的 taskkill 撞在一起，
 *   taskkill 返回 128，但进程其实**已经退出了**。
 * 所以判定标准是「发完之后进程还在不在」，而不是命令的退出码 ——
 * 否则会在详情里报出假失败，误导使用者以为老进程没被换掉。
 */
function killTree(pid) {
  if (!pid) return { ok: false, reason: "no pid" };
  if (!isAlive(pid)) return { ok: true, code: 0, note: "进程本已退出" };
  let code = null;
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    code = r.status ?? -1;
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  // 给进程一点退出时间再复核（killTree 是同步函数，用 Atomics.wait 做同步小睡）
  const deadline = Date.now() + 3000;
  const sab = new SharedArrayBuffer(4);
  while (Date.now() < deadline && isAlive(pid)) {
    Atomics.wait(new Int32Array(sab), 0, 0, 120);
  }
  const stillAlive = isAlive(pid);
  return {
    ok: !stillAlive,
    code,
    note: stillAlive ? "仍在运行" : code === 0 ? "已结束" : `已结束（命令退出码 ${code}，属正常竞态）`,
  };
}

export class Supervisor {
  /**
   * @param {object} opts
   * @param {string} opts.prefsPath   偏好（规则）文件
   * @param {string} opts.stateDir    运行状态目录（快照、日志、心跳都在这）
   */
  constructor({ prefsPath, stateDir }) {
    this.prefsPath = prefsPath;
    this.stateDir = resolve(stateDir);
    this.snapshotPath = join(this.stateDir, "rules.json");
    this.logPath = join(this.stateDir, "worker.log");
    /** 内存里的当前代次；以磁盘上的按代次状态文件为准做对账 */
    this.current = null;
  }

  /* ---------------- 快照 ---------------- */

  /**
   * 把当前规则写成一个不可变快照，返回指纹。
   * 快照里**只放规则与运行参数**，不含插件对规则的任何解释。
   *
   * ⚠️ 必须**保留**已有的 generation 字段。
   *   踩过的坑（2026-10-13，真实 DSH 里发现 generation=4 而 snapshotGeneration=0）：
   *   reconcile() 每次都先调用本方法重写快照，而本方法原先不写 generation；
   *   虽然 reconcile 随后用 `{...snap, generation: gen}` 补过一次，但那只在
   *   「需要换代」的分支执行 —— 所以第一次 reload 有 generation，
   *   **第二次 reload（规则没变）就会把它抹掉且不再补回**。
   *   后果不只是显示错：currentStatus() 依赖快照的 generation 去找状态文件，
   *   丢了就退化成「取磁盘上最大代次」，正是本文件反复强调要避免的那类错配。
   */
  writeSnapshot({ rules, intervalMs, runner }) {
    const prefs = rules || loadPrefs(this.prefsPath);
    const fingerprint = rulesFingerprint(prefs);
    const previous = readJson(this.snapshotPath);
    const snapshot = {
      schemaVersion: 1,
      fingerprint,
      ...(previous?.generation ? { generation: previous.generation } : {}),
      writtenAt: new Date().toISOString(),
      intervalMs: Number(intervalMs) || 10000,
      /**
       * rules 是用户规则的原样透传。插件不理解其内容，只保证：
       *   - 它被完整写进快照
       *   - 它被完整注入到 runner 的 CDP_RULES 环境变量里
       */
      rules: {
        titles: prefs.titles || [],
        locations: prefs.locations || [],
        salaryFloor: prefs.salaryFloor || {},
        salaryCeil: prefs.salaryCeil ?? null,
        platforms: prefs.platforms || [],
        browser: prefs.browser || "",
        excludeNotes: prefs.excludeNotes || [],
        notes: prefs.notes || "",
      },
      /** 用户自定义的执行命令；未配置则 worker 以心跳模式运行 */
      runner: runner || null,
    };
    writeJson(this.snapshotPath, snapshot);
    return fingerprint;
  }

  readSnapshot() {
    return readJson(this.snapshotPath);
  }

  /* ---------------- 代次 ---------------- */

  nextGeneration() {
    const snap = this.readSnapshot();
    const cur = Number(snap?.generation || 0);
    const newest = this.newestStatus();
    const fromStatus = Number(newest?.generation || 0);
    const fromDisk = this.generationsOnDisk();
    return Math.max(cur, fromStatus, fromDisk) + 1;
  }

  generationsOnDisk() {
    if (!existsSync(this.stateDir)) return 0;
    return readdirSync(this.stateDir)
      .map((f) => /^status\.gen(\d+)\.json$/.exec(f))
      .filter(Boolean)
      .reduce((max, m) => Math.max(max, Number(m[1])), 0);
  }

  /**
   * 派生一个 detached 的 worker 进程。
   *
   * 代次在这里统一写入快照 —— 不要把这个动作散落到各个调用点。
   * 理由：worker 一启动就会去读快照，而 currentStatus() 也靠快照找状态文件；
   * 任何一条「起了 worker 却忘了写 generation」的路径都会造成代次错配。
   * 放在这里，起进程与记代次就是同一个原子动作。
   */
  spawnWorker(generation, { intervalMs }) {
    mkdirSync(this.stateDir, { recursive: true });
    const snap = this.readSnapshot() || {};
    writeJson(this.snapshotPath, { ...snap, generation });
    const child = spawn(
      process.execPath,
      [
        WORKER,
        "--generation",
        String(generation),
        "--snapshot",
        this.snapshotPath,
        "--state-dir",
        this.stateDir,
        "--log",
        this.logPath,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, CDP_RULES: JSON.stringify(snap.rules || {}) },
      },
    );
    child.unref();
    this.current = { generation, pid: child.pid, intervalMs, startedAt: Date.now() };
    return this.current;
  }

  /** 等待某一代写出心跳（该代自己的状态文件里 generation 匹配且已跑过至少一轮）。 */
  async waitReady(generation, timeoutMs = READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = readJson(join(this.stateDir, `status.gen${generation}.json`));
      if (status && Number(status.generation) === generation && status.state === "running" && status.cycles >= 1) {
        return { ready: true, status };
      }
      await sleep(250);
    }
    return { ready: false, status: readJson(join(this.stateDir, `status.gen${generation}.json`)) };
  }

  /**
   * 读「当前代」的状态。
   *
   * ⚠️ 必须按**快照里的代次**去读对应文件，而不是读一个共享的 status.json。
   *    原因见 worker.mjs 的 writeStatus 注释：两代并写同一个文件会互相覆盖，
   *    导致热替换后报告「老一代已停止」（假的）。
   */
  currentStatus() {
    const snap = this.readSnapshot();
    // 1) 快照指定的代次是权威
    if (snap?.generation) {
      const s = readJson(join(this.stateDir, `status.gen${snap.generation}.json`));
      if (s) return s;
    }
    // 2) 回退：取代次最大的那个状态文件
    const gen = this.generationsOnDisk();
    if (gen) return readJson(join(this.stateDir, `status.gen${gen}.json`));
    return null;
  }

  /** 找到所有代次里「最后心跳」的那一代（用于对账） */
  newestStatus() {
    if (!existsSync(this.stateDir)) return null;
    const gens = readdirSync(this.stateDir)
      .map((f) => /^status\.gen(\d+)\.json$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
    for (const g of gens) {
      const s = readJson(join(this.stateDir, `status.gen${g}.json`));
      if (s && s.state === "running" && isAlive(s.pid)) return s;
    }
    return gens.length ? readJson(join(this.stateDir, `status.gen${gens[0]}.json`)) : null;
  }

  /* ---------------- 热替换主流程 ---------------- */

  /**
   * 检查规则是否变了；变了就「起新一代 → 等就绪 → 退老一代」。
   *
   * @param {object} opts.runner      用户自定义执行命令
   * @param {number} opts.intervalMs  轮询间隔
   * @param {boolean} opts.force      即使指纹没变也强制换代（用于「我说了算」的手动滚动）
   * @returns {Promise<object>} 动作结果，供工具层如实汇报
   */
  async reconcile({ runner, intervalMs = 10000, force = false } = {}) {
    const prefs = loadPrefs(this.prefsPath);
    const fingerprint = this.writeSnapshot({ rules: prefs, intervalMs, runner });
    const status = this.currentStatus();
    const prevFp = status?.fingerprint || "";
    const prevGen = Number(status?.generation || 0);

    // 没有在跑 → 直接起第一代
    // ⚠️ 这里的判断依据必须是「进程有没有在跑」，不能只看指纹。
    //    踩过的坑：stop() 之后用户又改了规则，若写成「指纹相同就 unchanged」，
    //    会把「已停止」误判成「在运行」，用户改了规则也永远起不来。
    const actuallyRunning = !!status && status.state === "running" && isAlive(status.pid);
    if (!actuallyRunning) {
      const gen = this.nextGeneration();
      const snap = this.readSnapshot();
      writeJson(this.snapshotPath, { ...snap, generation: gen });
      const started = this.spawnWorker(gen, { intervalMs });
      const ready = await this.waitReady(gen);
      return {
        action: "started",
        generation: gen,
        pid: started.pid,
        fingerprint,
        ready: ready.ready,
        detail: ready.ready
          ? `第一代运行器已启动并就绪${status && !isAlive(status.pid) ? "（检测到此前无存活运行器）" : ""}`
          : `已启动但 ${READY_TIMEOUT_MS}ms 内未见心跳，请查看 worker.log`,
      };
    }

    // 指纹没变 → 什么都不做
    if (prevFp === fingerprint && !force) {
      return {
        action: "unchanged",
        generation: prevGen,
        pid: status.pid,
        fingerprint,
        ready: true,
        detail: "规则未变化，沿用当前运行器",
      };
    }

    /* ↓↓↓ 真正的热替换：先起新的，确认活了，再退旧的 ↓↓↓ */
    const gen = Math.max(prevGen, this.generationsOnDisk()) + 1;
    const snap = this.readSnapshot();
    writeJson(this.snapshotPath, { ...snap, generation: gen });

    const started = this.spawnWorker(gen, { intervalMs });
    const ready = await this.waitReady(gen);

    if (!ready.ready) {
      // 新一代起不来 → 保留老一代，绝不让投递断档
      return {
        action: "failed_kept_old",
        generation: prevGen,
        pid: status.pid,
        attemptedGeneration: gen,
        attemptedPid: started.pid,
        fingerprint,
        ready: false,
        detail:
          `新一代（gen${gen}）在 ${READY_TIMEOUT_MS}ms 内未就绪，已保留老一代 gen${prevGen} 继续运行。` +
          `请查看 ${this.logPath}`,
      };
    }

    // 新一代确认就绪 → 让老一代退位
    const killed = killTree(status.pid);
    return {
      action: force ? "rolled" : "hot_swapped",
      generation: gen,
      pid: started.pid,
      retiredGeneration: prevGen,
      retiredPid: status.pid,
      retiredOk: killed.ok,
      fingerprint,
      fromFingerprint: prevFp,
      ready: true,
      detail:
        `已启用 gen${gen}（pid ${started.pid}）并让 gen${prevGen}（pid ${status.pid}）退位。` +
        `两代共享 append-only 的 done/events 记录，重叠期不会重复投递。` +
        (killed.ok ? "" : ` 注意：老进程结束返回异常 ${JSON.stringify(killed)}。`),
    };
  }

  /** 让当前运行器退出（不自动重启）。 */
  stop() {
    const status = this.currentStatus();
    if (!status?.pid) return { action: "stop", stopped: false, detail: "没有正在运行的运行器" };
    if (!isAlive(status.pid)) {
      return { action: "stop", stopped: true, pid: status.pid, generation: status.generation, detail: "运行器本已停止" };
    }
    const killed = killTree(status.pid);
    // 把该代的状态文件标成 stopped（只改这一代自己的文件，不动别人的）
    const genPath = join(this.stateDir, `status.gen${status.generation}.json`);
    const cur = readJson(genPath) || status;
    writeJson(genPath, { ...cur, state: "stopped", note: "supervisor stop" });
    return {
      action: "stop",
      stopped: killed.ok,
      pid: status.pid,
      generation: status.generation,
      detail: killed.ok ? `第 ${status.generation} 代已停止` : JSON.stringify(killed),
    };
  }

  /** 如实报告运行状态。 */
  status() {
    const status = this.currentStatus();
    const snap = this.readSnapshot();
    const prefs = loadPrefs(this.prefsPath);
    const fingerprint = rulesFingerprint(prefs);
    const alive = !!status && isAlive(status.pid);
    return {
      // 「在跑」= 该代状态为 running **且进程真的还活着**。
      // 只信状态文件会导致进程被杀后仍报 running（status 是最后一次心跳的快照）。
      running: !!status && status.state === "running" && alive,
      generation: status?.generation ?? 0,
      pid: status?.pid ?? 0,
      state: !status ? "(未启动)" : status.state === "running" && !alive ? "已退出（无存活进程）" : status.state,
      cycles: status?.cycles ?? 0,
      uptimeMs: status?.uptimeMs ?? 0,
      runnerConfigured: !!snap?.runner?.command,
      snapshotFingerprint: snap?.fingerprint || "",
      currentRulesFingerprint: fingerprint,
      /** true 表示用户改了规则但运行器还没换 —— 这就是「待生效」 */
      rulesChangedSinceStart: !!snap?.fingerprint && snap.fingerprint !== fingerprint,
      snapshotGeneration: snap?.generation ?? 0,
      stateDir: this.stateDir,
      logPath: this.logPath,
      workerAliveHint: alive,
    };
  }
}
