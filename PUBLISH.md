# dsh-plugin-cdp 发布指南（GitHub 路线）

> **不需要 npm。** 经核实 `awesome-dsh-plugin` 的收录要求，npm 只是「推荐」——
> 把预构建 tarball 挂到 GitHub Release，用 `tarball:` 字段指向即可。
>
> 这条路线正好绕开了你遇到的 npm 注册风控。
>
> **我无法代你执行**：推送与提 PR 需要你的 GitHub 凭据（你浏览器里已登录，我这边没有）。

---

## 准备状态（已完成）

| 项 | 状态 |
| --- | --- |
| 收录格式 | ✅ 已从 `contributing.md` 逐条核实 |
| 提交条目 | ✅ 已写好并校验（`awesome-entry.yml`） |
| `package.json` 声明 `dsh.bundle` | ✅ `./cordis.patch.yml` |
| 根目录 `cordis.patch.yml` | ✅ |
| 真实可用代码 | ✅ 12 个模块 |
| `README.md` / `UPDATES.md` / `LICENSE` | ✅ |
| 版本号 | ✅ `0.2.0` |
| 预构建 tarball | ✅ `dsh-plugin-cdp-0.2.0.tgz`（77.6 kB） |
| git 仓库 | ✅ 已 init + 4 次提交，21 个文件 |
| 全部测试 | ✅ 161 项断言 + 自检，退出码全 0 |

---

## 收录的硬性要求（逐条对照）

来自 [`contributing.md`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)：

| 要求 | 你的状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` manifest | ✅ |
| 仓库含真实可用代码（非占位、非纯 README） | ✅ |
| **仓库创建满 1 天**（CI 自动检查） | ⏳ **唯一的时间门槛** |
| 仓库加 `dsh-plugin` topic | ⏳ 见第 2 步 |
| 描述如实、无营销词 | ✅ |
| 每个插件一个文件 `data/plugins/<owner>__<repo>.yml` | ✅ 已备好 |

> ⚠️ 最常见的被拒原因是**只声明了 `dsh.client` 而没有 `dsh.bundle`**——那样无法安装。你的已经声明了。

---

## 第 1 步：建仓库并推送

浏览器打开 <https://github.com/new>

- 仓库名：`dsh-plugin-cdp`
- 可见性：**Public**
- **不要**勾 "Add a README file"、**不要**加 `.gitignore`、**不要**选 license（本地都已存在）

创建后执行：

```powershell
cd D:\dsh\dsh-plugin-cdp

git remote add origin https://github.com/joansgwjbsu/dsh-plugin-cdp.git
git branch -M main
git push -u origin main
```

推送会要求登录。GitHub **已不支持密码推送**，用 Personal Access Token 当密码：
`Settings → Developer settings → Personal access tokens → Fine-grained tokens`，
权限给该仓库 **Contents: Read and write**。

---

## 第 2 步：加 `dsh-plugin` topic

仓库页面右侧 **About** 齿轮图标 → **Topics** → 输入 `dsh-plugin` → 保存。

（也可以在推送后让我用 API 加，需要一个临时 token。）

---

## 第 3 步：建 Release 并上传 tarball

仓库页面 → **Releases** → **Draft a new release**

- **Tag**：`v0.2.0`（点 "Create new tag"）
- **Title**：`dsh-plugin-cdp 0.2.0`
- **Attach binaries**：上传 `D:\dsh\dsh-plugin-cdp\dsh-plugin-cdp-0.2.0.tgz`

> 附件名必须与 `tarball:` 字段里的文件名一致：
> `https://github.com/joansgwjbsu/dsh-plugin-cdp/releases/latest/download/dsh-plugin-cdp-0.2.0.tgz`
>
> 若想改成别的文件名，两边都要改。

---

## 第 4 步：等满 1 天，然后提 PR

CI 会检查仓库年龄。**建仓库的当天提交会被自动拒**——不是对插件质量的判断，只是为了过滤「PR 前几分钟才建好」的仓库。明天再提即可，重新提交没有负面影响。

### 提 PR 的步骤

1. 打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
2. **Fork** 该仓库
3. 在你 fork 里新建文件：`data/plugins/joansgwjbsu__dsh-plugin-cdp.yml`
   （注意是**两个下划线** `__`）
