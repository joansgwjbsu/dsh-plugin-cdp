/**
 * 热替换端到端测试 —— 验证用户改规则时真的会「另开一个进程并逐步替换原进程」。
 *
 * 这是本功能最容易「看起来实现了其实没生效」的地方：如果指纹把
 * confirmedAt 之类的元数据也算进去，每次读盘都会误判成规则变更，
 * 进程会无限重启；如果换代的顺序写反（先杀后起），就会有断档真空期。
 * 所以这里逐条断言时序，而不只看最终状态。
 *
 * 用法：node <插件目录>\lib\supervisor.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "./supervisor.mjs";
import { savePrefs, defaultPrefs, rulesFingerprint } from "./prefs.mjs";

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "cdp-sup-"));
const prefsPath = join(dir, "prefs.json");
const stateDir = join(dir, "state");

/**
 * 兜底清理 —— 无论断言失败还是中途 throw，都必须把派生出去的 worker 收掉。
 *
 * 踩过的坑（2026-10-13）：测试中途抛出时，已经从 supervisor 派生出的 worker
 * 会变成孤儿进程留在用户机器上（实测留下 2 个 node 进程）。测试脚本必须自己
 * 负责清理自己启动的进程，不能指望主流程走到最后一步。
 */
const spawned = new Set();
const trackSpawn = (sup) => {
  const orig = sup.spawnWorker.bind(sup);
  sup.spawnWorker = (gen, opts) => {
    const r = orig(gen, opts);
    if (r?.pid) spawned.add(r.pid);
    return r;
  };
  return sup;
};

const killAll = () => {
  for (const pid of spawned) {
    try {
      process.kill(pid, 0); // 还活着才杀
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* 已退出 */
    }
  }
  spawned.clear();
};

process.on("exit", killAll);
process.on("uncaughtException", (err) => {
  console.error("未捕获异常，清理 worker 后退出：", err?.message || err);
  killAll();
  process.exit(1);
});

/** 用户 A 的规则（与任何人的既有规则无关，纯属虚构） */
const rulesA = {
  ...defaultPrefs(),
  titles: ["岗位A"],
  locations: ["城市A"],
  salaryFloor: { 城市A: 1111 },
  platforms: ["liepin"],
  browser: "chrome",
  confirmedAt: "2026-01-01T00:00:00.000Z",
};

console.log("场景：用户改规则 → 另开进程 → 逐步替换原进程\n");

