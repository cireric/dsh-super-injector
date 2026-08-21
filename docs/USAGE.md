# dsh-super-injector 使用指南

> 面向普通使用者的入门手册，尽量说人话。
> 想了解底层实现、设计原理和源码契约，请看 [SPEC.md](./SPEC.md)；
> 完整特性与开发细节请看项目根目录的 `README.md`。

## 这是什么？

一句话：**给 DSH（DeepSeek Harness）"现场装插件"的工具。**

玩过《上古卷轴》的朋友可以把 DSH 比作游戏本体，把插件比作 Mod（模组）：

- 官方装 Mod 的方式是走"启动器"（配置文件 + 重启），装一次要重启一次，挺麻烦；
- 这个插件就是一个"Mod 管理器"，**不用重启、不用改官方配置**，把做好的插件包直接"塞"进正在运行的 DSH 里，立刻生效。

再直白一点：你不需要懂任何底层技术，只需要**用大白话告诉 AI 你想干什么**，剩下的事 AI 会调用本插件的工具帮你完成。

## 为什么需要它？

没有它的时候，装一个插件通常要：下载 → 解压 → 改配置文件 → 重启 DSH → 出问题再改再重启。

有了它之后：

- ✅ 装插件：一句话，当场生效；
- ✅ 改插件：改完代码自动重载，约 1.5 秒生效，不用重启；
- ✅ 卸插件：一句话，清理得干干净净；
- ✅ 重启不丢：装过的插件有清单记录，DSH 重启后自动恢复；
- ✅ 出问题能自愈：路由残留、链接断裂、配置重复等常见毛病，一句话修复。

## 快速开始（安装）

> 不管用哪种方式装，**只需要装这一次**。装好之后，以后所有插件都用"对 AI 说一句话"的方式动态加载，不用再碰官方配置。

### 方式 A：下载安装包（最省事，推荐）

