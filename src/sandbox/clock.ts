import type { MarketDataPoint } from '../types/agent.js'

export class SandboxClock {
  private data: MarketDataPoint[]
  private index = 0

  constructor(data: MarketDataPoint[]) {
    if (data.length === 0) throw new Error('SandboxClock requires at least one data point')
    this.data = data
  }

  /** Returns the current data point. Throws if exhausted. */
  current(): MarketDataPoint {
    if (this.index >= this.data.length) {
      throw new Error('SandboxClock exhausted: no more data points')
    }
    return this.data[this.index]
  }

  /** Increments index. Returns false if no more data. */
  advance(): boolean {
    if (this.index >= this.data.length - 1) return false
    this.index++
    return true
  }

  /** Returns current data point's timestamp. */
  timestamp(): string {
    return this.current().timestamp
  }

  /** Look ahead without advancing. Returns undefined if offset is out of range. */
  peek(offset: number): MarketDataPoint | undefined {
    return this.data[this.index + offset]
  }

  /** Returns progress through the dataset. */
  progress(): { current: number; total: number; pct: number } {
    const total = this.data.length
    const current = this.index + 1
    return { current, total, pct: Math.round((current / total) * 10000) / 100 }
  }

  /** Reset index to 0. */
  reset(): void {
    this.index = 0
  }

  /** True when all data points have been consumed (advance returned false and we're on the last). */
  get exhausted(): boolean {
    return this.index >= this.data.length - 1
  }
}
