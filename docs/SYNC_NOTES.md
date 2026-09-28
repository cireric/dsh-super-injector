# 上游同步笔记（SYNC NOTES）

> 状态件：**不留流水账**，不做逐轮追加 —— 第 1 节锚点行与第 3 节每轮整段替换；第 2/4/7 节是稳定层（事实或方法变了才改）；第 5 节随事实更新；第 6 节只追加。
> 读者是 agent 或未来的自己：第 2 节的命令必须能直接照抄执行。
> 唯一职责：回答两件事 —— ① 上次分析到上游的哪个状态？② 上游在它之后改了什么、该不该吸收？本仓库的构建/安装约束见第 5 节。

## 1. 锚点（过账水位）

- standalone 上游：https://github.com/yjh051108/dsh-super-injector
- 姊妹仓库（内嵌一份 injector 副本，与 standalone **不同步、互为补充**）：
  https://github.com/yjh051108/dsh-routing-suite → `injector/` 目录
- **锚点 commit：`f4ef59f`（2026-08-15，v0.3.3）**
- **水位语义**：锚点 = 本轮全部处置完才前进的**过账水位**；当前仍停在 f4ef59f，因为第 3.2 节还有「待触发 / 待做」项。本轮已分析到上游 HEAD `735c212`（2026-09-19，package.json 0.3.5）。
- 锚点语义：**git commit id 即内容**（commit 内含 tree 哈希）⇒ 记下 id 就等于记下那棵树，不需要把代码抄进本文件。要看某文件当时的样子：`git show f4ef59f:src/index.ts`
- 本 fork：基点 `f4ef59f`，HEAD `0099ee3`（「放宽校验器」，2026-09-28 22:20 提交，仅改 src/index.ts）；工作树另有未提交改动（`src/index.ts` 的 isHealthyLink 三处，已编进 `lib/index.js`）

## 2. 比对步骤（每次照抄；先比 standalone，再比姊妹仓库）

```bash
# 0. 一次性：拿一份上游参照。推荐挂 remote —— 后续 diff 直接对着本仓库工作树（含未提交改动）
git remote add upstream https://github.com/yjh051108/dsh-super-injector.git
git fetch upstream
#    不想动本仓库 .git 的等效做法：临时 clone。注意它比的是**已提交状态**，未提交改动要另看 git status
#    git clone https://github.com/yjh051108/dsh-super-injector.git /tmp/up-si
#    git clone <本仓库> /tmp/fork && git -C /tmp/fork remote add upstream /tmp/up-si && git -C /tmp/fork fetch upstream

# 1. 上游自锚点之后动过什么（提交级）
git log --oneline f4ef59f..upstream/main

# 2. 源文件面改动量。★ 必须带 --ignore-cr-at-eol：
#    上游 2026-09-19 的 8 个 sync 提交是整文件 CRLF 重写，不带此参数则 diffstat 上万行、全是噪声
git diff --ignore-cr-at-eol --stat f4ef59f..upstream/main -- src scripts package.json README.md INSTALL.md

# 3. 读内容（先读提交信息判断性质，再看 patch）
git log -p --ignore-cr-at-eol f4ef59f..upstream/main -- src scripts package.json

# 4. 与本 fork 当前工作树比 —— 回答「我缺什么 / 我多什么」，这才是判决依据
git diff --ignore-cr-at-eol upstream/main -- src scripts package.json README.md

# 5. 姊妹仓库（standalone 不合 PR，社区修复只在它这里）
git clone --depth 50 https://github.com/yjh051108/dsh-routing-suite.git /tmp/suite
git -C /tmp/suite log --oneline -15 -- injector
```

**信号源排序（实测 2026-09-28，别搞反）**：commit message > 源码 diff ≫ 文档。

- 上游 f4ef59f..735c212 这 14 个提交里，文档面只有 `README.md +8 行`（还是安装注意事项）；
  `CHANGELOG.md` / `INSTALL.md` / `docs/SPEC.md` **一行未改**，CHANGELOG 末条仍停在
  `## [0.3.3] — 2026-08-15`，而 package.json 已经是 `0.3.5`（作者文档落后两个版本）。
  ⇒ 上游把变更说明写在 **commit message** 里，**不要**指望 README/CHANGELOG 告诉你新增了什么。