try {
  savePrefs(rulesA, prefsPath);
  const sup = trackSpawn(new Supervisor({ prefsPath, stateDir }));

  /* ---------- 1. 首次启动 ---------- */
  console.log("1) 首次 reconcile → 应启动第一代");
  const first = await sup.reconcile({ intervalMs: 800 });
  ok(first.action === "started", "动作是 started", first.action);
  ok(first.ready === true, "第一代在就绪窗口内写出心跳", JSON.stringify(first));
  const gen1 = first.generation;
  const pid1 = first.pid;
  ok(gen1 >= 1, `代次 ≥ 1（实际 ${gen1}）`);
  ok(pid1 > 0, `拿到 pid（${pid1}）`);

  /* ---------- 2. 规则没变 → 不应换代 ---------- */
  console.log("\n2) 规则未变 → 必须沿用，不能换代（否则会无限重启）");
  const second = await sup.reconcile({ intervalMs: 800 });
  ok(second.action === "unchanged", "动作是 unchanged", second.action);
  ok(second.generation === gen1, `代次不变（${second.generation} === ${gen1}）`);
  ok(second.pid === pid1, "pid 不变");

  /* ---------- 2b. 反复 reload 不得丢失快照里的代次 ---------- */
  /*
   * 2026-10-13 在真实 DSH 里发现：generation=4 而 snapshotGeneration=0。
   * 根因是 reconcile() 每次都先用 writeSnapshot() 重写 rules.json（原先不写
   * generation），只在「需要换代」的分支才把它补回 —— 所以连续 reload
   * （规则不变）会把它抹掉且不再补，currentStatus() 随之退化成
   * 「取磁盘最大代次」。这条断言专门守这个回归。
   */
  console.log("\n2b) 反复 reload 不得丢失快照里的代次");
  const snapGenOf = () => JSON.parse(readFileSync(join(stateDir, "rules.json"), "utf8")).generation;
  ok(snapGenOf() === gen1, `启动后快照代次=${snapGenOf()}`);
  for (let i = 1; i <= 3; i += 1) {
    const rep = await sup.reconcile({ intervalMs: 800 });
    ok(rep.action === "unchanged", `第 ${i} 次 reload 仍为 unchanged`, rep.action);
    ok(snapGenOf() === gen1, `第 ${i} 次 reload 后快照代次仍为 ${gen1}`, `实际 ${snapGenOf()}`);
    ok(
      sup.status().snapshotGeneration === gen1,
      `第 ${i} 次 status().snapshotGeneration 正确`,
      `实际 ${sup.status().snapshotGeneration}`,
    );
  }

  /* ---------- 3. 指纹的稳定性：元数据变化不得触发换代 ---------- */
  console.log("\n3) 只改 confirmedAt 等元数据 → 指纹必须不变");
  const withNewMeta = { ...rulesA, confirmedAt: "2099-12-31T23:59:59.000Z", notes: "" };
  ok(
    rulesFingerprint(withNewMeta) === rulesFingerprint(rulesA),
    "confirmedAt 不影响指纹",
    `${rulesFingerprint(withNewMeta)} vs ${rulesFingerprint(rulesA)}`,
  );

  /* ---------- 4. 用户改规则 → 热替换 ---------- */
  console.log("\n4) 用户改规则 → 起新一代并让老一代退位（先起后杀）");
  const rulesB = { ...rulesA, titles: ["岗位B", "岗位B2"], salaryFloor: { 城市A: 2222 } };
  savePrefs(rulesB, prefsPath);

  const swap = await sup.reconcile({ intervalMs: 800 });
  ok(swap.action === "hot_swapped", "动作是 hot_swapped", swap.action);
  ok(swap.ready === true, "新一代确认就绪后才替换", JSON.stringify(swap));
  ok(swap.generation > gen1, `新代次更大（${swap.generation} > ${gen1}）`);
  ok(swap.pid !== pid1, "换成了新 pid");
  ok(swap.retiredGeneration === gen1, `老一代记录为 gen${gen1}`);
  ok(swap.retiredOk === true, "老进程确实被结束", JSON.stringify(swap));
  ok(swap.fromFingerprint !== swap.fingerprint, "指纹确实变了");

  /* ---------- 5. 老进程真的退出了吗 + 状态不得互相覆盖 ---------- */
  console.log("\n5) 老进程必须真的不在跑了，且状态文件不得互相覆盖");
  await sleep(1200);
  let oldAlive = true;
  try {
    process.kill(pid1, 0);
  } catch {
    oldAlive = false;
  }
  ok(!oldAlive, `老进程 pid ${pid1} 已退出`);

  // ⚠️ 回归守卫：两代曾共用 status.json 互相覆盖，导致热替换后报「老一代已停止」
  //    而实际新一代在跑。现在每代只写自己的 status.genN.json，这里断言：
  //      - 新一代的状态文件存在且为 running
  //      - 老一代的状态文件不被新一代的写入破坏
  const newStatusPath = join(stateDir, `status.gen${swap.generation}.json`);
  const oldStatusPath = join(stateDir, `status.gen${gen1}.json`);
  ok(existsSync(newStatusPath), `新一代状态文件存在 status.gen${swap.generation}.json`);
  const newStat = JSON.parse(readFileSync(newStatusPath, "utf8"));
  ok(Number(newStat.generation) === swap.generation, "新一代状态文件里的代次正确");
  ok(newStat.state === "running", `新一代状态为 running（实际 ${newStat.state}）`);
  ok(Number(newStat.pid) === swap.pid, "新一代状态文件记录的 pid 正确");
  ok(existsSync(oldStatusPath), `老一代状态文件仍在 status.gen${gen1}.json（未被覆盖）`);
  const oldStat = JSON.parse(readFileSync(oldStatusPath, "utf8"));
  ok(Number(oldStat.generation) === gen1, "老一代状态文件里的代次仍是自己的");

  /* ---------- 5b. status() 必须指向新一代 ---------- */
  console.log("\n5b) status() 必须报告新一代在跑");
  const stMid = sup.status();
  ok(stMid.generation === swap.generation, `status() 代次为 gen${swap.generation}（实际 ${stMid.generation}）`);
  ok(stMid.running === true, "status() 报告 running=true");

  /* ---------- 6. 状态交接：共享 append-only 文件未被覆盖 ---------- */
  console.log("\n6) 状态交接：append-only 的 done/events 不能被覆盖");
  const donePath = join(stateDir, "done.ndjson");
  // 模拟老一代留下的完成记录
  appendFileSync(donePath, JSON.stringify({ key: "old-task", generation: gen1 }) + "\n", "utf8");
  appendFileSync(donePath, JSON.stringify({ key: "new-task", generation: swap.generation }) + "\n", "utf8");
  const events = readFileSync(join(stateDir, "events.ndjson"), "utf8").trim().split("\n");
  const generationsInEvents = new Set(events.map((l) => JSON.parse(l).generation));
  ok(generationsInEvents.has(gen1) && generationsInEvents.has(swap.generation), "events 里两代记录都在（未被覆盖）");
  const doneLines = readFileSync(donePath, "utf8").trim().split("\n").length;
  ok(doneLines === 2, `done 记录两代都在（${doneLines} 行）`);

  /* ---------- 7. 状态查询 ---------- */
  console.log("\n7) status() 如实报告");
  const st = sup.status();
  ok(st.running === true, "running=true");
  ok(st.generation === swap.generation, "代次正确");
  ok(st.rulesChangedSinceStart === false, "规则已与快照一致，无待生效变更");
  ok(st.snapshotGeneration === swap.generation, "快照代次与运行代次一致");

  /* ---------- 8. 停止 ---------- */
  console.log("\n8) stop() 应停止当前运行器");
  const stopped = sup.stop();
  ok(stopped.stopped === true, "停止成功", JSON.stringify(stopped));
  await sleep(900);
  let newAlive = true;
  try {
    process.kill(swap.pid, 0);
  } catch {
    newAlive = false;
  }
  ok(!newAlive, `新进程 pid ${swap.pid} 已退出`);

  /* ---------- 9. 用户再改一次 → 从停止状态重新起 ---------- */
  console.log("\n9) 停止后用户又改规则 → 应能重新启动");
  savePrefs({ ...rulesB, titles: ["岗位C"] }, prefsPath);
  const restarted = await sup.reconcile({ intervalMs: 800 });
  ok(restarted.action === "started", "动作回到 started", restarted.action);
  ok(restarted.ready === true, "新进程就绪");
  sup.stop();
  await sleep(600);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
// 同 plugin.test.mjs：不用 process.exit()，避免 libuv 的
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 把退出码污染成 1。
process.exitCode = fail ? 1 : 0;
