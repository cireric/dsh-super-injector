/**
 * dsh-super-injector — 超级模组注入器 + 热重载引擎（融合 dsh-bundle-hmr）。
 *
 * DSH 生态的 BepInEx：运行时注入任意本地插件包 + 整包热重载 + 插件状态，
 * 不碰 patch/package.json（注入路径）或改 profile 双路径装配（install 路径）。
 *
 * 能力：
 *  1. dev_inject_plugin     — 运行时注入本地插件包（junction + loader.create，免持久化）
 *  2. dev_install_package   — 双路径热装配（profile package.json + junction + loader.create，重启后由 bundles 接管）
 *  3. dev_reload_package    — 确定性整包热重载（清缓存 → import → registry 重建 fiber，失败回滚）
 *  4. dev_plugin_status     — 已装配插件清单（id/name/fiber 状态/入口）
 *  5. dev_injected_list     — 注入清单（registry.json，重启自动恢复）
 *  6. 自动轮询 watch        — lib 产物指纹变化 → 自动热重载
 *  7. 智能能力提示注入       — 新会话首轮完整版 / 关键词命中简版 / 其余零注入
 *
 * 关键机制（全部实测验证）：
 *  - loadCache key 是 realpath URL（file:///F:/...，匹配用目录名子串）；
 *  - ctx.registry 是 accessor，完整 ctx 可用；重建 fiber 用 entry.options.config
 *    （避免覆盖 include.refresh 热更新的配置）；
 *  - 官方 HMR 对 bundle 插件不生效（node_modules 排除 + root:[]），本插件补上。
 */

import { Context } from 'cordis'
import type Loader from '@deepseek-ai/cordis-plugin-loader'
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

type AppContext = Context & {
  loader: Loader
  tools: ToolRegistry
  systemPrompt: SystemPrompt
  registry: any
  setInterval(fn: () => void, ms: number): any
}

export const name = 'dsh-super-injector'
export const inject = ['loader', 'timer', 'tools', 'systemPrompt']

export interface Config {
  /** 注入清单文件路径（缺省 ~/.dsh/super-injector/registry.json）。 */
  registryFile: string
  /** junction 链接目标目录（缺省 ~/.dsh/profiles/web/node_modules）。 */
  profileNodeModules: string
  /** 启动时自动恢复清单中的注入。 */
  autoRestore: boolean
  /** 轮询间隔（ms）。构建产物整批写入，间隔轮询天然合并抖动。 */
  intervalMs: number
  /** 监听目录 → 缓存匹配子串（loadCache key 是 realpath，用目录名匹配）。 */
  watches: Array<{ dir: string; match: string }>
}

export const Config = z.object({
  registryFile: z.string().default(''),
  profileNodeModules: z.string().default(''),
  autoRestore: z.boolean().default(true),
  intervalMs: z.number().default(1500),
  watches: z.array(z.object({
    dir: z.string().required(),
    match: z.string().required(),
  })).default([]),
})

interface RegistryEntry {
  dir: string
  name: string
  at: string
}

const FIBER_NAMES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']

/** 递归收集 dir 下所有 .js 的相对路径指纹（mtime + size）。 */
function fingerprintOf(dir: string): string | null {
  try {
    const parts: string[] = []
    const walk = (base: string) => {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const full = join(base, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.name.endsWith('.js')) {
          const st = statSync(full)
          parts.push(`${relative(dir, full)}:${st.mtimeMs}:${st.size}`)
        }
      }
    }
    walk(dir)
    parts.sort()
    return parts.join('|')
  } catch {
    return null
  }
}

