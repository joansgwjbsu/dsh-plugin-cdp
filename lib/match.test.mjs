// 简历 × JD 匹配打分的单元测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMatch, extractSkills, estimateYears, parseExperience, parseEducation, loadResume } from "./match.mjs";

// 测试用简历（真实简历的节选，保留会命中的关键词与起止时间）
const RESUME = `
求职意向
意向岗位：运维工程师 意向城市：北京
教育经历
2021.9-2024.6 山西管理职业学院
软件技术 | 专科
工作经历
2024.3-2025.10 北京中兴富盛科技管理有限公司
运维工程师 | IT 服务
硬件与终端运维：负责用户单位硬件设备定期巡检与状态排查,完成系统重装、驱动适配及软件标准化部署
故障响应与排查：快速响应各类 IT 故障,通过系统日志与监控工具辅助定位问题
参与同仁医院驻场运维项目,具备跨科室协同、业务侧服务支撑的实践经验
培训经历
2025.10-2026.08 北大青鸟佳音学校
计算机 | 云计算安全
主修课程:Linux 系统运维、Shell 脚本、MySQL 高可用、Redis/Kafka 中间件、Web 负载均衡集群、Ansible/Jenkins DevOps、Docker、阿里云公有云运维
项目经历
数据库迁移:将业务系统数据库由 MySQL 迁移至达梦数据库(DM),负责数据库部署、数据迁移、兼容性验证
桌面与网络运维:负责办公网络、交换机、无线 AP、防火墙策略维护,机房日常巡检
`;

const JD_GOOD = `运维工程师
岗位职责：
1. 负责 Linux 服务器日常运维、巡检与故障排查；
2. 负责 Docker/Kubernetes 容器平台部署与维护；
3. 参与监控告警体系建设，保障系统高可用；
4. 配合机房网络设备（交换机、防火墙）维护。
任职要求：大专及以上学历，1-3年运维经验，熟悉 Shell 脚本、MySQL、Redis。
`;

const JD_BAD = `Java 后端开发工程师
岗位职责：负责微服务架构设计与开发，高并发交易系统性能优化，参与核心链路重构。
任职要求：本科及以上学历，3-5年 Java 开发经验，精通 Spring Cloud、MyBatis、JVM 调优。
`;

const JD_WEAK = `网络运维工程师
岗位职责：负责广域网、VPN、BGP 路由策略维护，网络割接与故障处理。
任职要求：本科及以上学历，3年以上网络工程经验，持有 CCNP/华为认证优先。
`;

test("好岗：运维岗命中技能与方向，分数达标", () => {
  const r = scoreMatch({ jd: JD_GOOD, resume: RESUME, threshold: 0.7 });
  assert.equal(r.pass, true, `score=${r.score}`);
  assert.ok(r.score >= 0.7, `score=${r.score}`);
  assert.ok(r.matched.includes("Linux"));
  assert.ok(r.matched.includes("Docker"));
});

test("差岗：Java 开发岗分数明显低", () => {
  const r = scoreMatch({ jd: JD_BAD, resume: RESUME, threshold: 0.7 });
  assert.equal(r.pass, false);
  assert.ok(r.score < 0.5, `score=${r.score}`);
});

test("弱岗：网络工程要求 3 年+本科，分数居中且低于好岗", () => {
  const weak = scoreMatch({ jd: JD_WEAK, resume: RESUME, threshold: 0.7 });
  const good = scoreMatch({ jd: JD_GOOD, resume: RESUME, threshold: 0.7 });
  assert.ok(weak.score < good.score, `weak=${weak.score} good=${good.score}`);
  assert.ok(weak.score > 0.2, `weak=${weak.score}`);
});

test("阈值边界：等于阈值算达标，高一分就不达标", () => {
  const base = scoreMatch({ jd: JD_GOOD, resume: RESUME, threshold: 0 });
  const at = scoreMatch({ jd: JD_GOOD, resume: RESUME, threshold: base.score });
  const above = scoreMatch({ jd: JD_GOOD, resume: RESUME, threshold: base.score + 0.01 });
  assert.equal(at.pass, true);
  assert.equal(above.pass, false);
});

test("空 JD / 空简历：不打分，不通过", () => {
  const a = scoreMatch({ jd: "", resume: RESUME });
  const b = scoreMatch({ jd: JD_GOOD, resume: "" });
  assert.equal(a.score, null);
  assert.equal(a.pass, false);
  assert.equal(b.score, null);
  assert.equal(b.pass, false);
});

test("技能抽取：常见术语能识别，且不会把 javascript 当成 java", () => {
  const s = extractSkills("熟悉 Linux、Docker、K8s、MySQL；了解 JavaScript 与 Node.js");
  assert.ok(s.includes("Linux"));
  assert.ok(s.includes("Docker"));
  assert.ok(s.includes("Kubernetes"));
  assert.ok(s.includes("MySQL"));
  assert.ok(!s.includes("Java"), `误识别 Java: ${s.join(",")}`);
});

test("经验解析：区间/以上/不限", () => {
  assert.equal(parseExperience("1-3年经验").required, 1);
  assert.equal(parseExperience("3年以上相关经验").required, 3);
  assert.equal(parseExperience("经验不限").required, 0);
  assert.equal(parseExperience("负责日常运维").required, null);
});

test("学历解析：本科/大专/不限", () => {
  assert.equal(parseEducation("本科及以上学历").required, "本科");
  assert.equal(parseEducation("大专以上").required, "专科");
  assert.equal(parseEducation("学历不限").required, null);
});

test("工作年限：只算工作经历小节（教育/培训不算）", () => {
  const y = estimateYears(RESUME);
  // 2024.3 - 2025.10 ≈ 1.6 年；教育(2021.9)与培训(2026.8)不能算进来
  assert.ok(y > 1.4 && y < 2.0, `years=${y}`);
});

test("权重可配置：把方向权重调到 1 会让差岗位分数变化", () => {
  const w1 = { skills: 0.55, direction: 0.25, experience: 0.12, education: 0.08 };
  const w2 = { skills: 0.25, direction: 0.55, experience: 0.12, education: 0.08 };
  const a = scoreMatch({ jd: JD_WEAK, resume: RESUME, weights: w1 });
  const b = scoreMatch({ jd: JD_WEAK, resume: RESUME, weights: w2 });
  assert.notEqual(a.score, b.score);
});

test("loadResume：读真实简历文件时能拿到文本（文件不存在则报错）", () => {
  assert.throws(() => loadResume("<工作目录>\\__not_exist__.txt"), /ENOENT|no such file/i);
});
