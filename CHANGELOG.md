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

## [0.1.1] — 2026-08-13

### 修复

- `dev_stage_demote` 无法注销已转正工具：`dev_stage_promote` 注册改挂 `ctx.effect` 并保存 disposer，demote 时真正从正式工具集注销（此前只删 staging 条目，正式注册残留）
- `purgeCache` 防御：loader.internal 缺失时安全跳过（不再非空断言炸 inject 路径）
- registry 原子写（tmp + rename）：中断不残留半截 JSON 毒化自动恢复

### 优化

- `dev_inject_plugin` dir 参数必填 + 空值兜底报错
- `hasActiveEntry` fiber 状态魔数（2）改为语义常量（FIBER_NAMES 反查 'active'）
- 预防正式版：peerDeps 放宽（`@deepseek-ai/dsh-tools >=0.0.1-rc <2`、`cordis >=4.0.0-rc <5`）
- 文档：README 新增「生态定位：官方之下的运行时标准层」章节

## [0.2.2] — 2026-08-13

### 新增

- **INSTALL.md 傻瓜式安装手册**：Release 包 / git / 手动 patch 三方式 + 验证 + 10 行排查表 + 卸载回滚小节 + Windows（Git Bash/cmd 双语法）说明 + 版本号占位（`<版本>` 不写死）
- **`[injected]` 标记**：`dev_plugin_status` 对运行时注入的插件标注（与 bundle 装配区分，hash id 不再难认）
- **`dev_self_test` 热重载自包含**：重载自检插件自身（固定 specifier + 固定目录，缓存一致），不再依赖环境里的外部插件（如 engram）

### 优化

- `dev_self_test` 预期拒绝场景（节流/预检拦截）改 `[EXPECTED]` 前缀——计入 PASS，不再误导新手
- client 状态区分：无 client 声明 → `client 跳过（属预期）`；有声明注册失败 → 真 `✗` + 诊断指引
- `dev_uninject_plugin` 描述补"另写 profile patch disabled 条目（防 include.refresh 加回）"，与实测行为一致
- 引导提示词补一行从零体验路径（dev_plugin_status → dev_self_test → dev_scaffold_plugin → dev_build_plugin → dev_inject_plugin → dev_uninject_plugin）

### 修复

- 注入 junction 悬空重建：`existsSync` 对悬空 junction 返回 false（跟随目标）导致 symlink EEXIST——改 `lstatSync` 判断链接存在 + `rmSync` 删除重建
- `uninject` 幂等：已存在同名 disabled 条目时跳过（此前重复卸载会累积 patch 条目）
- 自检 patch 清理：列表存在时不再追加 `[]`（防双顶层值回归）

### 质量

- 零上下文 subagent 三轮评测闭环：9/10 → 9.5/10 → **10/10**（七条 polish 全部落地 + 8/8 回归连续通过）

## [0.2.1] — 2026-08-13

### 优化

- `dev_self_test` 预期拒绝场景改 `[EXPECTED]` 前缀（不误导新手）
- client 状态区分「无声明（预期跳过）」与「有声明注册失败（真 ✗ + 诊断指引）」
- 引导提示词补从零体验路径一行

## [0.2.0] — 2026-08-13

### 新增

- **插件生产线三件套**：
  - `dev_scaffold_plugin`：四种形态骨架（toolkit 工具包 / daemon-loop 守护循环(timer+LLM) / ui-panel UI 面板 / hybrid 混合）——peerDeps 范围声明、ctx.effect 规范、build.sh 模板（DSH_CHECKOUT 自动探测）
  - `dev_build_plugin`：探测 checkout → tsc + tsdown（client）+ npm pack → tgz
  - `dev_release_plugin`：gh release create + tag + tgz 附件 + notes 模板
- **`dev_self_test` 一键回归**：注入 → 热重载 → 自重载节流 → 预检拦截 → 卸载即净 → patch 合法性，8 项全自动、自恢复无污染
- **patch 写入守卫 `writePatch`**：统一 profile patch 写入（顶层 `[]` 兼容 + 幂等），杜绝 YAML 双顶层值
- **审计日志轮转**：self-heal.log 超 1MB 自动滚动（保留 2 代）
- **操作统计落盘**：`stats.json` 跨重启累计（dev_plugin_status 显示历史成功率）
- **官方 entry 仲裁**：幽灵 entry 压制官方（disabled）时自动清理恢复（kill-zombie 自动化）
- **README 插件开发指南**：「30 行写一个会思考的插件」+ 规范铁律 + 生态借鉴

### 优化

- watch 指纹轻量化：只扫 `.js`（跳过 .map/.d.ts，stat 开销省 50%+）
- 引导提示词：静态到头（order -90）动态到尾（消息尾）缓存原则注释化

### 修复

- junction 悬空检测（inject 复用悬空链接 → import ENOENT）
- `uninject` 幂等缺失（重复卸载累积 patch 条目）

## 未发布

- 见 [README.md](./README.md) 与仓库提交历史
