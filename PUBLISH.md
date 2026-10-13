# dsh-plugin-cdp 发布指南

> 目标：把插件发布到 npm，推送到 GitHub，并提交到 DSH 插件市场（awesome-dsh-plugin）。
>
> **为什么需要你亲自执行**：发布是**不可逆的公开操作**，需要你的 npm 账号登录态与 GitHub 认证。这些凭据只能由你本人提供，我不能替你登录你的账号。其余准备工作（仓库、元数据、打包产物）已全部完成。

---

## 当前准备状态（已完成）

| 项目 | 状态 |
| --- | --- |
| 包名 `dsh-plugin-cdp` 在 npm 上是否可用 | ✅ **未被占用**（已查 404） |
| `package.json` | ✅ 已补 `version` `license` `repository` `homepage` `bugs` `keywords` `author` `engines` |
| 版本号 | ✅ 已从 `0.1.0` 升到 **`0.2.0`** |
| `README.md` | ✅ 已写（中英双语） |
| `UPDATES.md` | ✅ 更新说明 |
| `LICENSE` | ✅ MIT |
| `.gitignore` | ✅ 已写（排除 `node_modules/` `*.tgz`） |
| npm 包内容 | ✅ 已排除测试文件，13 个文件 / 77.6 kB |
| git 仓库 | ✅ 已 `git init` 并完成 2 次提交 |
| 本地打包产物 | ✅ `dsh-plugin-cdp-0.2.0.tgz` |
| 全部测试 | ✅ 161 项断言 + 自检，退出码全 0 |

**打包内容**（`npm pack --dry-run` 实测）：

```
LICENSE   README.md   UPDATES.md   cordis.patch.yml   package.json
lib/contract.mjs   lib/index.mjs   lib/jobs.mjs   lib/logs.mjs
lib/prefs.mjs      lib/report.mjs  lib/supervisor.mjs  lib/worker.mjs
```

> 测试文件（`*.test.mjs`）与 `selftest.mjs` 已被排除在 npm 包外，但仍保留在 git 仓库里。

---

## 第 1 步：在 GitHub 建仓库并推送

浏览器打开 <https://github.com/new>，**不要**勾选 "Add a README file"、不要加 `.gitignore`、不要选 license（这些本地都已存在），仓库名填：

```
dsh-plugin-cdp
```

保持 **Public**（提交到市场通常要求公开可访问），创建后执行：

```powershell
cd <插件目录>

git remote add origin https://github.com/joansgwjbsu/dsh-plugin-cdp.git
git branch -M main
git push -u origin main
```

推送时会要求登录 GitHub。若用 HTTPS 需要 **Personal Access Token**（GitHub 已不支持密码推送）：
`Settings → Developer settings → Personal access tokens → Fine-grained tokens`，权限给该仓库的 **Contents: Read and write**。

---

## 第 2 步：登录 npm 并发布

```powershell
# 1) 登录（会打开浏览器或要求输入用户名/密码/一次性验证码）
npm login --registry=https://registry.npmjs.org/

# 2) 确认登录身份
npm whoami --registry=https://registry.npmjs.org/

# 3) 发布前先干跑一次，确认内容无误
cd <插件目录>
npm publish --dry-run --registry=https://registry.npmjs.org/

# 4) 正式发布
npm publish --registry=https://registry.npmjs.org/
```

> ⚠️ **你的 npm registry 当前指向 `https://registry.npmmirror.com`（淘宝镜像）**。镜像**只能读、不能发布**，所以上面每条命令都必须显式带 `--registry=https://registry.npmjs.org/`。
>
> 若想永久改回官方源：`npm config set registry https://registry.npmjs.org/`

发布成功后验证：

```powershell
npm view dsh-plugin-cdp --registry=https://registry.npmjs.org/
```

---

## 第 3 步：提交到 DSH 插件市场

**这一步的提交格式我没有核实成功**，原因需要你知道：`github.com` 与 `raw.githubusercontent.com` 在你的网络里被解析到非公网 IP，被网络策略挡住了，我取不到 `awesome-dsh-plugin` 的 `contributing.md`。

请按以下方式获取确切格式，**不要凭猜测提 PR**（格式不对会被直接关闭）：

1. 浏览器打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>
2. 看 "How submissions are reviewed" 一节对**条目格式**的要求
3. 参照最近一个真实 PR 的改法：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pulls>（搜 `Add ` 前缀的 PR）

