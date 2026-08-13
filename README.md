# dsh-super-injector — 超级模组注入器

DSH 生态的 **BepInEx 式模组注入入口**：运行时把任意本地插件包注入运行中的 web，
不碰 patch / package.json / bundles 列表、不重启进程。**注入即完整生效（host 工具 + client UI）。**

> 灵感：官方装配机制（profile bundle / repository-plugin）是唯一的"官方入口"，就像游戏
> 只有启动器能装模组。本插件打破这一点——引导器走官方入口装一次，之后**万物皆可运行时注入**。

## 安装（三选一）

### 方式 A：Release 包（推荐，免构建）

从 [Releases](https://github.com/yjh051108/dsh-super-injector/releases) 下载
`dsh-external-dsh-super-injector-0.0.1.tgz`，解压得到插件目录（含 `lib/` 与 `cordis.patch.yml`），然后：

```bash
# 官方装配（重启后由 bundles 接管，生产态）
dsh plugin --profile web add <解压目录>

# 或运行时注入（免重启，开发态；需任一环境已常驻注入器）
# 对 AI 说：dev_inject_plugin <解压目录>
```

### 方式 B：git 装配

```bash
dsh plugin --profile web add github:yjh051108/dsh-super-injector
```

### 方式 C：引导装配（源码方式，只需一次）

在 `~/.dsh/profiles/web/cordis.patch.yml` 添加：

```yaml
- insert:
    - id: dsh-super-injector
      name: '@yjh051108/dsh-super-injector'
      config: {}
```

引导器常驻后，任意超级模组随取随用，无需再碰官方配置。

## 兼容性

- **不硬编码 DSH 版本**：peerDependencies 全部为范围声明
  （`@deepseek-ai/dsh-tools: >=0.0.1-rc <2`、`cordis: >=4.0.0-rc <5`）——DSH 升级不报废。
- 已适配服务改名：`webServer`（原 httpServer）、`compaction`（原 compact）。

## 特性

- 🔥 **热重载 + 自重载**：`dev_reload_package` 整包重载（清缓存 → 重新 import → 重建 fiber，失败回滚保留旧代）；注入器自身也支持自重载（自杀 → 全局定时器重建）
- 🤖 **自动 watch**：注入即自动监听插件目录，改代码 build 后约 1.5 秒自动重载（无需手动触发）
- 🖥️ **注入插件 UI 完整生效**：清除 loader 幽灵 entry 隔离（normalizeEntry），client 模块补扫/联动/卸载清理——注入的插件 host 工具 + 图谱/面板等 UI 全部可用
- 🧪 **开发侧挂区（staging）+ 持久化**：测试工具挂"后侧"不进 tools schema、缓存零污染；`dev_stage_promote` 一键转正；staging 落盘，**自重载/重启后转正工具自动恢复**
- 🧹 **一键卸载**：`dev_uninject_plugin` fiber 全清理（工具/监听/路由/client 表）→ 清注入清单 → 删 junction，免重启
- 🛠️ **路由自愈**：`dev_clear_routes` 直捣 webserver 内部路由表，热重载残留的孤儿路由免重启清除
- 🔁 **重启自动恢复**：注入清单持久化（`~/.dsh/super-injector/registry.json`），web 重启后自动归位
- 📊 **操作自检**：每次注入/重载/安装返回 `host ✓ / client ✓` 双验证；`dev_plugin_status` 含操作成功率统计
- 🛡️ **失败可重试**：`hasActiveEntry` 权威防重 + 失败残留缓存自动清理 + 残留 entry 自动清理

## 与 dsh-evolve 的定位差异（生态互补）

| | dsh-evolve | dsh-super-injector |
|---|---|---|
| 形态 | **创造模式**：agent 现场写单文件插件源码（`~/.dsh/evolve/<name>.mjs`）热挂载 | **手术台**：注入开发者预构建的**完整插件包**（package.json + lib/） |
| 适用 | agent 随对话长出小工具（记账/天气/周报） | 装/换成品模组、自主开发闭环（写 → build → 注入 → 热重载） |
| 联动 | evolve 长出的源码可升级为完整包，再走注入器上膛 | 注入后可被 `dev_reload_package` 热重载 |

## 生态定位：官方之下的运行时标准层

官方对插件体系的方向（2026-07 agent notes）：

1. **否决安装命令 + 安装数据库 + marketplace**——持久化插件只有一种状态：**配置**（cordis.patch.yml / profile bundles / repositories），事务性 HMR 对账；
2. **agent 自己管理运行时**——自指 cordis 工具集，运行时归 agent 管。

翻译：官方钦定"**装什么**"（bundle / repository + 配置），但"**装完之后怎么改**"——热重载、侧挂测试、一键转正、卸载、失败自愈——是官方留白。**这一整块运行时管理面，由本插件吃下。**

| 生态入口 | 层 | 一句话分工 |
|---|---|---|
| 官方 bundle / repository | 装配层 | 唯一官方入口，配置即状态 |
| plugin-registry | 官方薄控制台 | 官方格式插件管理与开发引导 |
| marisa | agent 面工具链 | 临时插件 → 持久化插件的固化桥 |
| mygo | 受管对象层 | 插件生命周期对象化（锁定/启停/依赖图） |
| dsh-evolve | 创造模式 | agent 现场长出单文件能力 |
| **dsh-super-injector** | **运行时手术台** | **开发闭环全家桶：注入 / 热重载 / 侧挂转正 / 卸载 / 路由自愈 / UI 联动** |

**设计原则**：

1. **不发明协议**：注入的是标准插件包（package.json + lib/），格式就是官方包格式，装上即官方语义；
2. **双路径，尊重"配置唯一"**：运行时注入（免重启，开发态）↔ `dev_install_package` 落 profile bundles（重启后由官方接管，生产态）——注入清单只是**运行时恢复缓存**，不是第二安装数据库；
3. **模型可驱动**：dev_* 全是工具，agent 自己注入/卸载/转正——正踩在官方"agent 自己管理运行时"的方向上；
4. **可逆且自愈**：注入可回滚（失败保旧代）、卸载即净（fiber 全清理）、残留可自愈（路由/缓存/entry 自动清理）。

**目标**：成为官方装配机制之下、生态事实标准的**运行时管理层**——"启动器装模组"只是起点，注入器让 DSH 拥有"**万物可注入、注入可回滚、改完即生效**"的 Mod 级体验。

## 工具全家桶（全部免重启）

| 工具 | 说明 |
|---|---|
| `dev_inject_plugin` | 运行时注入本地插件包（junction 链接 + loader.create，`hasActiveEntry` 防重） |
| `dev_uninject_plugin` | 一键卸载注入模组（fiber dispose 全清理；bundle 插件自动写 disabled 阻断自装配） |
| `dev_injected_list` | 列出注入清单 |
| `dev_install_package` | 热装配本地 bundle 插件（profile package.json + junction + loader.create，重启后由 bundles 列表正常装配） |
| `dev_reload_package` | 整包热重载（清缓存 → 重新 import → 重建 fiber，失败回滚保留旧代；含自重载） |
| `dev_plugin_status` | 已装配插件清单、fiber 状态与操作成功率统计 |
| `dev_clear_routes` | webserver 路由残留自愈（按 path 前缀删除孤儿路由） |
| `dev_stage_add` | 开发侧挂：测试工具挂后侧（不进 tools schema，缓存零污染） |
| `dev_stage_call` | 调用侧挂工具测试 |
| `dev_stage_list` | 列出侧挂工具（含转正状态） |
| `dev_stage_promote` | 一键转正：侧挂工具挂前侧正式注册（唯一一次缓存刷新） |
| `dev_stage_demote` | 撤回/注销侧挂或已转正工具 |

## 插件开发指南（生产线）

**哲学**：插件想长成什么样就能长成什么样——工具包 / 守护循环（timer+LLM 自主 agent loop）/ UI 面板 / 混合形态，同一注入通道；注入即完整生效（host+UI）、可热重载与自重载、卸载即净；**插件自身的提示词/工具/循环皆可自我优化**（改 → build → 重载闭环）。建新插件**优先克隆/借鉴/重构生态已有资源**（dsh-external 仓库、已注入插件、官方 packages 模式），不重复造轮子。

### 一分钟起步（生产线三件套）

```bash
# 1. 生成骨架（toolkit / daemon-loop / ui-panel / hybrid）
#    对 AI 说：dev_scaffold_plugin {"dir": "D:/dev/my-plugin", "name": "my-plugin", "form": "daemon-loop", "description": "..."}

# 2. 构建打包（探测 DSH_CHECKOUT → tsc host → tsdown client（如声明）→ npm pack → tgz）
#    对 AI 说：dev_build_plugin {"dir": "D:/dev/my-plugin"}

# 3. 发布（gh release create v<version> + tgz）
#    对 AI 说：dev_release_plugin {"dir": "D:/dev/my-plugin", "version": "0.1.0"}

# 注入即活：dev_inject_plugin {"dir": "D:/dev/my-plugin"}
# 改代码 → build → 自动 watch ~1.5s 重载（或 dev_reload_package）
```

### 30 行写一个"会思考的插件"（守护循环最小示例）

```ts
import type { Context } from 'cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

type AppContext = Context & { llm: LlmService; setInterval(fn: () => void, ms: number): any }

export const name = 'my-daemon'
export const inject = ['timer', 'llm']

export function apply(ctx: AppContext): void {
  let route: { provider: string; model: string } | null = null
  ctx.on('llm/stream', (options, next) => { route = { provider: options.provider, model: options.model }; return next() })
  ctx.setInterval(() => {
    void (async () => {
      if (!route) return
      const stream = ctx.llm.stream({
        provider: route.provider, model: route.model,
        system: '判断是否需要人工介入，直接输出结论',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '检查事项...' }] })],
        reasoningEffort: ReasoningEffortId('off'), maxTokens: 200,
      })
      for await (const chunk of stream) { /* 决策 → 行动 */ }
    })().catch(() => {})
  }, 60_000)
}
```

**规范铁律**（注入器实测沉淀）：
1. **资源注册必须挂 `ctx.effect`**（工具/路由/监听）——热重载/卸载才能自动清理，否则僵尸残留（注入器自己踩过）
2. **peerDependencies 用范围声明**（`>=0.0.1-rc <2`、`>=4.0.0-rc <5`）——不硬编码版本，DSH 升级不报废
3. **client bundle 需单独构建**（tsdown → lib/client.js）——UI 形态两步构建
4. **提示词注入遵守缓存原则**：静态文本 + order 靠前（静态到头）；动态内容走消息尾（动态到尾）；严禁动态拼接进 system
5. **自检**：改完代码跑一次 `dev_self_test`，确保注入/重载/自重载/预检/卸载全链路不退化

## 典型工作流

**装模组**：拿到插件包（package.json + lib/ 产物）→ 对 AI 说 `dev_inject_plugin`（参数 = 插件包绝对路径）→ 当场生效（下一 step 工具可见）。

**开发迭代**：改代码 → build → 自动 watch 约 1.5 秒自动重载（或 `dev_reload_package`）→ 验证 → 稳定后 `dev_stage_promote` 一键转正。

**卸载**：`dev_uninject_plugin`（参数 = 包名子串）→ 工具/监听/路由/client 表全清，免重启。

## 机制

1. **junction 链接**插件包到 `~/.dsh/profiles/web/node_modules`（loader 标准解析路径）；
2. **`ctx.loader.create({ name, config })`** 运行时装配（完整 ctx）；
3. **清单持久化**（`~/.dsh/super-injector/registry.json`），重启后自动恢复注入；
4. **client 联动**：注入/重载后清除 entry disabled 标记并补扫 client 模块表（`client-modules.processOne`），浏览器端 bundle rev 联动更新。

## 踩坑记录

- **插件包必须自带依赖链接**：`lib/` 里 `import '@deepseek-ai/dsh-tools'` 等从包自身 `node_modules` 解析——照 build.sh 建 junction 到 checkout 包（如 `node_modules/@deepseek-ai/dsh-tools → <checkout>/packages/core/tools`）；
- **client bundle 需单独构建**：host 侧 `bash scripts/build.sh`（tsc），client 侧 `npm run build:client`（tsdown，产物 `lib/client.js`）——注入插件要出 UI 必须两步都构建；
- **失败 import 会毒化重试**：loadCache 残留残缺 job 导致同名重载复用失败态——注入前 `purgeCache` 清理；
- **资源注册必须挂 `ctx.effect`**：`reloadPackage` 重建失败若报 `duplicate / already registered`，说明资源是裸注册——挂 `ctx.effect` 后热重载才能正确清理重建；
- **client 操作必须用完整包名**：`client-modules.processOne` 对 `entry.options.name` 精确匹配，传短名会静默注册失败；
- 注入的插件不进 loader 配置持久化——重启后由注入器自动恢复（引导器常驻）。

---

**仓库**：https://github.com/yjh051108/dsh-super-injector
**Release**：https://github.com/yjh051108/dsh-super-injector/releases
