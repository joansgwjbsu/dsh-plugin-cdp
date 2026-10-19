// 简历 × 招聘信息 匹配打分（能力实现，不含使用者的投递规则）。
//
// 边界说明：本模块只回答「这份 JD 与这份简历有多像」，并给出可解释的分项。
// 「像到什么程度才投」「用哪份简历」是使用者的规则，放在配置里（resumePath /
// matchThreshold / matchWeights / applyRequiresMatch），插件代码不写死任何阈值。
//
// 打分是确定性的关键词/条件匹配，不做语义推断：
//   技能覆盖 55% + 方向命中 25% + 经验满足 12% + 学历满足 8%（权重可配置）
import { readFileSync, statSync } from "node:fs";

/* ---------------- 技能词表（通用 IT 术语，非用户规则） ---------------- */

/**
 * 每项: [规范化名称, 正则]。正则里用 \\b 保护英文缩写，避免 "k8s" 命中 "ak8s" 之类。
 * 这是「一般 IT 岗位会提到什么」的通用表，与具体用户无关。
 */
const SKILLS = [
  ["Linux", /linux|\bcentos\b|\bubuntu\b|\bredhat\b|\bdebian\b/i],
  ["Windows", /windows|\bwin\s*server\b|\bad\b域/i],
  ["Shell", /shell|\bbash\b|脚本/i],
  ["Python", /\bpython\b/i],
  ["Java", /\bjava\b(?!script)/i],
  ["Go", /\bgolang\b|\bgo\b语言/i],
  ["SQL", /\bsql\b/i],
  ["MySQL", /mysql/i],
  ["PostgreSQL", /postgres|pgsql/i],
  ["Oracle", /oracle/i],
  ["达梦/国产数据库", /达梦|\bdm8?\b|人大金仓|神通/i],
  ["Redis", /redis/i],
  ["Kafka", /kafka/i],
  ["RabbitMQ", /rabbitmq/i],
  ["Nginx", /nginx/i],
  ["Tomcat", /tomcat/i],
  ["Docker", /docker|容器化/i],
  ["Kubernetes", /k8s|kubernetes/i],
  ["Ansible", /ansible/i],
  ["Jenkins", /jenkins/i],
  ["Git", /\bgit\b/i],
  ["CI/CD", /ci\/?cd|持续集成|持续交付/i],
  ["DevOps", /devops/i],
  ["Zabbix", /zabbix/i],
  ["Prometheus", /prometheus/i],
  ["Grafana", /grafana/i],
  ["ELK", /\belk\b|elasticsearch|logstash|kibana/i],
  ["监控体系", /监控|告警|巡检/i],
  ["虚拟化", /虚拟化|vmware|vsphere|kvm|超融合/i],
  ["云计算", /云计算|云平台|公有云|私有云/i],
  ["阿里云", /阿里云|\baliyun\b/i],
  ["华为云", /华为云|fusioncompute|fusio/i],
  ["腾讯云", /腾讯云/i],
  ["AWS", /\baws\b/i],
  ["存储", /存储|san|nas|分布式存储|cjs/i],
  ["备份/容灾", /备份|容灾|灾备|双活/i],
  ["服务器", /服务器|x86|刀片|机架/i],
  ["机房/IDC", /机房|\bidc\b|数据中心/i],
  ["网络", /网络|局域网|广域网|组网/i],
  ["交换机/路由", /交换机|路由器|华三|\bh3c\b|华为设备|cisco|思科/i],
  ["防火墙", /防火墙|firewall/i],
  ["TCP/IP", /tcp\/ip|\bosi\b|协议栈/i],
  ["VLAN/无线", /vlan|无线|\bap\b|wlan/i],
  ["VPN", /\bvpn\b|ipsec|ssl\s*vpn/i],
  ["负载均衡", /负载均衡|\blb\b|f5|lvs|haproxy/i],
  ["高可用", /高可用|\bha\b|集群/i],
  ["性能调优", /调优|优化|容量规划/i],
  ["故障排查", /排障|故障排查|故障处理|应急/i],
  ["信息安全", /信息安全|网络安全|等保|等级保护/i],
  ["渗透测试", /渗透|漏洞扫描|安全加固/i],
  ["数据库运维", /数据库运维|\bdba\b/i],
  ["中间件", /中间件|weblogic|websphere/i],
  ["自动化运维", /自动化运维|自动化部署|流水线/i],
  ["IT服务/桌面", /桌面运维|\bit\s*支持\b|\bit服务\b|helpdesk|终端/i],
  ["实施交付", /实施|交付|上线部署|部署实施/i],
  ["技术支持", /技术支持|售后支持|客户支持/i],
  ["信息化", /信息化|oa|crm|erp/i],
  ["驻场", /驻场|外派/i],
  ["运维", /运维/i],
];