### PR 文案（可直接用）

**标题：**

```
Add joansgwjbsu/dsh-plugin-cdp
```

**正文：**

```markdown
## 插件信息

- **名称**：dsh-plugin-cdp
- **仓库**：https://github.com/joansgwjbsu/dsh-plugin-cdp
- **npm**：https://www.npmjs.com/package/dsh-plugin-cdp
- **License**：MIT
- **Node**：>= 22

## 它做什么

用 Chrome DevTools Protocol 驱动一个**自管理**的 Chrome 实例，为 DSH 提供浏览器自动化能力，
并附带三个额外能力：

1. **弹窗收集规则**——插件**本身不携带任何规则**。首次使用时返回问卷，由 DSH 内置的
   `ask_user_question` 弹窗询问岗位方向、工作地点、薪资下限、投递平台、浏览器、排除规则，
   答案落盘后不再重复询问。规则类问题**不预置选项、不标 Recommended**——预置选项等于把
   某个人的规则当成新用户的默认答案。
2. **零依赖文本可视化**——用 Unicode 字符画薪资直方图、地点条形图、投递火花线与等宽明细表。
   中文按双宽计算，表格列不会错位（实测 5 张表 / 113 行，竖线列位完全一致）。
3. **无停机热替换**——规则变化时**先起新一代、确认存活，再让老一代退位**，而不是原地重启
   （原地重启必然有一段「没有任何进程在跑」的真空期）。两代共享 **append-only** 状态，
   所以重叠期不会重复做事；新一代若起不来，**保留老一代继续运行**。

## 为什么用 CDP 而不是浏览器扩展通道

扩展通道驱动不了部分站点：受控标签页会被目标站点清空、借用的用户标签页同样变空白，
且页面会报告成功对话框而操作并未真正生效。本插件自带实例、直接说 CDP，并强制
「可验证的操作流程」——`cdp_apply_verified` 要求详情面板标题连续 3 次读数稳定、
面板薪资与卡片薪资逐字相同，否则拒绝点击。

## 质量

- **零运行时依赖**（仅用 Node 内置 `fetch` + `WebSocket`）
- **161 项本地断言** + 插件加载自检，全部通过
- 自检覆盖三类**只有宿主才会拒绝**的错误：`output.schema` 漏声明字段、
  返回值含 `undefined`（非合法 JSON）、输出未通过 `validateJsonSchemaValue`

## 备注

15 个工具，`dsh` bundle patch 位于 `cordis.patch.yml`。
```

---

## 第 4 步：发布后自检

```powershell
# 在一个干净目录里装一遍，确认包能正常解析
mkdir $env:TEMP\cdp-install-test; cd $env:TEMP\cdp-install-test
npm init -y | Out-Null
npm i dsh-plugin-cdp --registry=https://registry.npmjs.org/
node -e "import('dsh-plugin-cdp').then(m=>console.log('name:',m.name,'| apply:',typeof m.apply))"
```

预期输出：

```
name: dsh-plugin-cdp | apply: function
```

---

## 常见问题

**Q：`npm publish` 报 `ENEEDAUTH`**
A：没登录，先 `npm login`。

**Q：`npm publish` 报 `E403` 或 `cannot publish over existing version`**
A：版本号已被占用。改 `package.json` 的 `version`（如 `0.2.1`）后重新发布。npm **不允许覆盖已发布版本**。

**Q：推送到 GitHub 报 `Authentication failed`**
A：GitHub 不支持密码推送，用 Personal Access Token 代替密码；或配置 SSH key。

**Q：想先不公开、只自己用**
A：跳过第 1、3 步，只做第 2 步（npm 包可以是公开的但仓库保持私有），或者干脆只用本地的
`dsh-plugin-cdp-0.2.0.tgz` 分发：
```powershell
npm i <插件目录>\dsh-plugin-cdp-0.2.0.tgz
```

**Q：发错了想撤销**
A：发布 72 小时内可 `npm unpublish dsh-plugin-cdp@0.2.0`，但**强烈不建议**——已被别人安装的包会断掉。正确做法是发一个新版本修正。

---

## 需要我继续做什么

- 你拿到 `contributing.md` 的条目格式后贴给我，我按格式写好那一条
- 需要我改版本号、补充 README 章节、或调整 PR 文案，说一声即可