export function apply(ctx: AppContext, config: Config): void {
  const logger = ctx.logger
  const registryFile = config.registryFile || join(homedir(), '.dsh', 'super-injector', 'registry.json')
  const profileNodeModules = config.profileNodeModules || join(homedir(), '.dsh', 'profiles', 'web', 'node_modules')
  // 热重载的 config 合并路径可能缺 schema 新字段（旧 fiber _config + patch 旧值），
  // 防御性兜底（schema 默认值只在 loader 装配时保证）。
  const intervalMs = config.intervalMs ?? 1500
  const watches = config.watches ?? []

  // ============ 注入清单 ============
  function readRegistry(): RegistryEntry[] {
    try {
      const list = JSON.parse(readFileSync(registryFile, 'utf8'))
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  function writeRegistry(list: RegistryEntry[]): void {
    mkdirSync(dirname(registryFile), { recursive: true })
    writeFileSync(registryFile, JSON.stringify(list, null, 2), 'utf8')
  }

  /** 该包是否已有 ACTIVE 的 loader entry（权威防重判断）。 */
  function hasActiveEntry(pkgName: string): boolean {
    for (const entry of ctx.loader.entries()) {
      const opts = entry.options
      if (opts.group) continue
      if (opts.name === pkgName && entry.fiber && entry.fiber.state === 2) return true
    }
    return false
  }

  /** 清除某包目录的模块缓存残留（失败 import 留下的残缺 job 会毒化重试）。 */
  function purgeCache(pkgDir: string): void {
    const key = pkgDir.replace(/\\/g, '/')
    const loadCache = ctx.loader.internal!.loadCache as Map<string, unknown>
    for (const u of [...loadCache.keys()]) {
      if (typeof u === 'string' && u.includes(key)) Map.prototype.delete.call(loadCache, u)
    }
  }

  // ============ 热重载核心 ============
  /** 整包热重载：清缓存 → import → 重建 fiber，失败回滚保留旧代。 */
  async function reloadPackage(match: string): Promise<string> {
    const internal = ctx.loader.internal
    if (!internal) return 'ERROR: loader.internal 不可用'
    const loadCache = internal.loadCache as Map<string, any>

    const urls = [...loadCache.keys()].filter(u => typeof u === 'string' && u.includes(match))
    if (!urls.length) return `INFO: 缓存中无匹配 "${match}" 的模块`
    const entryUrl = urls.find(u => u.endsWith('/lib/index.js'))
    if (!entryUrl) return `ERROR: 未找到入口 lib/index.js（匹配 ${urls.length} 个模块）`

    const oldJob = loadCache.get(entryUrl)
    const oldPlugin = ctx.loader.unwrapExports(oldJob?.module?.getNamespace())
    if (!oldPlugin) return 'ERROR: 无法从入口模块解出插件导出'
    const runtime = ctx.registry.get(oldPlugin)
    if (!runtime) return 'ERROR: registry 中无该插件 runtime'

    // 清缓存（备份以便回滚）
    const backup = new Map<string, any>()
    for (const u of urls) {
      backup.set(u, loadCache.get(u))
      Map.prototype.delete.call(loadCache, u)
    }

    // 重新 import（失败 → 恢复缓存，旧代保留）
    let fresh: any
    try {
      fresh = ctx.loader.unwrapExports(await ctx.loader.import(entryUrl, () => []))
    } catch (e) {
      for (const [u, job] of backup) loadCache.set(u, job)
      return 'ERROR: import 失败，已回滚缓存（旧代保留）: ' + (e instanceof Error ? e.stack : String(e))
    }

    // 从 loader entry 重读当前装配配置（避免用陈旧 _config 覆盖 include.refresh
    // 热更新的配置——2026-08-12 蒸馏配置被固化的根因）。entry 的 config 是 patch
    // 原始配置（可能缺 schema 默认字段），与 fallback（schema 已填充的旧配置）
    // 浅合并：旧值保底、entry 新值覆盖。找不到 entry 时回退旧配置。
    function currentConfigOf(fallback: unknown): unknown {
      try {
        for (const entry of ctx.loader.entries()) {
          const opts = entry.options as { name?: string; config?: unknown }
          if (opts?.name && String(opts.name).includes(match) && opts.config !== undefined) {
            if (typeof fallback === 'object' && fallback !== null
              && typeof opts.config === 'object' && opts.config !== null) {
              return { ...(fallback as Record<string, unknown>), ...(opts.config as Record<string, unknown>) }
            }
            return opts.config
          }
        }
      } catch {
        // 读配置失败回退
      }
      return fallback
    }

    // dispose 旧 fiber + 重建（失败 → 尝试用旧插件恢复）
    const fibers = runtime.fibers as any[]
    const failures: string[] = []
    let rebuilt = 0
    try {
      const config = currentConfigOf(fibers[0]?._config)
      ctx.registry.delete(oldPlugin)
      for (const oldFiber of fibers) {
        try {
          const fiber = oldFiber.parent.registry.plugin(fresh, config, () => [])
          fiber.entry = oldFiber.entry
          if (fiber.entry) fiber.entry.fiber = fiber
          rebuilt++
        } catch (e) {
          failures.push(String(e))
        }
      }
    } catch (e) {
      // 整体失败：回滚缓存 + 用旧插件重建
      for (const [u, job] of backup) loadCache.set(u, job)
      try {
        ctx.registry.delete(fresh)
        for (const oldFiber of fibers) {
          const fiber = oldFiber.parent.registry.plugin(oldPlugin, currentConfigOf(oldFiber._config), () => [])
          fiber.entry = oldFiber.entry
          if (fiber.entry) fiber.entry.fiber = fiber
        }
      } catch { /* 尽力而为 */ }
      return 'ERROR: 重建失败，已回滚（旧代保留）: ' + (e instanceof Error ? e.stack : String(e))
    }

    if (failures.length) {
      return `WARN: ${match} 部分重建（${rebuilt}/${fibers.length}）: ${failures.join('; ')}`
    }
    return `OK: ${match} 热重载完成（清缓存 ${urls.length} 模块，重建 ${rebuilt} fiber）`
  }

  // ============ 插件状态 ============
  /** 当前 loader 已装配插件清单（确定性信息：id/name/fiber 状态/入口）。 */
  function listPlugins(): string {
    const lines: string[] = []
    for (const entry of ctx.loader.entries()) {
      const opts = entry.options
      if (opts.group) continue
      const state = entry.fiber ? (FIBER_NAMES[entry.fiber.state] ?? `state:${entry.fiber.state}`) : 'no-fiber'
      const entryUrl = [...ctx.loader.internal!.loadCache.keys()]
        .find(u => typeof u === 'string' && u.includes(opts.id))
      lines.push(`- [${state}] ${opts.id} (${opts.name})${opts.disabled ? ' [disabled]' : ''}${entryUrl ? '\n    entry: ' + entryUrl : ''}`)
    }
    return lines.length ? lines.join('\n') : '（loader 中无已装配插件 entry）'
  }

  /** 查找匹配的 entry（id 或 name 子串）。 */
  function findEntry(match: string): any {
    for (const entry of ctx.loader.entries()) {
      const opts = entry.options
      if (opts.group) continue
      if (opts.id.includes(match) || opts.name.includes(match)) return entry
    }
    return undefined
  }

  function stateOf(entry: any): string {
    return entry.fiber ? (FIBER_NAMES[entry.fiber.state] ?? `state:${entry.fiber.state}`) : 'no-fiber'
  }

  /** 等待 fiber 稳定（active/failed），最多 timeoutMs；返回最终状态。 */
  function waitFiberStable(entry: any, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve) => {
      const check = () => {
        const st = stateOf(entry)
        if (st === 'active' || st === 'failed') { clearInterval(iv); resolve(st); return }
        if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(st + '（超时未稳定）'); return }
      }
      const start = Date.now()
      const iv = setInterval(check, 50)
      check()
    })
  }

  // ============ 注入器核心 ============
  /** 注入一个本地插件包：junction → loader.create → 记录清单。 */
  async function inject(dir: string): Promise<string> {
    const absDir = resolve(dir)
    const pkgPath = join(absDir, 'package.json')
    if (!existsSync(pkgPath)) return `ERROR: ${absDir} 下无 package.json（需要插件包目录）`
    let pkg: { name?: string }
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch (e) {
      return 'ERROR: package.json 解析失败: ' + String(e)
    }
    const pkgName = pkg.name
    if (!pkgName) return 'ERROR: package.json 缺 name'

    if (hasActiveEntry(pkgName)) return `INFO: ${pkgName} 已激活运行，跳过注入`
    purgeCache(absDir)

    // junction 链接到 profile node_modules（scoped 包需要两级目录）
    const scoped = pkgName.startsWith('@')
    const parts = scoped ? pkgName.split('/') : [pkgName]
    const linkDir = join(profileNodeModules, ...parts)
    try {
      if (!existsSync(linkDir)) {
        mkdirSync(dirname(linkDir), { recursive: true })
        symlinkSync(absDir, linkDir, 'junction')
      }
    } catch (e) {
      return `ERROR: 建立 junction 失败（${linkDir}）: ${String(e)}`
    }

    // 运行时装配
    try {
      await ctx.loader.create({ name: pkgName, config: {} })
    } catch (e) {
      return `ERROR: loader.create 失败: ${e instanceof Error ? e.stack : String(e)}`
    }

    const list = readRegistry()
    if (!list.some(e => e.dir === absDir)) {
      list.push({ dir: absDir, name: pkgName, at: new Date().toISOString() })
      writeRegistry(list)
    }
    return `OK: ${pkgName} 已注入（junction=${linkDir}，entry 已装配）`
  }

  /** 启动自动恢复：清单里的插件逐个重新注入（已加载的跳过）。 */
  async function restore(): Promise<void> {
    for (const e of readRegistry()) {
      try {
        if (hasActiveEntry(e.name)) continue
        await inject(e.dir)
        logger.info('[super-injector] 自动恢复 %s', e.name)
      } catch (err) {
        logger.warn('[super-injector] 恢复 %s 失败: %s', e.name, err instanceof Error ? err.stack : String(err))
      }
    }
  }
  if (config.autoRestore) void restore()

  // ============ 自动轮询 watch：build 产物变化 → 自动整包重载 ============
  const fingerprints = new Map<string, string>()
  let reloading = false
  ctx.setInterval(() => {
    if (reloading) return
    for (const w of watches) {
      const fp = fingerprintOf(join(w.dir, 'lib'))
      if (fp === null) continue
      const prev = fingerprints.get(w.dir)
      if (prev !== undefined && prev !== fp) {
        fingerprints.set(w.dir, fp)
        reloading = true
        reloadPackage(w.match)
          .then(r => logger.info('[super-injector] %s', r))
          .catch(e => logger.warn('[super-injector] %s', e instanceof Error ? e.stack : String(e)))
          .finally(() => { reloading = false })
        return // 一轮只处理一个包，下轮继续
      }
      fingerprints.set(w.dir, fp)
    }
  }, intervalMs)

  // ============ 工具 ============
  // 冲突容忍：bundle-hmr 未卸载的过渡期（或任何同名工具已注册）时跳过重复注册，
  // 避免 "already registered" 炸掉整个 apply；重启后由本插件独占全量工具。
  function safeRegister(tool: any): void {
    try {
      ctx.tools.register(tool)
    } catch (e) {
      logger.warn('[super-injector] 跳过冲突工具注册: %s', e instanceof Error ? e.message : String(e))
    }
  }

  safeRegister(defineTool({
    name: 'dev_inject_plugin',
    description: '超级模组注入器：运行时注入任意本地 DSH 插件包（junction 链接 + loader.create，不碰 patch/package.json、不重启）。参数 = 插件包目录绝对路径（含 package.json 与 lib/）',
    parameters: {
      dir: { type: 'string', description: '插件包目录绝对路径（如 F:/dsh/03-dev-infra/dsh-xxx）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { dir: string }) {
      return inject(args.dir)
    },
  }))

  safeRegister(defineTool({
    name: 'dev_injected_list',
    description: '列出已注入的超级模组清单（registry，含目录与时间）',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const list = readRegistry()
      return list.length
        ? list.map(e => `- ${e.name} @ ${e.dir}（${e.at}）`).join('\n')
        : '（无注入记录）'
    },
  }))

  safeRegister(defineTool({
    name: 'dev_reload_package',
    description: '确定性热重载已加载的 bundle 插件包（清缓存 → 重新 import → registry 重建 fiber，失败回滚保留旧代）。不带参数时返回当下已装配插件清单；带参数重载并给出重载前后 fiber 状态对比。默认匹配 dsh-engram-relay',
    parameters: {
      packageName: { type: 'string', description: '包路径子串（缺省 = 只列插件清单，不重载）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { packageName?: string }) {
      if (!args.packageName) {
        return '===== 当前已装配插件（loader entries）=====\n' + listPlugins()
      }
      const entry = findEntry(args.packageName)
      const before = entry ? stateOf(entry) : '（未找到）'
      const result = await reloadPackage(args.packageName)
      const after = entry ? await waitFiberStable(entry) : '（未找到）'
      return result + '\n--- 重载前后状态 ---\nbefore: [' + before + ']\nafter: [' + after + ']'
    },
  }))

  safeRegister(defineTool({
    name: 'dev_plugin_status',
    description: '列出当下已装配插件清单（id/name/fiber 状态/入口 URL），不执行重载',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return '===== 当前已装配插件（loader entries）=====\n' + listPlugins()
    },
  }))

  safeRegister(defineTool({
    name: 'dev_install_package',
    description: '热装配一个本地 bundle 插件：改 profile package.json（dependencies 加 link + bundles 数组加包名）→ 建 node_modules junction → loader.create 动态加载（免重启生效）。幂等：已存在的项自动跳过。重启后由 bundles 列表正常装配（双路径一致）',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: '插件包目录绝对路径（须含 package.json，且已 build 出 lib/）',
      },
      profile: {
        type: 'string',
        description: '目标 profile 名（缺省 web）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const dir = String(args.dir)
      const profileName = args.profile ? String(args.profile) : 'web'
      try {
        const pkgPath = join(dir, 'package.json')
        if (!existsSync(pkgPath)) return 'ERROR: 目录无 package.json: ' + dir
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        const name = pkg.name
        if (typeof name !== 'string' || !name) return 'ERROR: package.json 缺 name'

        const home = process.env.DSH_HOME || join(homedir(), '.dsh')
        const profileDir = join(home, 'profiles', profileName)
        const profilePkgPath = join(profileDir, 'package.json')
        if (!existsSync(profilePkgPath)) return 'ERROR: profile 不存在: ' + profileDir
        const steps: string[] = []

        // 改 profile package.json（dependencies + bundles，幂等）
        const raw = readFileSync(profilePkgPath, 'utf8')
        const profilePkg = JSON.parse(raw)
        profilePkg.dependencies = profilePkg.dependencies ?? {}
        profilePkg.dsh = profilePkg.dsh ?? {}
        profilePkg.dsh.profile = profilePkg.dsh.profile ?? {}
        profilePkg.dsh.profile.bundles = profilePkg.dsh.profile.bundles ?? []
        if (profilePkg.dependencies[name]) steps.push('dependencies 已存在（跳过）')
        else { profilePkg.dependencies[name] = 'link:' + dir; steps.push('dependencies += ' + name) }
        if (profilePkg.dsh.profile.bundles.includes(name)) steps.push('bundles 已存在（跳过）')
        else { profilePkg.dsh.profile.bundles.push(name); steps.push('bundles += ' + name) }
        writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')

        // node_modules junction（@scope/name 两级目录）
        const scope = name.startsWith('@') ? name.split('/')[0] : null
        const linkDir = scope ? join(profileDir, 'node_modules', scope) : join(profileDir, 'node_modules')
        const linkPath = join(linkDir, scope ? name.split('/')[1] as string : name)
        if (existsSync(linkPath)) steps.push('node_modules link 已存在（跳过）')
        else {
          mkdirSync(linkDir, { recursive: true })
          symlinkSync(dir, linkPath, 'junction')
          steps.push('node_modules link 已建立')
        }

        // loader.create 动态加载（幂等：entry 已存在则跳过）
        let exists = false
        for (const entry of ctx.loader.entries()) {
          const opts = entry.options as { name?: string }
          if (opts?.name === name) { exists = true; break }
        }
        if (exists) steps.push('loader entry 已存在（跳过 create）')
        else {
          await ctx.loader.create({ name })
          steps.push('loader.create 已热装配（免重启生效）')
        }

        return 'OK: ' + name + ' 热装配完成\n- ' + steps.join('\n- ') + '\n（重启后由 bundles 列表正常装配，双路径一致；patch 层配置重启后接管）'
      } catch (e) {
        return 'ERROR: ' + (e instanceof Error ? e.stack : String(e))
      }
    },
  }))

  // ============ 能力提示注入（缓存友好：固定内容 + 最尾 order）============
  // 参考官方 system prompt 设计：静态模板稳定、动态内容尾部化。本段每轮渲染
  // 完全相同（常量 text），order 9998 排在一切之后——不破坏 LLM 前缀缓存。
  ctx.systemPrompt.context({
    name: 'dsh-super-injector',
    order: 9998,
    text: '本环境支持插件注入与热重载：dev_inject_plugin 运行时注入、dev_reload_package 整包重载、改代码 build 后约 1.5 秒自动生效（细节见各工具描述）。',
  })

  logger.info('[super-injector] 就绪：watch %d 目录（%dms），autoRestore=%s', watches.length, intervalMs, String(config.autoRestore))
}