- 噪声量化：`src/index.ts` 在该区间带 `--ignore-cr-at-eol` 是 **362 行**改动，不带是 **6802 行**（17 倍）。
- 一轮成本（实测）：共享文件 15 个，源码面只有 2 个（`src/index.ts` / `src/client/index.ts`）+ 3 个脚本
  ⇒ 一轮 = fetch/clone + 上面 3 条命令 + 读两段 diff，人约 10–20 分钟。

**「是否吸收」不由 diff 给出**：diff 只说改了什么，判决要靠判决三问 + 本机部署画像（单机 macOS /
web profile / 天天热重载注入 / 不对外发 tgz），并把结论写进第 3、6 节，否则下一轮会把同样的项重推一遍。

**判决三问**（顺序固定，任一命中即「抄」）：

1. **会不会毁东西？**（删/改别人的目录、误删 patch config、弄坏 registry）→ 抄
2. **会不会让宿主挂死/崩溃/需重启，或让插件装不上、页面空白？** → 抄
3. **最近 30 天真的会碰到吗？** → 会：抄；不会：记进第 6 节「已评估不吸收」，避免下轮重复评估

**抄的方式**：改动落在本 fork 已重构过的区块（`reload`/`apply` 主干、client）→ 按契约重写；
独立小区块 → 可照抄。**禁止 `git merge upstream/main`**：上游整文件 CRLF 重写 + 本 fork 已重构，
实测 merge-tree 出 7 处冲突段。

## 3. 本轮分析与判决（2026-09-28：锚点 f4ef59f → 上游 HEAD 735c212）

上游共 14 个提交、源文件面 11 个；其中 3 项 feat 已同步于 `b9ff036`（prepare 钩子 b758780 /
dev_reload_preset 000bd12 / 自举卸载 c08136a），其余 7 个 `sync` 提交是整文件 CRLF 重写或与本 fork
等价，**无功能变化**。

### 3.1 本机上膛实测（优先级按这个排，不按上游自述排）

| 指标 | 实测值（2026-09-28） |
|---|---|
| reload | **379 ok / 0 fail**（stats.json），日志无挂死类事件 |
| inject | 51 ok / **38 fail（43%）**——多为 validator 假阳性与 watch 预检；修复后 09-28 12:28 注入成功 |
| dev_install_package | **0 次使用** |
| registry ∩ profile bundles | **∅**（registry 只有 dsh-prompt-enhancer） |
| profile 真实目录（deps 内、非链接） | **25 个**，含 dsh-better-sidebar / dsh-mnemon / dsh-mcp-panel / dsh-context 等可注入插件名 |
| 包名解析（从 fork 实路径） | 裸 `cordis` / `schemastery` = OK；`@deepseek-ai/cordis` / `@deepseek-ai/schemastery` = **MODULE_NOT_FOUND** |
| 包名解析（从 profile 根） | 裸名与 scoped **都 OK**（裸名走 .dsh-module-fallback + profile 内 schemastery 实体；scoped 走 $DSH_HOME/profiles/node_modules） |

### 3.2 判决表（按实测重排）

| 项 | 上游提交 | 本机后果 | 判决 / 触发条件 | 状态 |
|---|---|---|---|---|
| `isHealthyLink` 真实目录守卫 | 姊妹仓库 PR #65（standalone 从未有） | 环境破坏（可经 profile 重装恢复，代价是重建+重启） | 做（10 行、零冲突） | **已做**（src + lib；未提交；运行时**未生效**，待重载/重启） |
| 裸名 → scoped 改名 | 1df6cde（16 处 + peer 键） | 本机方向相反 | **暂缓**：要抄必须同批改 build.sh 的 link_pkg + peer 键 + 重新构建 + 本机重测 | 已决 |
| reload 主干三件（handoff / 防毒化 / 顺序校准） | 6a7e8db 等 8 个 sync | 挂死（需重启宿主） | **等信号**：reload 不返回 + `reload-debug.log` 无新行 = 此族 | 待触发 |
| 未处理 rejection 常驻兜底 + dev_stage_call 回执 | 同上 | 崩溃循环 | 延后：首次写会逃逸 rejection 的 staged 工具前 | 待触发 |
| bundles 防重护栏（readProfileBundles） | 同上 | 崩溃（双实例炸 plugin tree） | 延后：首次使用 `dev_install_package` 前 | 待触发 |
| slot 白名单 51 项 | 同上 | 误拦合法插件 | 与本 fork 的 61 项取并集（防漏，低优先） | 待做 |
| prepare 构建后脱敏 + node --check | 735c212 | 发布件隐私 | 不抄（private，不对外发 tgz） | 已决 |
| build.sh 的 @types/node 防御 | f1b03d2 | 工程卫生 | 不抄（本 fork 已 link @types/node） | 已决 |
| client 整文件 CRLF 重写 | 760a2c1 | — | 不抄（本 fork client 更强） | 已决 |