4. 内容（即 `D:\dsh\dsh-plugin-cdp\awesome-entry.yml` 去掉注释后的部分）：

```yaml
url: https://github.com/joansgwjbsu/dsh-plugin-cdp
name: joansgwjbsu/dsh-plugin-cdp
category: browser
tarball: https://github.com/joansgwjbsu/dsh-plugin-cdp/releases/latest/download/dsh-plugin-cdp-0.2.0.tgz
description:
  en: Drives a self-managed Chrome instance over the Chrome DevTools Protocol through 15 tools, including a verified-click primitive that waits for the detail panel to settle and refuses when the panel content disagrees with the selected item; ships no rules of its own and instead collects user preferences through a popup questionnaire, renders job, salary and location data as zero-dependency Unicode charts and monospace tables, and hot-swaps a long-running worker by starting a new generation and confirming it is alive before retiring the old one.
  zh: 通过 15 个工具以 Chrome DevTools Protocol 驱动一个自管理的 Chrome 实例，其中包含一个「校验后再点击」的原语：等详情面板稳定、并在面板内容与所选项不一致时拒绝操作；插件本身不携带任何规则，改为用弹窗问卷收集用户偏好；把岗位、薪资、地点数据渲染成零依赖的 Unicode 图表与等宽表格；并以「先起新一代、确认存活，再让老一代退位」的方式热替换长驻运行器。
```

5. 提交 PR。

### PR 标题

```
Add joansgwjbsu/dsh-plugin-cdp
```

### PR 正文

```markdown
Adds `data/plugins/joansgwjbsu__dsh-plugin-cdp.yml`.

- Repo: https://github.com/joansgwjbsu/dsh-plugin-cdp
- `package.json` declares `dsh.bundle` → `./cordis.patch.yml` (present at repo root)
- Category: `browser` — the plugin's core is driving a Chrome instance over CDP
- Not published to npm; a prebuilt tarball is attached to the latest GitHub Release
  and referenced with the `tarball:` field
- 15 tools, zero runtime dependencies (Node built-in `fetch` + `WebSocket` only)
- 161 local assertions plus a plugin self-test, all passing

This PR adds one file and modifies no existing entry.
```

> 最后一句值得留着——评审明确会看「PR 是否动了与它无关的条目」，主动声明能省一轮沟通。

---

## 提交后会发生什么

- **CI 先跑**：校验 manifest、仓库年龄、YAML 格式、README 能否重新生成。CI 绿了只是前提，不是结论。
- **维护者会实际读你的仓库**，核对描述与代码是否一致（包括描述里的数字与 API 名称）。
- README 由脚本从 `data/plugins/*.yml` 生成，**合并后自动更新，你不需要也不应该手改**。
- 被打回会以 PR 评论明确写出要改什么；因描述不准确被打回不是对插件的否定，改好即可。

---

## 常见问题

**Q：一定要发 npm 吗？**
A：不必。npm 只是「推荐」（预构建安装在装的时候免 `allowBuilds` 构建授权）。用 GitHub Release 附件 + `tarball:` 字段即可。

**Q：`npm login` 报 `ENEEDAUTH` / 网站打不开？**
A：你遇到的 npm 网站风控。**这条路线完全不需要 npm**，忽略即可。順带一提：本机 `registry.npmjs.org` 其实是通的（实测 HTTP 200），被挡的只有 `www.npmjs.com` 网页。

**Q：现在就能提 PR 吗？**
A：仓库满 1 天后。CI 会拒当天建的仓库。

**Q：想先不公开、只自己用？**
A：跳过全部步骤，直接本地装：
```powershell
npm i D:\dsh\dsh-plugin-cdp\dsh-plugin-cdp-0.2.0.tgz
```

**Q：`github.com` 打不开怎么办？**
A：浏览器能开（你能发仓库）；命令行推送走 `github.com` 的 git 协议，若也受限可用代理，或在 GitHub 网页上直接上传文件（Add file → Upload files）。

---

## 需要我继续做什么

- 给我一个临时 token，我可以用 GitHub API 完成**加 topic、建 Release 并上传附件**这两步（推送代码仍需你在网页操作或本地有凭据）
- 想改描述措辞、分类、或 tarball 文件名，说一声
