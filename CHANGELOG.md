# Changelog

本项目版本与仓库提交对应，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] — 2026-08-12

### 新增

- **超级模组注入器**：运行时注入任意本地 DSH 插件包（junction 链接 + `loader.create`，不碰 patch / package.json / bundles 列表、不重启进程），注入清单自动恢复（`~/.dsh/super-injector/registry.json`）
- **热重载全家桶**（融合 dsh-bundle-hmr）：`dev_reload_package` 整包重载（清缓存 → 重新 import → 重建 fiber，失败回滚保留旧代）、`dev_plugin_status` 装配清单、`dev_install_package` 双路径安装（profile package.json + junction + loader.create）
- **卸载器**：`dev_uninject_plugin` 卸 loader entry（fiber dispose 全清理）→ 清注入清单 → 删 junction，免重启；引导器自身受保护不可卸载
- **路由残留自愈**：`dev_clear_routes` 直捣 webserver 内部路由表（exact/prefixes/upgrades），按 path 前缀删除孤儿路由，插件热重载残留 `duplicate route` 免重启即可清除
- **强制登记守卫**：`reloadPackage` 重建失败若报 `duplicate / already registered` → 判定未登记裸注册 → 明确报错（要求插件把资源注册挂 `ctx.effect`）+ 自动清理残留路由
- **开发侧挂区（staging）**：测试/开发工具挂"后侧"不进 tools schema（缓存零污染），`dev_stage_call` 测试、`dev_stage_promote` 一键转正（唯一一次缓存刷新）、`dev_stage_demote` 撤回——杜绝开发期工具波动打穿 DeepSeek 前缀缓存

### 优化

- **注入缓存友好化**：注入文本固定 + order 9998 尾部化（参考官方 system prompt 设计），移除 llm/stream 动态旁路——system 前缀恒定，缓存命中不再受注入波动影响

### 修复

- `getOuterStack is not a function`：`registry.plugin` 第三参必须是函数（`() => []`），双路径修正
- 工具 schema 兜底 + `safeRegister` 冲突容忍（同名工具跳过注册而非崩溃）
- 注入防重改权威判断（`hasActiveEntry`）+ 失败残留清理

## 未发布

- 见 [README.md](./README.md) 与仓库提交历史