> 姊妹仓库只比了**当前文件状态**（逐文件 diff），未比其提交史 —— 表中「姊妹仓库 PR #65」是唯一有
> 提交级证据的一条。
> 水位保持在 `f4ef59f`：本表仍有「待触发 / 待做」项，**全部处置完再前进**（前进 = 把第 1 节锚点行
> 改成本轮上游 HEAD）。

## 4. 本 fork 独有补丁（两条上游线都没有，不能被上游覆盖）

| 补丁 | 来源 | 为什么必须留 |
|---|---|---|
| patch 顶层/嵌套分桶去重（`extractPatchBlocks` + `dedupe`，含 scripts/fix-patch.mjs 双路径） | 移植上游 open PR #6 | 上游至今未合；防误删顶层 config 块（dsh-vision 事故） |
| `loader.internal` 可选链守卫 | 移植 open PR #11 | 上游未合；无 `--expose-internals` 启动（如 Desktop GUI）时 dev_plugin_status 会崩 |
| heal 悬空 junction 用 `lstatSync` 判定存在 | 移植 open PR #20 | 上游未合；`existsSync` 跟随链接，悬空 junction 返回 false → 误报「全部健康」 |
| checkout 探测补 `~/deepseek-harness` 候选 | 移植 open PR #5 | 上游未合 |
| uninject 删 junction 改用 `fs.rm` | 本 fork | `rmdir` 不跟随 symlink（macOS/Linux 报 ENOTDIR） |
| slot 白名单 61 项（现场从 harness 的 slot-catalog.ts 派生） | 本 fork | 上游 51 项、姊妹副本 11 项；旧表会误拦合法插件 |
| 放宽校验器：`REGISTER_NAME` 容忍折行（register( 与 { 之间允许空白） | 本 fork（已提交 `0099ee3`） | 双参调用被格式化折行时旧正则误判「register 缺合法 name」→ 阻断注入 |
| 客户端骨架校验改蕴含式（只有真的用 ctx.slots 才校验 inject / slot 名） | 本 fork | 上游同日独立修了同类问题（上限 400 字符的写法），本 fork 版本不设上限 |
| 设置页：React 组件契约 + 全 locale 化 + 名/路径双行 | 本 fork（姊妹副本只修了契约、无 locale） | 修 React #130 空白页；en 界面不再「导航英、正文中」 |
| presetsRoot 读目录不吞非 ENOENT 错误 | 本 fork | 错误可见 |
| `isHealthyLink` 的两处加固：注入路径遇真实目录显式 ERROR 拒绝覆盖、自愈路径遇真实目录 logger.warn | 本 fork（在姊妹 PR #65 之上） | 只照抄 #65 会引入**静默错载**（注入声称成功、实际加载已装版本）；自愈那侧会静默跳过 |

## 5. 构建与安装约束（本仓库特有的事实 + 成因，别再踩）

**① 禁止在本仓库跑任何包管理器的 install（npm / pnpm 都不行）。**

- 成因 A：pnpm 8+ 默认 `auto-install-peers`，会顺着 peer `@deepseek-ai/dsh-tools` 去 registry 解析，
  而它的依赖 `@deepseek-ai/dsh-type-meta` **未发布到 npm** → `ERR_PNPM_FETCH_404`（2026-09-28 实测；
  姊妹仓库同坑：`#76 unpin unpublished dsh-type-meta so npm ci works`）。
- 成因 B：PM 会接管 `node_modules`，把 `scripts/build.sh` 手工建的 junction 全部清掉（2026-09-28 实测：
  `pnpm install` 之后 `node_modules` 整个消失）→ 运行中的注入器还能撑，但**下次重载/重启 import 失败**。

**② 构建只走 build.sh，且必须显式给 checkout**（脚本目前**不自探测**）：

```bash
DSH_CHECKOUT=/Users/eric/Project/tests/deepseek-harness bash scripts/build.sh
```

- ⚠️ 别用 `cmd | tail` 看它的退出码：管道会把退出码换成 `tail` 的（实测踩过，误判为成功）。
- 需要 tsc / tsdown 时用 checkout 里现成的 `$DSH_CHECKOUT/node_modules/.bin/{tsc,tsdown}`；`prepare.mjs` 另有 npx 兜底。
- 2026-09-28 曾给 build.sh 加过「自探测 $HOME 候选 + 仓库同级目录 + `pwd -P` 规范化」，**已被回退**（当前 = HEAD 版本，只认 `$DSH_CHECKOUT`）。要走「不写死路径」的路见第 6 节备选。

**③ 三层包管理器归属（别混淆）**：

| 层 | 实测判据 | 结论 |
|---|---|---|
| 本仓库 | 只有 `package-lock.json`（lockfileVersion 3）；无 `.npmrc`；`package.json` 无 `packageManager` | npm 锁，但**不需要 install** |
| 本仓库 `node_modules` | 无任何 PM 指纹（无 `.pnpm/` `.modules.yaml` `.package-lock.json`）；6 项全是 build.sh 建的 junction | **不是 PM 装的** |
| 宿主 `$DSH_HOME/profiles/web` | `pnpm-lock.yaml` + `node_modules/.pnpm/` + `.modules.yaml`（`hoistPattern: ["*"]`） | **pnpm**，且 hoisted 布局 |
| DSH checkout | `package.json` 的 `"packageManager": "pnpm@11.7.0"` | **pnpm**（Corepack） |

- hoisted 布局正是 profile 内出现**真实目录**（25 个）的成因 ⇒ 与第 3.2 / 第 4 节的 `isHealthyLink` 直接相关。
- `~/.dsh/dsh-harness` 是**指向** `/Users/eric/Project/tests/deepseek-harness` 的符号链接（同一个 checkout，0.1.5-rc.2），两个路径等价。

**④ 被 PM 清空后的恢复与验证**：重跑 ② 的 build.sh，然后从 fork 实路径验解析（这三个必须 OK）：
`cordis` · `schemastery` · `@deepseek-ai/dsh-tools`（`@deepseek-ai/cordis` 本来就 MODULE_NOT_FOUND，见第 3.2 节）。

## 6. 已评估不吸收（只追加，记理由，避免下轮重复评估）

| 项 | 不吸收理由 | 什么条件下重新评估 |
|---|---|---|
| prepare 构建后脱敏 + `node --check` | 只影响对外发布的 tgz；本 fork 只在本机用 | 一旦决定发布 tgz / 对外分发 |
| build.sh 的 @types/node 存在性防御 | 本 fork 已 link；只在本机 checkout 构建 | 换机器或上 CI 构建 |
| 上游 src/client 整份版本 | 本 fork 版本更全（React 契约 + locale + 双行） | 上游发布真正重构过的 client |
| 上游 8 个 sync 提交的整文件 CRLF 重写 | 内容等价、无功能变化 | — |
| 把 `DSH_CHECKOUT=/Users/eric/...` 写死进 package.json 的 script | 个人绝对路径进 git；`VAR=… cmd` 是 POSIX 语法，Windows 的 cmd.exe 会报错 | 若改用「脚本自探测」或「shell 环境变量」这两种不写死路径的做法，可重新评估（后者零仓库改动：`~/.zshrc` 里 `export DSH_CHECKOUT=…`） |

## 7. 何时放弃本 fork、改回跟随上游

三条同时成立才重新评估（截至 2026-09-28，第 ① 条已明确为否）：

① standalone 开始合外部 PR，并发出含第 3.2 节「抄」项的 tag
   —— 实测：17 个 PR、**0 个被合并**；连维护者自己的 LICENSE PR 也是 closed 未合，
   standalone HEAD 至今没有 LICENSE 文件；本 fork 移植的 #5/#6/#11/#12/#20 全部仍 open（已 5 周）。
   真正合 PR 的是姊妹仓库 dsh-routing-suite（#65/#76/#87 已合）。
② 该 tag 覆盖第 3.2 节所有「抄」项。
③ 第 4 节的独有补丁缩到 ≤2 条，且都不影响行为。