/* ---------------- 方向词 ---------------- */

const DIRECTIONS = [
  ["运维", /运维|sre|系统工程师|系统管理员/i],
  ["网络", /网络工程|网络运维|网络管理|网络工程师/i],
  ["云计算", /云计算|云平台|云运维|云存储/i],
  ["实施", /实施工程师|实施顾问|部署实施/i],
  ["技术支持", /技术支持|it支持|helpdesk|桌面支持/i],
  ["信息化", /信息化|oa|crm|erp/i],
  ["安全", /安全工程师|网络安全|信息安全/i],
  ["数据库", /\bdba\b|数据库/i],
  ["机房/IDC", /机房|idc|数据中心/i],
  ["开发", /开发工程师|后端|前端|java开发|python开发/i],
  ["测试", /测试工程师|测试开发|功能测试|自动化测试/i],
  ["销售/售前", /销售|售前|bd|商务拓展/i],
];

const EDU_LEVEL = [
  ["博士", /博士/i],
  ["硕士", /硕士|研究生/i],
  ["本科", /本科/i],
  ["专科", /大专|专科|高职/i],
  ["中专/高中", /中专|中技|高中|职高/i],
  ["不限", /学历不限|不限学历/i],
];

const eduRank = (name) =>
  ({ 博士: 5, 硕士: 4, 本科: 3, 专科: 2, "中专/高中": 1, 不限: 0 }[name] ?? 0);

function uniq(arr) {
  return [...new Set(arr)];
}

/** 从文本里抽技能集合。 */
export function extractSkills(text) {
  const t = String(text || "");
  const out = [];
  for (const [name, re] of SKILLS) if (re.test(t)) out.push(name);
  return uniq(out);
}

/** 从文本里抽方向。 */
export function extractDirections(text) {
  const t = String(text || "");
  const out = [];
  for (const [name, re] of DIRECTIONS) if (re.test(t)) out.push(name);
  return uniq(out);
}

/** 从 JD 里抽经验要求（年）。返回 { required, raw }，required 为 null 表示不限/没写。 */
export function parseExperience(jdText) {
  const t = String(jdText || "");
  if (/经验不限|不限经验|应届|在校/.test(t)) return { required: 0, raw: "不限/应届" };
  const range = t.match(/(\d+)\s*[-–~至]\s*(\d+)\s*年/);
  if (range) return { required: Number(range[1]), raw: `${range[1]}-${range[2]}年` };
  const above = t.match(/(\d+)\s*年(?:及)?以上/);
  if (above) return { required: Number(above[1]), raw: `${above[1]}年以上` };
  const inline = t.match(/(\d+)\s*年(?:以上)?经验/);
  if (inline) return { required: Number(inline[1]), raw: `${inline[1]}年经验` };
  return { required: null, raw: "" };
}

