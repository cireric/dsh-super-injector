# dsh-super-injector — 超级模组注入器

DSH 生态的 **BepInEx 式模组注入入口**：运行时把任意本地插件包注入运行中的 web，
不碰 patch / package.json / bundles 列表、不重启进程。

> 灵感：官方装配机制（profile bundle / repository-plugin）是唯一的"官方入口"，就像游戏
> 只有启动器能装模组。本插件打破这一点——引导器走官方入口装一次，之后**万物皆可运行时注入**。

## 特性

- 🔥 **热重载**：写 → build → 注入 → 下一 step 工具即见；`dev_reload_package` 整包重载（清缓存 → 重新 import → 重建 fiber），改代码约 1.5 秒自动生效，失败自动回滚保留旧代
- 🧪 **开发侧挂区（staging）**：测试工具挂"后侧"不进 tools schema、缓存零污染；`dev_stage_call` 测试、`dev_stage_promote` 一键转正、`dev_stage_demote` 撤回
- 🧹 **一键卸载**：`dev_uninject_plugin` fiber 全清理（工具/监听/路由）→ 清注入清单 → 删 junction，免重启；卸载 bundle 插件自动在 profile patch 写 disabled 阻断自装配
- 🛠️ **路由自愈**：`dev_clear_routes` 直捣 webserver 内部路由表，热重载残留的孤儿路由免重启清除
- 🔁 **重启自动恢复**：注入清单持久化（`~/.dsh/super-injector/registry.json`），web 重启后自动归位，不用重装
- 🛡️ **失败可重试**：`hasActiveEntry` 权威防重 + 失败残留缓存自动清理；强制登记守卫拦截裸注册

## 与 dsh-evolve 的定位差异（生态互补）

| | dsh-evolve | dsh-super-injector |
|---|---|---|
| 形态 | **创造模式**：agent 现场写单文件插件源码（`~/.dsh/evolve/<name>.mjs`）热挂载 | **手术台**：注入开发者预构建的**完整插件包**（package.json + lib/） |
| 适用 | agent 随对话长出小工具（记账/天气/周报） | 装/换成品模组、自主开发闭环（写 → build → 注入 → 热重载） |
| 联动 | evolve 长出的源码可升级为完整包，再走注入器上膛 | 注入后可被 `dev_reload_package` 热重载 |

## 引导装配（只需一次）

在 `~/.dsh/profiles/web/cordis.patch.yml` 添加：

```yaml
- insert:
    - id: dsh-super-injector
      name: '@dsh-external/dsh-super-injector'
      config: {}
```

引导器常驻后，任意超级模组随取随用，无需再碰官方配置。

## 工具全家桶（全部免重启）

| 工具 | 说明 |
|---|---|
| `dev_inject_plugin` | 运行时注入本地插件包（junction 链接 + loader.create，`hasActiveEntry` 防重） |
| `dev_uninject_plugin` | 一键卸载注入模组（fiber dispose 全清理；bundle 插件自动写 disabled 阻断自装配） |
| `dev_injected_list` | 列出注入清单 |
| `dev_install_package` | 热装配本地 bundle 插件（profile package.json + junction + loader.create，重启后由 bundles 列表正常装配） |
| `dev_reload_package` | 整包热重载（清缓存 → 重新 import → 重建 fiber，失败回滚保留旧代） |
| `dev_plugin_status` | 已装配插件清单与 fiber 状态 |
| `dev_clear_routes` | webserver 路由残留自愈（按 path 前缀删除孤儿路由） |
| `dev_stage_add` | 开发侧挂：测试工具挂后侧（不进 tools schema，缓存零污染） |
| `dev_stage_call` | 调用侧挂工具测试 |
| `dev_stage_list` | 列出侧挂工具（含转正状态） |
| `dev_stage_promote` | 一键转正：侧挂工具挂前侧正式注册（唯一一次缓存刷新） |
| `dev_stage_demote` | 撤回/注销侧挂或已转正工具 |

## 典型工作流

**装模组**：写好插件包（package.json + lib/ 产物）→ 对 AI 说 `dev_inject_plugin`（参数 = 插件包绝对路径）→ 当场生效（下一 step 工具可见）。

**开发迭代**：改代码 → `dev_reload_package` 热重载（约 1.5 秒生效）→ 验证 → 稳定后 `dev_stage_promote` 一键转正。

**卸载**：`dev_uninject_plugin`（参数 = 包名子串）→ 工具/监听/路由全清，免重启。

## 机制

1. **junction 链接**插件包到 `~/.dsh/profiles/web/node_modules`（loader 标准解析路径）；
2. **`ctx.loader.create({ name, config })`** 运行时装配（完整 ctx）；
3. **清单持久化**（`~/.dsh/super-injector/registry.json`），重启后自动恢复注入。

## 踩坑记录

- **插件包必须自带依赖链接**：`lib/` 里 `import '@deepseek-ai/dsh-tools'` 等从包自身 `node_modules` 解析——照 dsh-engram-relay 的 build.sh 建 junction 到 checkout 包（如 `node_modules/@deepseek-ai/dsh-tools → <checkout>/packages/core/tools`）；
- **失败 import 会毒化重试**：loadCache 残留残缺 job 导致同名重载复用失败态——注入前 `purgeCache` 清理；
- **资源注册必须挂 `ctx.effect`**：`reloadPackage` 重建失败若报 `duplicate / already registered`，说明资源是裸注册——挂 `ctx.effect` 后热重载才能正确清理重建；
- 注入的插件不进 loader 配置持久化——重启后由注入器自动恢复（引导器常驻）；
- 私有内测项目，欢迎群内交流 🐋

---

**仓库**：https://github.com/dsh-external/dsh-super-injector
