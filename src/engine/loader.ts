import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Strategy } from '../types/index.js'

export class StrategyLoader {
  private directories: string[]

  constructor(directories: string[]) {
    this.directories = directories
  }

  async loadAll(): Promise<Strategy[]> {
    const strategies: Strategy[] = []

    for (const dir of this.directories) {
      if (!existsSync(dir)) continue

      let files: string[]
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      } catch {
        continue
      }

      for (const file of files) {
        try {
          const mod = await import(join(dir, file))
          const exported = mod.default ?? mod
          if (exported && typeof exported === 'object' && typeof exported.tick === 'function') {
            strategies.push(exported as Strategy)
          }
        } catch {
          // Skip files that fail to load
        }
      }
    }

    return strategies
  }
}