/** 取某个小节的正文：从任一 start 关键词之后，到任一 stop 关键词之前的最近一段。 */
function sectionOf(text, starts, stops) {
  const t = String(text || "");
  let best = "";
  for (const s of starts) {
    const i = t.indexOf(s);
    if (i < 0) continue;
    let end = t.length;
    for (const e of stops) {
      const j = t.indexOf(e, i + s.length);
      if (j >= 0 && j < end) end = j;
    }
    const seg = t.slice(i + s.length, end);
    if (seg.length > best.length) best = seg;
  }
  return best;
}

/** 从简历里估工作年限：取「工作经历」小节里最早起始到最晚结束（"至今"按当前年）。 */
export function estimateYears(resumeText, now = new Date()) {
  const all = String(resumeText || "");
  // 只算工作经历：教育/培训的起止时间会把年限撑大（真实简历里 2021.9 的入学时间
  // 与 2024.3 的入职时间重叠，合并后能从 1.6 年被算成 4.9 年）。
  const work = sectionOf(
    all,
    ["工作经历", "工作经验", "实习经历", "职业经历"],
    ["项目经历", "培训经历", "教育经历", "技能", "证书", "自我评价", "求职意向", "荣誉"],
  );
  const t = work.length >= 20 ? work : all;
  const spans = [];
  const re = /(\d{4})[.\-/年](\d{1,2})?\s*[-–~至]\s*(至今|(\d{4})[.\-/年]?(\d{1,2})?)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const sy = Number(m[1]);
    const sm = m[2] ? Number(m[2]) : 1;
    const endCurrent = m[3] === "至今";
    const ey = endCurrent ? now.getFullYear() : Number(m[4]);
    const em = endCurrent ? now.getMonth() + 1 : m[5] ? Number(m[5]) : 12;
    if (!Number.isFinite(sy) || !Number.isFinite(ey)) continue;
    const start = sy + (sm - 1) / 12;
    const end = ey + (em - 1) / 12;
    if (end >= start) spans.push([start, end]);
  }
  if (!spans.length) return null;
  // 合并重叠区间，避免把「培训经历」和「工作经历」相加。
  spans.sort((a, b) => a[0] - b[0]);
  let [cs, ce] = spans[0];
  let total = 0;
  for (let i = 1; i < spans.length; i += 1) {
    const [s, e] = spans[i];
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      cs = s;
      ce = e;
    }
  }
  total += ce - cs;
  return Math.max(0, Math.round(total * 10) / 10);
}

/** 从 JD 里抽学历要求。 */
export function parseEducation(jdText) {
  const t = String(jdText || "");
  for (const [name, re] of EDU_LEVEL) if (re.test(t) && name !== "不限") return { required: name, raw: name };
  if (/学历不限|不限学历/.test(t)) return { required: null, raw: "不限" };
  return { required: null, raw: "" };
}

/** 从简历里抽最高学历。 */
export function resumeEducation(resumeText) {
  const t = String(resumeText || "");
  let best = null;
  for (const [name] of EDU_LEVEL) {
    if (name === "不限") continue;
    if (EDU_LEVEL.find(([n]) => n === name)[1].test(t)) {
      if (!best || eduRank(name) > eduRank(best)) best = name;
    }
  }
  return best;
}

const DEFAULT_WEIGHTS = { skills: 0.55, direction: 0.25, experience: 0.12, education: 0.08 };

/**
 * 打分。
 * @param {object} p
 * @param {string} p.jd      招聘信息文本（标题 + 描述都放进来最准）
 * @param {string} p.resume  简历文本
 * @param {number} [p.threshold] 达标线，默认 0.7（仅默认值，可由配置覆盖）
 * @param {object} [p.weights]   分项权重
 * @returns {{score:number|null, threshold:number, pass:boolean, parts:object, matched:string[], missing:string[], reasons:string[]}}
 */
