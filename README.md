# dsh-super-injector — 超级模组注入器

DSH 生态的 **BepInEx 式模组注入入口**：运行时把任意本地插件包注入运行中的 web，不碰
patch / package.json / bundles 列表、不重启进程。

> 灵感：官方装配机制（profile bundle / repository-plugin）是唯一的"官方入口"，
> 就像游戏只有启动器能装模组。本插件打破这一点——注入器（引导器）走官方入口装
> 一次，之后**万物皆可运行时注入**。

## 机制

1. **junction 链接**插件包到 `~/.dsh/profiles/web/node_modules`（loader 标准解析路径）；
2. **`ctx.loader.create({ name, config })`** 运行时装配（完整 ctx，已验证）；
3. **清单持久化**（`~/.dsh/super-injector/registry.json`），web 重启后**自动恢复**注入。

## 用法

```sh
# 引导器装配（只需一次，patch 热更新即时生效）
# 在 ~/.dsh/profiles/web/cordis.patch.yml 加：
# - insert:
#     - id: dsh-super-injector
#       name: '@dsh-external/dsh-super-injector'

# 之后任意超级模组：
# 1. 写好插件（src/ + package.json + lib/ 产物）
# 2. 对 AI 说：dev_inject_plugin（参数 = 插件包目录绝对路径）
# 3. 当场生效，无需重启；改代码可用 dsh-bundle-hmr 热重载
```

## 工具

- `dev_inject_plugin` — 注入本地插件包（防重复，已加载自动跳过）
- `dev_injected_list` — 列出注入清单

## 边界

- 注入的插件不进 loader 配置持久化——重启后由注入器自动恢复（引导器常驻）；
- 与官方装配的插件同进程共存，隔离性同官方插件；
- 私有内测项目。
