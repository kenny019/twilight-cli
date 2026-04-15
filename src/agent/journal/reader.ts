import { readFileSync } from 'node:fs'
import type { JournalEntry } from '../../types/agent.js'

export class JournalReader {
  constructor(private path: string) {}

  readAll(): JournalEntry[] {
    let content: string
    try {
      content = readFileSync(this.path, 'utf-8')
    } catch {
      return []
    }
    const entries: JournalEntry[] = []

    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      try {
        entries.push(JSON.parse(line) as JournalEntry)
      } catch {
        console.warn(`[journal] skipping malformed line: ${line.slice(0, 80)}`)
      }
    }

    return entries
  }

  readFiltered(filter?: {
    strategyId?: string
    type?: string
    limit?: number
  }): JournalEntry[] {
    let entries = this.readAll()

    if (filter?.strategyId) {
      entries = entries.filter((e) => e.strategyId === filter.strategyId)
    }
    if (filter?.type) {
      entries = entries.filter((e) => e.type === filter.type)
    }
    if (filter?.limit && filter.limit > 0) {
      entries = entries.slice(-filter.limit)
    }

    return entries
  }
}
