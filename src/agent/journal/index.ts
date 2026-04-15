import type {
  Journal,
  JournalEntry,
  EvaluationEntry,
  OutcomeEntry,
  AdjustmentEntry,
} from '../../types/agent.js'
import { JournalWriter } from './writer.js'
import { JournalReader } from './reader.js'
import { computeMADConfidence } from './confidence.js'
import { summarize } from './summarizer.js'

export { JournalWriter } from './writer.js'
export { JournalReader } from './reader.js'
export { computeMADConfidence, checkAdjustmentStatus, median } from './confidence.js'
export { summarize } from './summarizer.js'

const MAX_ENTRIES = 5000

export class JournalImpl implements Journal {
  private writer: JournalWriter
  private reader: JournalReader
  private entries: JournalEntry[] = []

  constructor(path: string, opts?: { buffered?: boolean }) {
    this.writer = new JournalWriter(path, opts)
    this.reader = new JournalReader(path)
  }

  private append(entry: JournalEntry): void {
    this.writer.append(entry)
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES)
    }
  }

  recordEvaluation(entry: EvaluationEntry): void {
    this.append(entry)
  }

  recordOutcome(entry: OutcomeEntry): void {
    this.append(entry)
  }

  recordAdjustment(entry: AdjustmentEntry): void {
    this.append(entry)
  }

  getEntries(filter?: {
    strategyId?: string
    type?: string
    limit?: number
  }): JournalEntry[] {
    let result = this.entries

    if (filter?.strategyId) {
      result = result.filter((e) => e.strategyId === filter.strategyId)
    }
    if (filter?.type) {
      result = result.filter((e) => e.type === filter.type)
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(-filter.limit)
    }

    return result
  }

  getConfidenceScore(strategyId: string): number | null {
    const outcomes = this.entries.filter(
      (e): e is OutcomeEntry =>
        e.type === 'outcome' && e.strategyId === strategyId,
    )
    const pnls = outcomes.map((o) => o.pnl)
    return computeMADConfidence(pnls)
  }

  getSummary(strategyId: string, lastN?: number): string {
    return summarize(this.entries, strategyId, lastN)
  }

  reconstruct(): void {
    this.entries = this.reader.readAll()
  }

  flush(): void {
    this.writer.flush()
  }
}