export function scoreMatch({ jd, resume, threshold = 0.7, weights = DEFAULT_WEIGHTS } = {}) {
  const jdText = String(jd || "").trim();
  const resumeText = String(resume || "").trim();
  const th = Number(threshold);
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const reasons = [];

  if (jdText.length < 40) {
    return { score: null, threshold: th, pass: false, parts: {}, matched: [], missing: [], reasons: ["JD 文本过短，无法打分"] };
  }
  if (resumeText.length < 40) {
    return { score: null, threshold: th, pass: false, parts: {}, matched: [], missing: [], reasons: ["简历文本过短，无法打分"] };
  }

  /* 1) 技能覆盖 */
  const jdSkills = extractSkills(jdText);
  const cvSkills = new Set(extractSkills(resumeText));
  const matched = jdSkills.filter((s) => cvSkills.has(s));
  const missing = jdSkills.filter((s) => !cvSkills.has(s));
  const skills = jdSkills.length ? Math.min(1, matched.length / jdSkills.length) : 0.5;
  reasons.push(`技能：JD 提到 ${jdSkills.length} 项，命中 ${matched.length} 项` + (jdSkills.length === 0 ? "（JD 未提具体技能，按中性分）" : ""));

  /* 2) 方向命中 */
  const jdDirs = extractDirections(jdText);
  const cvDirs = new Set(extractDirections(resumeText));
  const dirHit = jdDirs.filter((d) => cvDirs.has(d));
  const direction = jdDirs.length ? (dirHit.length ? 1 : 0) : 0.5;
  reasons.push(`方向：JD=${jdDirs.join("/") || "未识别"}，简历=${[...cvDirs].join("/") || "未识别"}，共同=${dirHit.join("/") || "无"}`);

  /* 3) 经验 */
  const need = parseExperience(jdText);
  const years = estimateYears(resumeText);
  let experience = 0.5;
  if (need.required === null) {
    experience = 0.5;
    reasons.push("经验：JD 未写要求");
  } else if (years === null) {
    experience = 0.5;
    reasons.push(`经验：JD 要求 ${need.raw}，简历未解析出年限`);
  } else if (years >= need.required) {
    experience = 1;
    reasons.push(`经验：要求 ${need.raw}，简历约 ${years} 年，满足`);
  } else if (years + 1 >= need.required) {
    experience = 0.6;
    reasons.push(`经验：要求 ${need.raw}，简历约 ${years} 年，略差`);
  } else {
    experience = 0.15;
    reasons.push(`经验：要求 ${need.raw}，简历约 ${years} 年，不满足`);
  }

  /* 4) 学历 */
  const eduNeed = parseEducation(jdText);
  const cvEdu = resumeEducation(resumeText);
  let education = 0.5;
  if (!eduNeed.required) {
    education = 0.5;
    reasons.push("学历：JD 未写要求");
  } else if (!cvEdu) {
    education = 0.5;
    reasons.push(`学历：要求 ${eduNeed.raw}，简历未解析出学历`);
  } else if (eduRank(cvEdu) >= eduRank(eduNeed.required)) {
    education = 1;
    reasons.push(`学历：要求 ${eduNeed.raw}，简历 ${cvEdu}，满足`);
  } else {
    education = 0.3;
    reasons.push(`学历：要求 ${eduNeed.raw}，简历 ${cvEdu}，不满足`);
  }

  const score = Math.round((w.skills * skills + w.direction * direction + w.experience * experience + w.education * education) * 1000) / 1000;
  return {
    score,
    threshold: th,
    pass: score >= th,
    parts: { skills: round3(skills), direction: round3(direction), experience: round3(experience), education: round3(education) },
    weights: w,
    matched,
    missing,
    jdSkills,
    jdDirs,
    reasons,
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** 读简历文本文件（.txt/.md/.json）。带 mtime 缓存，改文件后自动重读。 */
const resumeCache = new Map();
export function loadResume(path) {
  if (!path) throw new Error("未配置简历文件路径");
  const st = statSync(path);
  const key = `${path}|${st.mtimeMs}|${st.size}`;
  if (resumeCache.has(key)) return resumeCache.get(key);
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const value = { path, text, chars: text.length, mtimeMs: st.mtimeMs };
  resumeCache.set(key, value);
  return value;
}
