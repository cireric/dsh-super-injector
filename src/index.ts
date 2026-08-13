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
 *  7. 静态能力提示注入       — 固定文本 + order 靠前（静态到头：工具 schema
 *     变更时静态段仍缓存命中；动态内容才走尾部/消息尾）
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
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmdirSync, appendFileSync, renameSync, lstatSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

type AppContext = Context & {
  loader: Loader
  tools: ToolRegistry
  systemPrompt: SystemPrompt
  webServer: any
  registry: any
  setInterval(fn: () => void, ms: number): any
}

export const name = 'dsh-super-injector'
export const inject = ['loader', 'timer', 'tools', 'systemPrompt', 'webServer']

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

/**
 * 操作互斥锁：注入/卸载/重载/安装全部串行执行（多会话并发调用注入器时，
 * 后操作排队等前操作完成——避免同一插件被并发重载/卸载的竞态）。
 */
let opChain: Promise<unknown> = Promise.resolve()
function withOpLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = opChain.then(() => fn(), () => fn())
  opChain = run.then(() => undefined, () => undefined)
  return run
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
    // 原子写：先 tmp 再 rename，避免中途崩溃留下半截 JSON 毒化下次恢复。
    const tmp = registryFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    renameSync(tmp, registryFile)
  }

  /** 该包是否已有 ACTIVE 的 loader entry（权威防重判断）。 */
  function hasActiveEntry(pkgName: string): boolean {
    for (const entry of ctx.loader.entries()) {
      const opts = entry.options
      if (opts.group) continue
      if (opts.name === pkgName && entry.fiber && FIBER_NAMES[entry.fiber.state] === 'active') return true
    }
    return false
  }

  /** 清除某包目录的模块缓存残留（失败 import 留下的残缺 job 会毒化重试）。 */
  function purgeCache(pkgDir: string): void {
    const loadCache = ctx.loader.internal?.loadCache as Map<string, unknown> | undefined
    if (!loadCache || typeof loadCache.delete !== 'function') return
    const key = pkgDir.replace(/\\/g, '/')
    for (const u of [...loadCache.keys()]) {
      // URL 是百分号编码的（非 ASCII 目录），先解码再匹配
      const uDecoded = decodeURIComponent(u)
      if (uDecoded.includes(key)) Map.prototype.delete.call(loadCache, u)
    }
  }

  // ============ 热重载核心 ============
  /** 按包名匹配清理 webserver 路由残留（强制登记守卫的自愈部分）。 */
  function clearRoutesByMatch(match: string): string[] {
    const hs = ctx.webServer
    const cleaned: string[] = []
    for (const tableName of ['exact', 'prefixes', 'upgrades'] as const) {
      const table = hs?.[tableName]
      if (!table || typeof table.delete !== 'function') continue
      for (const k of [...table.keys()]) {
        if (String(k).includes(match)) {
          table.delete(k)
          cleaned.push(`${tableName}[${k}]`)
        }
      }
    }
    return cleaned
  }

  /**
   * 整包热重载：清缓存 → import → 重建 fiber，失败回滚保留旧代。
   * @param match - entry 匹配子串（id/name；同时用于 URL 匹配，除非给 urlMatch）
   * @param urlMatch - URL 匹配子串（watch 自动重载传目录路径；loadCache key 是
   *   百分号编码的 file URL，包名不是 URL 子串，必须用目录路径匹配）
   */

  // ═══ 自重载保护（防自毁）═══
  // 自重载 = 注入器 dispose 自己 → 全局定时器重建。风险面：
  // ① 短名误匹配（match='super'）会绕过 isSelf 走普通重载路径——普通路径在
  //    dispose 自身 fiber 后继续执行必然炸（inactive context），等于自杀且无
  //    重启器兜底——必须强制收敛到 isSelf 分支或拒绝；
  // ② 连环自杀：无节流时自重载可被反复触发（含失败重试）——最小间隔锁；
  // ③ watch 自动重载不应触发自重载（改注入器代码 → build → 自动自杀，无人
  //    在场时注入器可能永久缺席）——watch 轮询显式跳过注入器自身。
  const SELF_RELOAD_MIN_INTERVAL_MS = 10_000 // 自重载最小间隔（防连环自杀）
  let selfReloading = false                    // 自杀→重建窗口锁（窗口内拒绝再次触发）
  // ⚠️ 节流时间戳必须落盘：重启器重建 = 新 fiber = 新闭包，内存变量会归零
  // （实测连续三次自重载都没被拦）。文件状态跨实例持久。
  const selfReloadStateFile = join(dirname(registryFile), 'self-reload.json')

  function readSelfReloadState(): { at: number } {
    try {
      const raw = JSON.parse(readFileSync(selfReloadStateFile, 'utf8')) as { at?: number }
      return { at: typeof raw.at === 'number' ? raw.at : 0 }
    } catch {
      return { at: 0 }
    }
  }

  function writeSelfReloadState(at: number): void {
    try {
      mkdirSync(dirname(selfReloadStateFile), { recursive: true })
      writeFileSync(selfReloadStateFile, JSON.stringify({ at }, null, 2), 'utf8')
    } catch { /* 状态写失败不阻塞（退化为窗口锁保护） */ }
  }

  /** 目标 entry 名是否命中注入器自身（match 或匹配 entry 含注入器名）。 */
  function matchesSelf(match: string): boolean {
    if (String(match).includes('dsh-super-injector')) return true
    for (const entry of ctx.loader.entries()) {
      const o = entry.options
      if (o.group) continue
      if (!String(o.name).includes('dsh-super-injector')) continue
      if (String(o.name).includes(match) || String(o.id).includes(match)) return true
    }
    return false
  }

  async function reloadPackage(match: string, urlMatch?: string): Promise<string> {
    const internal = ctx.loader.internal
    if (!internal) return 'ERROR: loader.internal 不可用'
    const loadCache = internal.loadCache as Map<string, any>

    const urlKey = (urlMatch ?? match).replace(/\\/g, '/')
    const urls = [...loadCache.keys()].filter((u) => {
      if (typeof u !== 'string') return false
      return decodeURIComponent(u).includes(urlKey)
    })
    if (!urls.length) return `INFO: 缓存中无匹配 "${urlKey}" 的模块`
    const entryUrl = urls.find(u => u.endsWith('/lib/index.js'))
    if (!entryUrl) return `ERROR: 未找到入口 lib/index.js（匹配 ${urls.length} 个模块）`

    // ═══ 重启器（自重载专用）：自杀后脱离自身 fiber 完成重建 ═══
    // 自重载时 dispose 会把当前 fiber（含本工具）销毁，随后的重建代码
    // 跑在已销毁的上下文里必然失败。解决：先 dispose + purge（释放文件
    // 句柄，不锁定 lib 文件），再用**全局 setTimeout**（不属于任何 fiber
    // 的 disposables，dispose 不会清它）延迟重建——自杀后生命周期由全局
    // 定时器延续，直到重建结束。
    const isSelf = matchesSelf(match)
    if (isSelf) {
      // 防自毁①：窗口锁——自杀→重建期间拒绝再次自重载
      if (selfReloading) {
        return 'ERROR: 自重载窗口进行中（自杀→重建约 1-2 秒），请稍后再试——防止连环自杀'
      }
      // 防自毁②：节流（文件持久化，跨自重载实例）——最小间隔内拒绝
      const since = Date.now() - readSelfReloadState().at
      if (since < SELF_RELOAD_MIN_INTERVAL_MS) {
        return `ERROR: 自重载节流：距上次仅 ${Math.round(since / 1000)}s（最小间隔 ${SELF_RELOAD_MIN_INTERVAL_MS / 1000}s）——防止循环自杀`
      }
      selfReloading = true
      writeSelfReloadState(Date.now())
      const selfEntry = findEntry(match)
      try {
        if (selfEntry?.fiber && typeof selfEntry.fiber.dispose === 'function') {
          await selfEntry.fiber.dispose()
        }
        for (const u of urls) Map.prototype.delete.call(loadCache, u)
      } catch { /* 清理失败不阻塞 */ }
      // 全局定时器（globalThis.setTimeout，非 fiber 的 ctx.setTimeout）
      const planned = globalThis.setTimeout(() => {
        void (async () => {
          try {
            // ⚠️ 服务访问必须走 entry 的 ctx（rebootCtx）：注入器已自杀，
            // 自身 ctx inactive——用注入器 ctx 调 ctx.loader.import() 会抛
            // 「cannot get required service "loader" in inactive context」
            // （实测两次自重载失败的根因）。rebootCtx 原型链继承 loader
            // 的活跃 fiber，服务解析正常，与 loader._start 装配路径一致。
            const rebootCtx = (selfEntry?.ctx ?? ctx.root) as any
            const fresh = rebootCtx.loader.unwrapExports(await rebootCtx.loader.import(entryUrl, () => []))
            if (selfEntry) {
              // registry.plugin() 断言当前 fiber 存活：rebootCtx.fiber 指向
              // loader 的活跃 fiber，assertActive 通过。
              const nf = rebootCtx.registry.plugin(fresh, selfEntry.options.config ?? {}, () => [])
              nf.entry = selfEntry
              selfEntry.fiber = nf
              logger.info('[super-injector] 重启器重建完成 state=%s', nf.state)
            }
          } catch (error) {
            logger.error('[super-injector] 重启器重建失败: %s', String(error))
            console.error('[super-injector] 重启器重建失败:', error)
            // ═══ 失败自愈（实测保障）：垃圾缓存/文件损坏/异步堵塞导致重建失败时，
            // 注入器已缺席——自动重试装配（3 次，间隔 4s/8s/12s）：每次先 purge
            // 毒化缓存（loadCache 残缺 job 会让 loader.create 复用失败态），再
            // 用 rebootCtx.loader.create 新建 entry 重新装配（绕过坏缓存/坏
            // fiber，走 loader 标准路径）。实测：单次 3s 窗口太紧（文件恢复
            // 动作跨工具往返就超窗），重试给足修复窗口。
            try {
              const rebootCtx = (selfEntry?.ctx ?? ctx.root) as any
              const pkgName = selfEntry?.options?.name ?? '@dsh-external/dsh-super-injector'
              const cfg = selfEntry?.options?.config ?? {}
              let attempt = 0
              const heal = (): void => {
                attempt += 1
                void (async () => {
                  try {
                    const lc = rebootCtx.loader.internal?.loadCache as Map<string, unknown> | undefined
                    if (lc && typeof lc.delete === 'function') {
                      for (const u of [...lc.keys()]) {
                        if (typeof u === 'string' && decodeURIComponent(u).includes(pkgName)) {
                          Map.prototype.delete.call(lc, u)
                        }
                      }
                    }
                    await rebootCtx.loader.create({ name: pkgName, config: cfg })
                    logger.info('[super-injector] 自愈：第 %d 次 loader.create 重新装配完成（%s）', attempt, pkgName)
                  } catch (e) {
                    logger.error('[super-injector] 自愈第 %d 次失败: %s', attempt, String(e))
                    if (attempt < 3) globalThis.setTimeout(heal, 4000)
                    else logger.error('[super-injector] 自愈 3 次均失败（需人工介入：修复产物后 touch profile patch 触发重装配）')
                  }
                })()
              }
              globalThis.setTimeout(heal, 4000)
              logger.warn('[super-injector] 自愈已排程（4s 后第 1 次 loader.create，最多 3 次）')
            } catch (e) {
              logger.error('[super-injector] 自愈排程失败: %s', String(e))
            }
          } finally {
            // 防自毁③：无论成败都释放窗口锁（失败时注入器已缺席，锁必须
            // 释放以便后续手动/自动恢复路径可重新装配）
            selfReloading = false
          }
        })()
      }, 100)
      void planned
      return `OK: 注入器已自杀（dispose + 释放文件句柄），重建已排程（100ms 后由全局定时器执行——重启器生命周期独立于自身 fiber）`
    }

    // 防自毁④：非自重载路径（普通重载）若匹配到注入器自身 entry → 拒绝。
    // 普通路径会在 dispose 自身 fiber 后继续跑注入器 ctx 的代码（inactive
    // context 必然炸），且无重启器兜底——等于无保护的自我处决。
    for (const entry of ctx.loader.entries()) {
      const o = entry.options
      if (o.group) continue
      if (!String(o.name).includes('dsh-super-injector')) continue
      if (String(o.name).includes(match) || String(o.id).includes(match)) {
        return 'ERROR: 重载目标命中注入器自身，但未走自重载路径（匹配串需含 dsh-super-injector）。已拒绝——防止无保护自毁'
      }
    }

    const oldJob = loadCache.get(entryUrl)
    // 坏 job 兜底：旧模块可能卡在 "not instantiated"（此前失败中断的残留），
    // getNamespace 会抛错把重载堵死——此时放弃回滚（坏状态无法回滚），直接
    // purge 后 import 重建。回滚备份仅在旧插件可正常解出时才有意义。
    let oldPlugin: any = null
    let oldJobUsable = false
    try {
      oldPlugin = ctx.loader.unwrapExports(oldJob?.module?.getNamespace())
      oldJobUsable = oldPlugin !== null && oldPlugin !== undefined
    } catch {
      oldJobUsable = false
    }
    if (!oldJobUsable) {
      // 清缓存 + 直接重 import（无旧代可回滚，失败则保留旧缓存原样）
      const backup = new Map<string, any>()
      for (const u of urls) {
        backup.set(u, loadCache.get(u))
        Map.prototype.delete.call(loadCache, u)
      }
      try {
        const fresh = ctx.loader.unwrapExports(await ctx.loader.import(entryUrl, () => []))
        for (const entry of ctx.loader.entries()) {
          const opts = entry.options as { name?: string; id?: string }
          if (opts?.name && String(opts.name).includes(match)) {
            const fiber = entry.fiber
            if (fiber && typeof fiber === 'object') {
              // 尝试用新插件导出重建 fiber（entry 的 plugin 引用替换）
              // ⚠️ 先 await 旧 fiber dispose（异步清理防注册竞态）
              if (typeof fiber.dispose === 'function') {
                try { await fiber.dispose() } catch { /* 忽略 */ }
              }
              const registry = (ctx as any).registry
              if (registry && typeof registry.delete === 'function' && typeof registry.plugin === 'function') {
                registry.delete(fiber)
                const nf = registry.plugin(fresh, entry.options.config ?? {}, () => [])
                nf.entry = entry
                entry.fiber = nf
              }
            }
          }
        }
        return `OK: ${match} 坏缓存兜底重载完成（无旧代回滚）`
      } catch (e) {
        for (const [u, job] of backup) loadCache.set(u, job)
        return 'ERROR: 兜底 import 失败，已恢复原缓存: ' + (e instanceof Error ? e.stack : String(e))
      }
    }

    const runtime = ctx.registry.get(oldPlugin)
    // registry 无 runtime（模块实例不匹配：watch/rescue 等路径建的 fiber 与
    // oldJob namespace 不同）——不依赖 registry.get，直接 entry.fiber 重建。
    if (!runtime) {
      const target = [...ctx.loader.entries()].find((en) => {
        const o = en.options as { name?: string }
        return o?.name && String(o.name).includes(match)
      })
      if (target?.fiber) {
        try {
          if (typeof target.fiber.dispose === 'function') await target.fiber.dispose()
          const backup2 = new Map<string, any>()
          for (const u of urls) {
            backup2.set(u, loadCache.get(u))
            Map.prototype.delete.call(loadCache, u)
          }
          const fresh2 = ctx.loader.unwrapExports(await ctx.loader.import(entryUrl, () => []))
          const nf2 = ctx.registry.plugin(fresh2, target.options.config ?? {}, () => [])
          nf2.entry = target
          target.fiber = nf2
          normalizeEntriesByName(match)
          return `OK: registry 无 runtime，entry.fiber 直接重建（state=${nf2.state}）`
        } catch (e) {
          return 'ERROR: entry 重建失败: ' + (e instanceof Error ? e.stack : String(e))
        }
      }
      return 'ERROR: registry 中无该插件 runtime 且 entry 无 fiber'
    }

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
    // ⚠️ 快照 fiber 列表：runtime.fibers 是 DisposableList（活引用），
    // 下方 await 旧 fiber dispose 会把 fiber 从列表移除——若直接遍历活
    // 列表，重建循环看到的永远是空列表（实测「重建 0 fiber」）。快照
    // 必须在 dispose 之前完成。
    const fibers = [...runtime.fibers] as any[]
    const failures: string[] = []
    let rebuilt = 0
    try {
      const config = currentConfigOf(fibers[0]?._config)
      // ⚠️ 竞态修复：cordis 的 fiber.dispose() 是异步清理（_unload await disposables，
      // 含 context/tools 注册注销）——必须先 await 旧 fiber 完全 dispose，
      // 再建新 fiber，否则新 fiber apply 时旧注册残留 → duplicate（此前 engram
      // 重载连环 "already registered" 的根因）。registry.delete 是 fire-and-forget，
      // 所以这里直接 await entry.fiber 的 dispose（返回 disposalTask Promise）。
      const entryForDispose = [...ctx.loader.entries()].find((en) => {
        const o = en.options as { name?: string }
        return o?.name && String(o.name).includes(match)
      })
      const oldFiberEntry = entryForDispose?.fiber
      if (oldFiberEntry && typeof oldFiberEntry.dispose === 'function') {
        try {
          await oldFiberEntry.dispose()
        } catch { /* dispose 清理失败不阻塞重建 */ }
      }
      ctx.registry.delete(oldPlugin)
      const newFibers: any[] = []
      for (const oldFiber of fibers) {
        try {
          const fiber = oldFiber.parent.registry.plugin(fresh, config, () => [])
          fiber.entry = oldFiber.entry
          if (fiber.entry) fiber.entry.fiber = fiber
          newFibers.push(fiber)
          rebuilt++
        } catch (e) {
          failures.push(String(e))
        }
      }
      // ⚠️ 等新 fiber 完成初始化（loading → active）：registry.plugin 同步返回的
      // fiber 还是 pending/loading——若不等，随后的 client 操作（processOne 的
      // !entry.disabled 检查、activeEntry 查找）会基于不稳定状态失败（实测
      // reload 报 client ✗ 的根因：activeEntry=none → fullName 回落短名 →
      // processOne 精确匹配失败；reload 返回后 fiber 才转 active 补注册）。
      await Promise.allSettled(newFibers.map((f) => {
        const p = typeof f.await === 'function' ? f.await() : undefined
        return p ?? Promise.resolve()
      }))
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
      const message = String(e instanceof Error ? (e.stack ?? e.message) : e)
      // 强制登记守卫：duplicate route = 旧 fiber 存在「未登记到 ctx.effect 的裸注册」，
      // dispose 无法自动注销 → 新注册撞车。检测到即报错要求登记，并自动清理残留自愈。
      if (message.includes('duplicate') || message.includes('already registered')) {
        const cleaned = clearRoutesByMatch(match)
        return 'ERROR: 检测到未登记的裸注册（' + (e instanceof Error ? e.message : String(e))
          + '）——插件必须把资源注册挂到 ctx.effect（登记后 dispose 自动清理，热重载不再残留）。'
          + '\n已自动清理疑似残留路由：' + (cleaned.length ? cleaned.join(', ') : '（无）')
          + '\n请重载重试；若仍失败请检查插件源码中的裸注册。'
      }
      return 'ERROR: 重建失败，已回滚（旧代保留）: ' + message
    }

    if (failures.length) {
      return `WARN: ${match} 部分重建（${rebuilt}/${fibers.length}）: ${failures.join('; ')}`
    }
    // 清 disabled（幽灵 entry 隔离）：热重载后 client 模块可重新注册（UI 生效）
    normalizeEntriesByName(match)
    // ⚠️ 以下 client 操作必须用**完整包名**：client-modules 的 processOne 对
    // entry.options.name 做精确匹配（短名 'dsh-engram-relay' ≠ '@dsh-external/...'），
    // 传短名会静默注册失败（实测 reload 报 client ✗ 的根因——microtask flush
    // 后来用完整名补注册，但返回信息已经错了）。
    const activeEntry = [...ctx.loader.entries()].find((en) => {
      const o = en.options
      return !o.group && String(o.name).includes(match) && en.fiber && FIBER_NAMES[en.fiber.state] === 'active'
    })
    const fullName = activeEntry?.options.name ?? match
    // ═══ 临时诊断（排查 reload 后 client ✗）：写 reload-debug.log ═══
    try {
      const dbg = [
        `[${new Date().toISOString()}] reload match=${match} fullName=${fullName}`,
        `  activeEntry=${activeEntry ? activeEntry.id : 'none'} fiberState=${activeEntry?.fiber ? FIBER_NAMES[activeEntry.fiber.state] : '?'} entry.disabled=${activeEntry ? activeEntry.disabled : '?'} options.disabled=${activeEntry ? JSON.stringify(activeEntry.options.disabled) : '?'}`,
      ]
      const cmDbg = ctx.get('clientModules') as { clientPath?: (id: string) => string | undefined; table?: Map<string, unknown> } | undefined
      dbg.push(`  cm=${cmDbg ? 'yes' : 'no'} clientPath(short)=${cmDbg?.clientPath ? String(cmDbg.clientPath(match)) : '?'} clientPath(full)=${cmDbg?.clientPath ? String(cmDbg.clientPath(fullName)) : '?'}`)
      if (cmDbg?.table) {
        const keys: string[] = []
        for (const k of cmDbg.table.keys()) keys.push(String(k))
        dbg.push(`  table keys(${keys.length}): ${keys.filter((k) => k.includes('engram') || k.includes('dsh-external')).join(',') || '(none)'}`)
      }
      appendFileSync(join(homedir(), '.dsh', 'super-injector', 'reload-debug.log'), dbg.join('\n') + '\n')
    } catch { /* 诊断失败不阻塞 */ }
    // client 模块补扫（表丢失/从未注册时自愈——web 重启后幽灵 entry 场景）
    refreshClientRow(fullName)
    // client bundle 联动：host 重载后 bundle rev 变化通知浏览器（改 UI → 免手动刷新）
    notifyClientRebuilt(fullName)
    // 自检：完整包名查表（表 key 是完整包名，完全匹配）
    const client = clientStatus(fullName)
    recordOp('reload', rebuilt > 0)
    return `OK: ${match} 热重载完成（清缓存 ${urls.length} 模块，重建 ${rebuilt} fiber）\n- ${client}`
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

  /** 查找匹配的 entry（id 或 name 子串）——优先活跃 entry，跳过 disposed/failed/disabled 残留。 */
  function findEntry(match: string): any {
    const candidates: any[] = []
    for (const entry of ctx.loader.entries()) {
      const opts = entry.options
      if (opts.group) continue
      if (opts.id.includes(match) || opts.name.includes(match)) candidates.push(entry)
    }
    if (candidates.length === 0) return undefined
    // 活跃优先（唯一在线实例）；无活跃时取第一个非 disposed/failed 的
    const live = candidates.find((e) => {
      const st = stateOf(e)
      return st === 'active'
    })
    if (live) return live
    return candidates.find((e) => {
      const st = stateOf(e)
      return st !== 'disposed' && st !== 'failed' && st !== 'no-fiber'
    }) ?? candidates[0]
  }

  // ============ 开发侧挂区（staging）：测试工具挂后侧，转正才进 schema ============
  // 任何工具增减都会改变 tools schema → DeepSeek 前缀缓存全灭 → 全量计费。
  // 开发/审计工具一律挂"后侧"（staging）：不进 schema、缓存零污染，经
  // dev_stage_call 测试；确认转正后 dev_stage_promote 一键挂"前侧"（正式注册，
  // 仅承受这一次缓存刷新）。execute 为 JS 代码字符串（function(args, ctx){...}），
  // 闭包可访问本插件的 ctx（webServer/loader/timer/tools/systemPrompt）——仅限可信代码。
  interface StagedTool {
    description: string
    parameters: Record<string, unknown>
    execute: (args: Record<string, unknown>, c: any) => unknown | Promise<unknown>
    /** execute 源码字符串（持久化用：自重载/重启后重新编译恢复）。 */
    source?: string
    promoted: boolean
    /** 转正注册的释放句柄（ctx.effect disposer）——demote 时注销正式工具。 */
    disposer?: () => void
  }
  const staged = new Map<string, StagedTool>()

  // ═══ staging 持久化：自重载（注入器自杀重建）会丢掉 apply 闭包里的 staged
  // map——promote 过的正式工具会随旧 fiber 注销而消失（实测 bug）。落盘到
  // staging.json，apply 启动时恢复（execute 源码重新编译 + promoted 重新注册）。
  const stagingFile = join(dirname(registryFile), 'staging.json')

  function saveStaging(): void {
    try {
      const data: Record<string, { description: string; parameters: unknown; source: string; promoted: boolean }> = {}
      for (const [name, t] of staged) {
        if (typeof t.source === 'string' && t.source !== '') {
          data[name] = { description: t.description, parameters: t.parameters, source: t.source, promoted: t.promoted }
        }
      }
      mkdirSync(dirname(stagingFile), { recursive: true })
      writeFileSync(stagingFile, JSON.stringify(data, null, 2), 'utf8')
    } catch { /* 持久化失败不阻塞 */ }
  }

  /** 恢复持久化的 staging（含 promoted 重新转正注册）。 */
  function restoreStaging(): void {
    try {
      if (!existsSync(stagingFile)) return
      const data = JSON.parse(readFileSync(stagingFile, 'utf8')) as Record<string, { description?: string; parameters?: unknown; source?: string; promoted?: boolean }>
      for (const [name, raw] of Object.entries(data)) {
        if (typeof raw.source !== 'string' || raw.source === '') continue
        if (staged.has(name)) continue
        let fn: Function
        try {
          fn = new Function('args', 'ctx', `return (${raw.source})(args, ctx)`)
        } catch {
          continue // 源码损坏：跳过该工具，不拖垮恢复
        }
        const tool: StagedTool = {
          description: String(raw.description ?? ''),
          parameters: (raw.parameters && typeof raw.parameters === 'object')
            ? raw.parameters as Record<string, unknown>
            : {},
          execute: fn as StagedTool['execute'],
          source: raw.source,
          promoted: raw.promoted === true,
        }
        staged.set(name, tool)
        // promoted 工具重新转正注册（ctx.effect：fiber dispose 自动注销）
        if (tool.promoted) {
          try {
            const dispose = ctx.effect(() => ctx.tools.register(defineTool({
              name,
              description: tool.description,
              parameters: tool.parameters as never,
              output: { schema: { type: 'string' }, render: (_x: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
              async execute(args: Record<string, unknown>) {
                return String(await tool.execute(args, ctx))
              },
            })))
            tool.disposer = () => dispose()
            logger.info('[super-injector] 已恢复转正工具 %s', name)
          } catch { /* 恢复注册失败：保持后侧，不炸 apply */ }
        }
      }
    } catch (e) {
      logger.warn('[super-injector] staging 恢复失败: %s', String(e))
    }
  }
  restoreStaging()

  safeRegister(defineTool({
    name: 'dev_stage_add',
    description: '开发侧挂：把测试/开发工具挂"后侧"（不进 tools schema、不污染缓存前缀），经 dev_stage_call 调用测试。execute 为 JS 代码字符串（function(args, ctx){...}），仅限可信代码。转正用 dev_stage_promote，丢弃用 dev_stage_demote。',
    parameters: {
      name: { type: 'string', required: true, description: '工具名（唯一）' },
      description: { type: 'string', required: true, description: '工具描述' },
      parameters: { type: 'json', description: '参数 schema（可选，留空则无参）' },
      execute: { type: 'string', required: true, description: 'JS 代码：function(args, ctx){ return ... }' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(args: any) {
      if (!args.name || !/^[a-zA-Z0-9_-]+$/.test(args.name)) return 'ERROR: name 缺失或含非法字符'
      if (staged.has(args.name)) return `ERROR: staging 已存在同名工具（${args.name}），先 dev_stage_demote 或换个名`
      let fn: Function
      try {
        fn = new Function('args', 'ctx', `return (${args.execute})(args, ctx)`)
      } catch (e) {
        return 'ERROR: execute 代码编译失败: ' + String(e)
      }
      staged.set(args.name, {
        description: String(args.description ?? ''),
        parameters: (args.parameters && typeof args.parameters === 'object') ? args.parameters : {},
        execute: fn as StagedTool['execute'],
        source: String(args.execute),
        promoted: false,
      })
      saveStaging()
      return `OK: ${args.name} 已挂后侧（staging，不进 schema，缓存零污染）。测试: dev_stage_call ${args.name} {"...":...}；转正: dev_stage_promote ${args.name}`
    },
  }))

  safeRegister(defineTool({
    name: 'dev_stage_call',
    description: '调用后侧（staging）工具测试：不进 schema、不污染缓存。args 为传给工具的 JSON 参数对象。',
    parameters: {
      name: { type: 'string', required: true, description: 'staging 工具名' },
      args: { type: 'json', description: '传给工具的 JSON 参数（可选）' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(a: any) {
      const t = staged.get(a.name)
      if (!t) return `ERROR: staging 无此工具（${a.name}）——dev_stage_list 查看`
      try {
        return String(await t.execute(a.args ?? {}, ctx))
      } catch (e) {
        return 'ERROR: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e))
      }
    },
  }))

  safeRegister(defineTool({
    name: 'dev_stage_list',
    description: '列出后侧（staging）工具（含转正状态）',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute() {
      if (staged.size === 0) return '（staging 空）'
      const lines = [...staged.entries()].map(([name, t]) => `- ${name} ${t.promoted ? '[已转正]' : '[后侧]'} : ${t.description.slice(0, 60)}`)
      return lines.join('\n')
    },
  }))

  safeRegister(defineTool({
    name: 'dev_stage_promote',
    description: '转正：把 staging 工具一键挂"前侧"（正式注册进 tools schema，下一次请求缓存刷新一次）。确认工具有效后使用。',
    parameters: { name: { type: 'string', required: true, description: 'staging 工具名' } },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(a: any) {
      const t = staged.get(a.name)
      if (!t) return `ERROR: staging 无此工具（${a.name}）`
      if (t.promoted) return `${a.name} 已在前侧（转正过）`
      try {
        // 注册挂 ctx.effect：拿 disposer，demote 时才能真正注销正式工具。
        const dispose = ctx.effect(() => ctx.tools.register(defineTool({
          name: a.name,
          description: t.description,
          parameters: t.parameters as never,
          output: { schema: { type: 'string' }, render: (_x: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
          async execute(args: Record<string, unknown>) {
            return String(await t.execute(args, ctx))
          },
        })))
        t.disposer = () => dispose()
      } catch (e) {
        return 'ERROR: 转正注册失败: ' + String(e)
      }
      t.promoted = true
      saveStaging()
      return `OK: ${a.name} 已转正挂前侧（进 schema）。注意：下一次请求将刷新缓存（唯一一次全灭）。`
    },
  }))

  safeRegister(defineTool({
    name: 'dev_stage_demote',
    description: '丢弃/撤回：从 staging 移除工具（若已转正则同时从正式工具集注销）。',
    parameters: { name: { type: 'string', required: true, description: 'staging 工具名' } },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(a: any) {
      const t = staged.get(a.name)
      if (!t) return `ERROR: staging 无此工具（${a.name}）`
      let unregistered = ''
      if (t.disposer) {
        try {
          t.disposer()
          unregistered = '，已从正式工具集注销'
        } catch (e) {
          unregistered = '，正式工具注销失败: ' + String(e)
        }
      }
      staged.delete(a.name)
      saveStaging()
      return `OK: ${a.name} 已从 staging 移除${unregistered}`
    },
  }))

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
  /**
   * 清除 loader 对账标记的 disabled（幽灵 entry 隔离）：
   * 运行时 create 的 entry 不在配置树里，loader 对账（include.refresh /
   * config 变更监听）会把它标 disabled 防双实例——而 client-modules 的
   * processOne 要求 !entry.disabled 才注册 client 模块（**注入插件的 UI
   * 不生效的根因**）。注入器语义：注入 = 完整生效（host 工具 + client UI），
   * 因此注入/重载后立即清除 disabled，让 client 模块可注册。
   * 对账只在 config 变更时触发，清除后不再次对账不会复发。
   */
  function normalizeEntry(entry: any): void {
    if (!entry) return
    try {
      const o = entry.options
      if (o && o.disabled !== undefined && o.disabled !== null) {
        delete o.disabled
        // 同步所属 group 的 data（loader 对账读取的是 group.data）
        const parent = entry.parent
        if (parent && Array.isArray(parent.data)) {
          for (const d of parent.data) {
            if (d && d.id === entry.id && d.disabled !== undefined) delete d.disabled
          }
        }
      }
    } catch { /* 清理失败不阻塞 */ }
  }

  /** 按包名清除所有同名 entry 的 disabled（注入/重载后统一调用）。 */
  function normalizeEntriesByName(name: string): void {
    for (const entry of ctx.loader.entries()) {
      const o = entry.options
      if (o.group) continue
      if (o.name === name || o.name.includes(name)) normalizeEntry(entry)
    }
  }

  /**
   * 清理同名残留 entry（disposed/failed 且无活跃 fiber），防堆积：
   * 注入失败/自杀失败的旧 entry 会留在 loader 树里，重载时 findEntry
   * 虽已活跃优先，但残留多了会让状态列表失真、`waitFiberStable` 轮询错位。
   */
  function cleanupStaleEntries(name: string): void {
    for (const entry of ctx.loader.entries()) {
      const o = entry.options
      if (o.group) continue
      if (o.name !== name) continue
      const st = entry.fiber ? FIBER_NAMES[entry.fiber.state] : 'no-fiber'
      if (st === 'active') continue
      try {
        const p = entry.parent.remove(entry.id, true)
        if (p && typeof p.then === 'function') p.catch(() => { /* 忽略 */ })
        logger.info('[super-injector] 清理残留 entry %s（%s）', entry.id, st)
      } catch { /* 清理失败不阻塞 */ }
    }
  }

  /**
   * client-modules 增量补扫：normalize disabled 发生在 loader.create 的
   * microtask flush **之后**（create await 期间 flush 已用旧 disabled 拒绝），
   * 必须主动重跑 processOne 让注入插件的 client 模块（UI）注册成功。
   * 直接调 private 方法（TS private 编译后是普通属性，运行时可见）。
   */
  function refreshClientRow(name: string): void {
    try {
      const cm = ctx.get('clientModules') as {
        processOne?: (entryName: string) => boolean
        compose?: () => unknown
        composed?: unknown
        notifyGraphChanged?: () => void
      } | undefined
      if (!cm || typeof cm.processOne !== 'function') return
      const changed = cm.processOne(name)
      if (changed && typeof cm.compose === 'function' && typeof cm.notifyGraphChanged === 'function') {
        cm.composed = cm.compose()
        cm.notifyGraphChanged()
        logger.info('[super-injector] client 模块已注册 %s', name)
      }
    } catch (e) {
      logger.warn('[super-injector] client 模块补扫失败: %s', String(e))
    }
  }

  /**
   * 通知 client-modules 重哈希 bundle（rebuilt 是 HMR watch 注册钩子）：
   * host 热重载后 client bundle rev 变化 → onGraphChanged → 浏览器端
   * HMR/刷新拉新 bundle——改 UI 代码 → build:client → reload → 免手动刷新。
   */
  function notifyClientRebuilt(name: string): void {
    try {
      const cm = ctx.get('clientModules') as { rebuilt?: (id: string) => string | undefined } | undefined
      if (cm && typeof cm.rebuilt === 'function') {
        const rev = cm.rebuilt(name)
        if (rev) logger.info('[super-injector] client bundle 已联动（rev=%s）', rev)
      }
    } catch { /* client 联动失败不阻塞 */ }
  }

  /** 卸载后从 client 模块表移除行（client-modules 只订阅 internal/plugin 增事件，卸载不自动清）。 */
  function removeClientRow(name: string): void {
    try {
      const cm = ctx.get('clientModules') as {
        table?: Map<string, unknown>
        compose?: () => unknown
        composed?: unknown
        notifyGraphChanged?: () => void
      } | undefined
      if (!cm || !cm.table) return
      if (cm.table.delete(name)) {
        if (typeof cm.compose === 'function' && typeof cm.notifyGraphChanged === 'function') {
          cm.composed = cm.compose()
          cm.notifyGraphChanged()
        }
        logger.info('[super-injector] client 模块表已移除 %s', name)
      }
    } catch { /* 清理失败不阻塞 */ }
  }

  // ═══ 操作自检与统计：每次注入/重载/卸载/安装后验证 client 模块状态并
  // 记账——操作结果可验证（host ✓ / client ✓），成功率可追溯（准确率）。
  // 统计为进程内存（自重载清零，属本次运行期口径）。
  const opStats = {
    inject: { ok: 0, fail: 0 },
    reload: { ok: 0, fail: 0 },
    uninject: { ok: 0, fail: 0 },
    install: { ok: 0, fail: 0 },
  }

  /** 验证 client 模块注册状态（host 侧已完成后的第二验证面）。 */
  function clientStatus(name: string): string {
    try {
      const cm = ctx.get('clientModules') as {
        clientPath?: (id: string) => string | undefined
        table?: Map<string, unknown>
      } | undefined
      if (!cm || typeof cm.clientPath !== 'function') return 'client 服务不可用'
      let path = cm.clientPath(name)
      if (!path && cm.table && typeof cm.table.keys === 'function') {
        // match 可能是短名（如 'dsh-engram-relay'），client 表 key 是完整包名
        // （'@dsh-external/dsh-engram-relay'）——按子串宽松匹配避免误报。
        for (const key of cm.table.keys()) {
          if (String(key).includes(name)) {
            path = cm.clientPath(key)
            break
          }
        }
      }
      return path ? `client ✓ (${path.split(/[\\/]/).slice(-2).join('/')})` : 'client ✗（未注册——插件无 client 声明或注册失败）'
    } catch {
      return 'client 状态未知'
    }
  }

  /** 记录一次操作结果（ok=true 记成功，否则记失败）。 */
  function recordOp(kind: keyof typeof opStats, ok: boolean): void {
    const bucket = opStats[kind]
    if (ok) bucket.ok += 1
    else bucket.fail += 1
  }

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

    // 清理同名残留 entry（disposed/failed），防止堆积与重载错位
    cleanupStaleEntries(pkgName)

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
    // 清 disabled（幽灵 entry 隔离）：注入即完整生效（host + client UI）
    normalizeEntriesByName(pkgName)
    // client 模块补扫（loader.create 的 microtask flush 在 normalize 前已跑）
    refreshClientRow(pkgName)

    const list = readRegistry()
    if (!list.some(e => e.dir === absDir)) {
      list.push({ dir: absDir, name: pkgName, at: new Date().toISOString() })
      writeRegistry(list)
    }
    const hostOk = hasActiveEntry(pkgName)
    const client = clientStatus(pkgName)
    recordOp('inject', hostOk)
    return `OK: ${pkgName} 已注入（junction=${linkDir}）\n- host ${hostOk ? '✓' : '✗'}\n- ${client}`
  }

  /** 卸载一个已注入的插件包：卸 entry（fiber dispose）→ 清 registry → 删 junction。 */
  async function uninject(match: string): Promise<string> {
    if (match.includes('super-injector')) return 'ERROR: 拒绝卸载 dsh-super-injector 自身（引导器不可卸载）'
    const steps: string[] = []
    let fullName: string | null = null
    // 1. loader entry 卸载（同时捕获完整包名）
    for (const entry of ctx.loader.entries()) {
      const opts = entry.options
      if (opts.group) continue
      if (!opts.name.includes(match)) continue
      fullName = opts.name
      try {
        await entry.parent.remove(entry.id, true)
        steps.push('entry 已卸载: ' + opts.name)
      } catch (e) {
        steps.push('entry 卸载失败: ' + String(e))
      }
    }
    if (!steps.some(s => s.startsWith('entry 已卸载'))) steps.push('（无匹配 entry）')
    // 1.5 阻断 bundle patch 自装配：插件自带 cordis.patch.yml 会 insert 自己，
    // include.refresh 会把刚卸的 entry 加回（卸载不全的根因）。在 profile patch
    // 写 disabled 覆盖（loader patch 同 id 的 disabled 优先于 bundle 层 insert）。
    if (fullName) {
      try {
        const patchFile = join(profileNodeModules, '..', 'cordis.patch.yml')
        if (existsSync(patchFile)) {
          const content = readFileSync(patchFile, 'utf8')
          const idShort = fullName.split('/').pop()
          if (idShort && !content.includes(`id: ${idShort}`)) {
            appendFileSync(patchFile, `\n# 已卸载插件（${fullName}）：disabled 阻断其 bundle patch 自装配\n- id: ${idShort}\n  disabled: true\n`)
            steps.push('profile patch 已写 disabled（阻断自装配，防 refresh 加回）')
          }
        }
      } catch (e) {
        steps.push('profile patch 写入失败: ' + String(e))
      }
    }
    // 2. registry 清理（按 name 或目录匹配）
    const reg = readRegistry()
    const hit = reg.find(e => e.name.includes(match) || e.dir.includes(match))
    if (hit) fullName ??= hit.name
    const after = reg.filter(e => !e.name.includes(match) && !e.dir.includes(match))
    if (after.length !== reg.length) {
      writeRegistry(after)
      steps.push('registry 已清理')
    }
    // 3. junction 删除（用完整包名构建路径；rmdir 只删链接不删目标）
    if (fullName) {
      const parts = fullName.startsWith('@') ? fullName.split('/') : [fullName]
      const linkDir = join(profileNodeModules, ...parts)
      try {
        if (existsSync(linkDir)) {
          rmdirSync(linkDir)
          steps.push('junction 已删除: ' + linkDir)
        } else {
          steps.push('（junction 不存在）')
        }
      } catch (e) {
        steps.push('junction 删除失败: ' + String(e))
      }
    } else {
      steps.push('（未找到完整包名，跳过 junction 清理）')
    }
    // 4. client 模块表移除（client-modules 只订阅 internal/plugin 增事件，卸载不自动清）
    if (fullName) {
      removeClientRow(fullName)
      steps.push('client 模块表已清理')
    }
    recordOp('uninject', steps.some(s => s.startsWith('entry 已卸载')))
    return 'OK: 卸载完成\n- ' + steps.join('\n- ')
  }

  /** junction 健康检查：能读目录 = 目标可达（Windows 断电后悬空 junction 的 lstat 仍是链接但读目录抛错）。 */
  function isHealthyLink(p: string): boolean {
    try {
      if (!lstatSync(p).isSymbolicLink()) return false
      readdirSync(p)
      return true
    } catch {
      return false
    }
  }

  /** 启动自动恢复：① bundle junction 断电自愈（profile packages 的 link:）→ ② 注入清单逐个重新注入。 */
  async function restore(): Promise<void> {
    // ① profile bundle junction 自愈：断电/强制关机后 junction 悬空 → 重建。
    //    （dev_install_package 装的 bundle 在 profile package.json，junction 失效会导致装配失败——此前无覆盖，需手动修）
    try {
      const profileDir = dirname(config.profileNodeModules)
      const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      const bundles: string[] = profilePkg?.dsh?.profile?.bundles ?? []
      const deps: Record<string, string> = profilePkg?.dependencies ?? {}
      for (const name of bundles) {
        const scope = name.startsWith('@') ? name.split('/')[0] : null
        const linkDir = join(config.profileNodeModules, scope ?? '')
        const linkPath = join(linkDir, scope ? name.split('/')[1] as string : name)
        if (!isHealthyLink(linkPath)) {
          const dep = deps[name] ?? ''
          const target = dep.startsWith('link:') ? dep.slice(5) : ''
          if (target && existsSync(target)) {
            try {
              if (existsSync(linkPath)) rmdirSync(linkPath)
            } catch { /* 坏链接删除失败忽略 */ }
            try {
              mkdirSync(linkDir, { recursive: true })
              symlinkSync(target, linkPath, 'junction')
              logger.warn('[super-injector] 断电自愈：重建 junction %s → %s', name, target)
            } catch (err) {
              logger.warn('[super-injector] junction 重建失败 %s: %s', name, String(err))
            }
          } else {
            logger.warn('[super-injector] bundle %s 的 junction 悬空且无有效 link: 目标', name)
          }
        }
      }
    } catch (err) {
      logger.warn('[super-injector] bundle junction 自愈扫描失败: %s', String(err))
    }
    // ② 注入清单恢复（原逻辑）
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
  // watch 源 = 配置 watches + 注入清单（registry）——注入即自动 watch，
  // 自重载后动态 watch 不丢失（registry 持久）；改代码 → build → ~1.5s 自动生效。
  const fingerprints = new Map<string, string>()
  let reloading = false
  ctx.setInterval(() => {
    if (reloading) return
    const watchList: Array<{ dir: string; match: string }> = [...watches]
    for (const e of readRegistry()) {
      if (!watchList.some(w => w.dir === e.dir)) watchList.push({ dir: e.dir, match: e.name })
    }
    for (const w of watchList) {
      // 防自毁⑤：watch 自动重载永不触发注入器自重载（改注入器代码 → build →
      // 自动自杀无人兜底）；自重载只允许显式 dev_reload_package 调用。
      if (String(w.match).includes('dsh-super-injector')) continue
      const fp = fingerprintOf(join(w.dir, 'lib'))
      if (fp === null) continue
      const prev = fingerprints.get(w.dir)
      if (prev !== undefined && prev !== fp) {
        fingerprints.set(w.dir, fp)
        reloading = true
        // match 用于 entry 查找，dir 用于 URL 匹配（loadCache key 是 file URL）
        reloadPackage(w.match, w.dir)
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
      dir: { type: 'string', required: true, description: '插件包目录绝对路径（如 F:/dsh/03-dev-infra/dsh-xxx）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { dir: string }) {
      const dir = String(args.dir ?? '').trim()
      if (!dir) return 'ERROR: dir 必填（插件包目录绝对路径）'
      return withOpLock(() => inject(dir))
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
    name: 'dev_uninject_plugin',
    description: '超级模组卸载器：卸载已注入的插件包——卸 loader entry（fiber dispose，工具/监听全清理）→ 清注入清单 → 删 profile junction，免重启。参数 = 包名子串（如 dsh-toy-supermod）',
    parameters: {
      match: { type: 'string', description: '包名/路径子串（如 dsh-toy-supermod 或 @dsh-external/dsh-toy-supermod）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { match: string }) {
      return withOpLock(() => uninject(args.match))
    },
  }))

  safeRegister(defineTool({
    name: 'dev_clear_routes',
    description: '清 webserver 路由表残留：删除 path 前缀匹配的 exact/prefixes/upgrades 条目（插件热重载残留路由的自愈工具，无需重启）',
    parameters: {
      prefix: { type: 'string', description: 'path 前缀（如 /browser-panel）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { prefix: string }) {
      const hs = ctx.webServer
      const out: string[] = []
      for (const tableName of ['exact', 'prefixes', 'upgrades'] as const) {
        const table = hs?.[tableName]
        if (!table || typeof table.delete !== 'function') {
          out.push(`${tableName}: 不可访问`)
          continue
        }
        const keys = [...table.keys()].filter((k: unknown) => String(k).startsWith(args.prefix))
        for (const k of keys) {
          table.delete(k)
          out.push(`deleted ${tableName}[${k}]`)
        }
        if (!keys.length) out.push(`${tableName}: 无匹配`)
      }
      return out.join('\n')
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
      const result = await withOpLock(() => reloadPackage(args.packageName!))
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
      const summary = Object.entries(opStats)
        .map(([k, v]) => `${k} ${v.ok}✓/${v.fail}✗`)
        .join(' | ')
      return `===== 操作统计（本次运行期）=====\n${summary}\n\n===== 当前已装配插件（loader entries）=====\n` + listPlugins()
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
      return withOpLock(async () => {
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
        if (exists) {
          steps.push('loader entry 已存在（跳过 create）')
          normalizeEntriesByName(name)
          refreshClientRow(name)
        } else {
          await ctx.loader.create({ name })
          normalizeEntriesByName(name)
          refreshClientRow(name)
          steps.push('loader.create 已热装配（免重启生效）')
        }

        const client = clientStatus(name)
        recordOp('install', steps.some(s => s.startsWith('dependencies +=') || s.startsWith('dependencies 已存在')))
        return 'OK: ' + name + ' 热装配完成\n- ' + steps.join('\n- ') + `\n- ${client}\n（重启后由 bundles 列表正常装配，双路径一致；patch 层配置重启后接管）`
      } catch (e) {
        return 'ERROR: 安装失败: ' + String(e)
      }
      })
    },
  }))

  // ============ 静态能力提示注入（缓存原则：静态到头、动态到尾）============
  // - 静态内容（身份/能力声明，编译期常量）→ order 靠前（头部）：tools schema
  //   变更（注入/转正工具）时静态段仍在缓存前缀内，只伤 schema 之后；
  // - 动态内容（记忆检索/实时状态）→ 严禁进 system 头部：走消息尾追加
  //   （engram-relay 的尾部注入即此模式）或 system 最尾，变化只伤自身之后；
  // - 本段 text 必须保持编译期常量——任何每轮变化的动态拼接都会全灭前缀缓存。
  ctx.systemPrompt.context({
    name: 'dsh-super-injector',
    order: -90,
    text: 'dev_inject_plugin 等 dev_* 工具属于 dsh-super-injector（插件热插拔 + 自主迭代）。若它无法实现此目的，优先修复注入器。',
  })

  logger.info('[super-injector] 就绪：watch %d 目录（%dms），autoRestore=%s', watches.length, intervalMs, String(config.autoRestore))
}
