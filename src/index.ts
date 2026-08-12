/**
 * dsh-super-injector — 超级模组注入器（DSH 生态的 BepInEx）。
 *
 * 官方装配（patch/package.json/bundles 列表）是唯一入口，所有插件都走它——
 * 本插件打破这一点：运行时把任意本地插件包注入运行中的 web，不碰任何配置、
 * 不重启。机制（全部经 dsh-bundle-hmr 项目实测验证）：
 *
 *   1. junction 链接插件包到 profile node_modules（loader 的标准解析路径）；
 *   2. ctx.loader.create({ name, config }) 运行时装配（完整 ctx，免挂载）；
 *   3. 清单持久化（~/.dsh/super-injector/registry.json），web 重启后自动
 *      恢复注入（引导器由官方 patch 装配，是唯一常驻入口）。
 *
 * 配套：注入的插件可用 dsh-bundle-hmr 的 dev_reload_package 热重载。
 */

import { Context } from 'cordis'
import type Loader from '@deepseek-ai/cordis-plugin-loader'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

type AppContext = Context & {
  loader: Loader
  tools: ToolRegistry
}

export const name = 'dsh-super-injector'
export const inject = ['loader', 'tools']

export interface Config {
  /** 注入清单文件路径（缺省 ~/.dsh/super-injector/registry.json）。 */
  registryFile: string
  /** junction 链接目标目录（缺省 ~/.dsh/profiles/web/node_modules）。 */
  profileNodeModules: string
  /** 启动时自动恢复清单中的注入。 */
  autoRestore: boolean
}

export const Config = z.object({
  registryFile: z.string().default(''),
  profileNodeModules: z.string().default(''),
  autoRestore: z.boolean().default(true),
})

interface RegistryEntry {
  dir: string
  name: string
  at: string
}

export function apply(ctx: AppContext, config: Config): void {
  const logger = ctx.logger
  const registryFile = config.registryFile || join(homedir(), '.dsh', 'super-injector', 'registry.json')
  const profileNodeModules = config.profileNodeModules || join(homedir(), '.dsh', 'profiles', 'web', 'node_modules')

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

  /** 该包是否已有 ACTIVATE 的 loader entry（权威防重判断）。 */
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

  // ---- 工具 ----
  ctx.tools.register(defineTool({
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

  ctx.tools.register(defineTool({
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

  logger.info('[super-injector] 就绪：registry=%s，autoRestore=%s', registryFile, String(config.autoRestore))
}