1. 从 [Releases 页面](https://github.com/cireric/dsh-super-injector/releases) 下载 `dsh-external-dsh-super-injector-<版本>.tgz`；
2. 解压，得到一个包含 `lib/` 文件夹的插件目录；
3. 在命令行执行：

   ```bash
   dsh plugin --profile web add <解压出来的目录>
   ```

   想不重启、直接在运行时注入也行——对 AI 说：`dev_inject_plugin <解压目录>`（需要环境里已经有一个常驻的注入器）。

### 方式 B：从源码 clone + 构建安装（想自己改代码时）

```bash
# 1. 克隆代码
git clone git@github.com:cireric/dsh-super-injector.git
cd dsh-super-injector

# 2. 安装依赖（本仓库用 npm，不是 pnpm）
npm install

# 3. 构建（三步，缺一不可）
#    ① 先准备一个 DSH 源码 checkout，并把它告诉构建脚本（脚本强依赖，缺了会直接报错退出）
export DSH_CHECKOUT=/你的/DSH源码/checkout路径   # 需包含 packages/ 与 vendor/
#    ② 编译宿主（host）部分
bash scripts/build.sh
#    ③ 编译客户端 UI 部分（tsdown 自包含打包，产出 lib/index.js + lib/client.js。
#       想要走官方 dsh plugin add 装配，这一步「必须」跑——只有它打出的包对外零依赖，
#       官方 loader 才能正常加载）

npm run build:client

# 4. 装配到 profile
dsh plugin --profile web add <dsh-super-injector目录>
```

装完记得**重启 DSH web 进程**，然后向 AI 说一句 `dev_plugin_status`——能看到 `dsh-super-injector`（状态 active）即装成功；想更彻底就再跑一次 `dev_self_test`，8 项全部 PASS 说明环境和注入器都健康。

> ⚠️ 为什么第 2 步不是 `pnpm install`？本仓库用的是 npm（只有 `package-lock.json`，没有 `pnpm-lock.yaml`，package.json 也未声明 pnpm）。且 `npm install` 只装开发依赖；真正运行时要用的 `@deepseek-ai/dsh-tools`、`cordis` 等，是由 `scripts/build.sh` 从你的 DSH checkout 里链接进来/打进产物，不靠 `install` 装。
>
> 💡 想免 DSH checkout？`npm run prepare`（`scripts/prepare.mjs`）用本地 tsdown 也能打出自包含 `lib/index.js` + `lib/client.js`（tsdown 缺失时 `npx` 临时拉取），适合快速改码验证；但它不走 `build.sh` 的 tsc，不产 `lib/types`，正式装配/发布仍建议走完整链路（`build.sh` + `build:client`）。

### 方式 C：git 直接装配（免本地构建）

```bash
dsh plugin --profile web add github:cireric/dsh-super-injector
```

> 走这条取的是源码仓库（不含 `lib/`），但包内 `prepare` 钩子会在安装阶段自动用 tsdown 构建自包含 `lib/`（本地 tsdown 优先，缺失则 `npx` 临时拉取，之后走本地缓存）——**不需要 DSH checkout**，只需 bash + node + npm。若构建失败，改用方式 A 的 Release tgz（预构建产物）。

### 方式 D：手写配置（懂一点配置时用）

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，加一段：

```yaml
- insert:
    - id: dsh-super-injector
      name: '@dsh-external/dsh-super-injector'
      config: {}
```

> 同 id 条目只允许一条，重复手动粘贴会触发启动崩溃（`duplicate loader entry id`）；若出问题用 `dev_fix_patch` 修复。

## 怎么用？——全靠对 AI 说一句话

本插件的所有功能都做成了 AI 能直接调用的工具（名字以 `dev_` 开头）。你不需要自己敲命令，只要对 AI 说人话，AI 就会调用对应的工具。

下面每一节都给出"你说什么 → AI 干什么"的对照。

### 装一个现成的插件（最常用）

> 我拿到一个插件包（解压好的目录，里面有 `package.json` 和 `lib/`），想装进 DSH。

对 AI 说：

> 用 `dev_inject_plugin` 把 `D:/dev/xxx-plugin` 这个插件包注入进来。

AI 会完成：链接插件包 → 动态加载 → 双项自检（后台工具 ✓ / 界面 UI ✓）→ 告诉你结果。**装完立刻生效**，不需要重启。

### 看看现在装了哪些插件

对 AI 说：

> 列一下当前装配了哪些插件（`dev_plugin_status`），以及注入清单（`dev_injected_list`）。

### 卸载一个插件

对 AI 说：

> 用 `dev_uninject_plugin` 把 `xxx` 卸载掉（参数：包名的一部分就行）。

AI 会清理掉这个插件的所有痕迹（工具、监听、路由、界面），同样不用重启。

### 改代码后让插件生效（开发时）

> 我改动了插件源码并重新构建了，想让新代码生效。

对 AI 说：

> 用 `dev_reload_package` 热重载 `xxx`。

AI 会：清缓存 → 重新加载 → 重建插件 → 报告前后状态对比。如果加载失败，**会自动回滚**保留旧版本，不会让你停留在一个坏状态。

### 开发时先"试水"再"转正"（进阶但很有用）

想测试一个新写的工具，又不想正式注册影响整个系统？可以把工具先挂到"后侧"（staging 区）：

1. `dev_stage_add` —— 把测试工具挂到后侧，不进正式工具列表、不污染缓存；
2. `dev_stage_call` —— 调用它测试；
3. `dev_stage_list` —— 查看后侧工具清单；
4. 测试 OK 后 `dev_stage_promote` —— 一键转正（正式注册）；
5. 不满意就 `dev_stage_demote` —— 直接丢弃/撤销。

对 AI 说"把这个工具先挂到 staging 测一下，没问题再转正"即可，AI 会自己走完这套流程。

## 工具速查表（人话版）

| 工具 | 一句话说明 |
|---|---|
| `dev_inject_plugin` | 现场装插件（动态注入，不重启） |
| `dev_install_package` | 正式装配插件（写进配置，重启后由官方机制接管；开发/生产通用） |
| `dev_uninject_plugin` | 一键卸载插件，清理干净（`self=true` 可自举卸载注入器自身） |
| `dev_injected_list` | 列出已注入的插件清单 |
| `dev_plugin_status` | 查看当前已装配插件 + 运行状态 + 成功率统计 |
| `dev_reload_package` | 热重载某个插件（改代码后刷新，失败自动回滚） |
| `dev_reload_preset` | 预设热更新：改预设代码后新会话直接生效，已运行会话保持旧代 |
| `dev_clear_routes` | 路由自愈：清除热重载残留的"孤儿路由"，无需重启 |
| `dev_heal_links` | 链接自愈：重建断掉的插件链接（junction），免重启 |
| `dev_fix_patch` | 配置修复：清理重复的配置条目（防止启动崩溃），可先 `--check` 只查不改 |
| `dev_stage_add` / `dev_stage_call` / `dev_stage_list` | 开发侧挂：把工具挂"后侧"测试，不进正式列表 |
| `dev_stage_promote` / `dev_stage_demote` | 侧挂工具一键转正 / 撤回 |
| `dev_scaffold_plugin` | 一键生成新插件骨架（四种形态：工具包 / 守护循环 / UI 面板 / 混合） |
| `dev_build_plugin` | 一键构建打包插件（产出 tgz 安装包） |
| `dev_release_plugin` | 一键发布插件到 GitHub Release |
| `dev_self_test` | 全链路自检：验证注入/重载/卸载等功能都没退化 |

> 记不住没关系：**你不需要记住任何工具名**，把需求说给 AI 就行。

## 典型场景：三分钟走一遍

### 场景 1：装一个别人做好的插件

1. 下载插件包并解压；
2. 对 AI 说："把 `/path/to/plugin` 注入进来"；
3. AI 报告 `host ✓ / client ✓` 即成功，插件当场可用。

### 场景 2：自己从零做一个插件

1. 对 AI 说："用 `dev_scaffold_plugin` 在 `D:/dev/my-plugin` 生成一个 xx 形态（比如工具包）的插件骨架"；
2. 对 AI 说："用 `dev_build_plugin` 构建"；
3. 对 AI 说："用 `dev_inject_plugin` 注入" —— **注入即生效**；
4. 之后每次改完代码 → 构建，约 1.5 秒自动重载；
5. 成熟了想发布：对 AI 说 "用 `dev_release_plugin` 发布 v0.1.0"。

### 场景 3：装完发现不对劲，想卸

对 AI 说："把 `xxx` 卸载掉"。AI 会把它彻底清理，然后你可以换个版本再装，或继续排查。

## 常见问题（FAQ）

**Q：装插件会影响 DSH 本身的稳定性吗？**
A：设计上做了多重保护：加载失败自动回滚（保留旧版本）、防重复安装、残留自动清理。装完每次操作都会做双项自检（host ✓ / client ✓），出问题会明明白白告诉你，而不是悄悄失败。

**Q：重启 DSH 之后，装过的插件还在吗？**
A：在。注入清单会持久化保存，重启后自动归位。唯一例外是"只注入未正式装配"的插件——它们的恢复依赖注入器本身常驻（引导器，装一次就常驻）。

**Q：热重载报错 `duplicate / already registered` 怎么办？**
A：这说明该插件有资源是"裸注册"的（没挂 `ctx.effect`）。规范的插件注册资源都会挂 `ctx.effect`，热重载才能正确清理重建。这是插件写法问题，不是注入器问题。

**Q：插件装到一半失败了，还能重试吗？**
A：能。失败残留会自动清理，重试不会踩到上次失败的坑。如果反复失败，可以先跑一次 `dev_self_test` 自检，确认注入器本身健康。

**Q：界面（UI）形态的插件装完怎么不显示？**
A：确认插件做了两步构建（host 侧 + client 侧，产物必须是 `lib/client.js`）。只构建了后台部分、没有 client 产物的插件不会有界面。

**Q：我不小心把配置改坏了 / 重复配置导致启动崩溃？**
A：对 AI 说"用 `dev_fix_patch` 修复一下配置"（可先带 `--check` 只查不改）。它会自动去重并备份原文件。
链接异常时则说"用 `dev_heal_links` 重建链接"。

**Q：担心装的东西不安全？**
A：本插件注入的是标准插件包（`package.json` + `lib/`），格式就是官方插件格式，行为与官方装配一致；且全部操作可逆——卸载即净、失败回滚。发布新插件建议先走 `dev_self_test` 自检全链路。

## 更多资料

- [README.md](../README.md) —— 完整特性、开发指南、踩坑记录（本指南的"进阶版"）
- [SPEC.md](./SPEC.md) —— 设计契约与源码语义（给想深入研究的开发者）
- [Changelog](../CHANGELOG.md) —— 版本更新记录
- [INSTALL.md](../INSTALL.md) —— 安装过程详细说明