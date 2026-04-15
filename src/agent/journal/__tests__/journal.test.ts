import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JournalImpl, JournalWriter, JournalReader } from '../index.js'
import { computeMADConfidence, checkAdjustmentStatus, median } from '../confidence.js'
import { summarize } from '../summarizer.js'
import type {
  EvaluationEntry,
  OutcomeEntry,
  AdjustmentEntry,
  JournalEntry,
} from '../../../types/agent.js'

const TEST_DIR = join(tmpdir(), 'twilight-journal-test-' + process.pid)

function journalPath(name: string): string {
  return join(TEST_DIR, `${name}.jsonl`)
}

function makeEval(overrides?: Partial<EvaluationEntry>): EvaluationEntry {
  return {
    type: 'evaluation',
    timestamp: new Date().toISOString(),
    strategyId: 'strat-1',
    proposal: {
      strategyId: 'strat-1',
      action: 'open',
      side: 'long',
      sizeSats: 10000,
      reason: 'test',
      marketSnapshot: {
        price: 50000,
        twilightFundingRate: 0.001,
        binanceFundingRate: 0.002,
        differential: 0.001,
        timestamp: new Date().toISOString(),
      },
    },
    verdict: 'approve',
    confidence: 0.85,
    reasoning: 'Looks good',
    regime: 'volatile',
    asi: {},
    ...overrides,
  }
}

function makeOutcome(overrides?: Partial<OutcomeEntry>): OutcomeEntry {
  return {
    type: 'outcome',
    timestamp: new Date().toISOString(),
    strategyId: 'strat-1',
    evaluationTimestamp: new Date().toISOString(),
    pnl: 100,
    holdDurationMs: 60000,
    exitReason: 'target',
    metrics: {},
    ...overrides,
  }
}

function makeAdjustment(overrides?: Partial<AdjustmentEntry>): AdjustmentEntry {
  return {
    type: 'adjustment',
    timestamp: new Date().toISOString(),
    strategyId: 'strat-1',
    previousParams: { entryThreshold: 0.001 },
    newParams: { entryThreshold: 0.002 },
    reasoning: 'Tighten entry',
    confidence: 0.7,
    status: 'applied',
    ...overrides,
  }
}

describe('Journal', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    // Clean up test files
    const files = ['roundtrip', 'sync', 'buffered', 'reconstruct', 'filtered', 'confidence', 'summary', 'malformed']
    for (const f of files) {
      const p = journalPath(f)
      if (existsSync(p)) unlinkSync(p)
    }
  })

  describe('Write/Read round-trip', () => {
    it('writes entries and reads them back with matching content', () => {
      const path = journalPath('roundtrip')
      const journal = new JournalImpl(path)

      const evalEntry = makeEval()
      const outcomeEntry = makeOutcome()
      const adjEntry = makeAdjustment()

      journal.recordEvaluation(evalEntry)
      journal.recordOutcome(outcomeEntry)
      journal.recordAdjustment(adjEntry)

      const reader = new JournalReader(path)
      const entries = reader.readAll()

      expect(entries).toHaveLength(3)
      expect(entries[0]).toEqual(evalEntry)
      expect(entries[1]).toEqual(outcomeEntry)
      expect(entries[2]).toEqual(adjEntry)
    })
  })

  describe('Sync vs Buffered writes', () => {
    it('sync mode writes to disk immediately', () => {
      const path = journalPath('sync')
      const writer = new JournalWriter(path, { buffered: false })
      const entry = makeEval()

      writer.append(entry)

      const content = readFileSync(path, 'utf-8')
      expect(content.trim()).toBe(JSON.stringify(entry))
    })

    it('buffered mode only writes after flush', () => {
      const path = journalPath('buffered')
      const writer = new JournalWriter(path, { buffered: true })
      const entry = makeEval()

      writer.append(entry)
      expect(existsSync(path)).toBe(false)

      writer.flush()
      const content = readFileSync(path, 'utf-8')
      expect(content.trim()).toBe(JSON.stringify(entry))
    })

    it('flush with no buffered entries is a no-op', () => {
      const path = journalPath('buffered')
      const writer = new JournalWriter(path, { buffered: true })
      writer.flush()
      expect(existsSync(path)).toBe(false)
    })
  })

  describe('reconstruct', () => {
    it('rebuilds in-memory state from JSONL on disk', () => {
      const path = journalPath('reconstruct')

      // Write with one instance
      const j1 = new JournalImpl(path)
      j1.recordEvaluation(makeEval())
      j1.recordOutcome(makeOutcome({ pnl: 200 }))

      // New instance, empty in-memory
      const j2 = new JournalImpl(path)
      expect(j2.getEntries()).toHaveLength(0)

      j2.reconstruct()
      expect(j2.getEntries()).toHaveLength(2)
      expect(j2.getEntries()[1].type).toBe('outcome')
    })
  })

  describe('getEntries with filters', () => {
    it('filters by strategyId', () => {
      const path = journalPath('filtered')
      const journal = new JournalImpl(path)

      journal.recordEvaluation(makeEval({ strategyId: 'strat-1' }))
      journal.recordEvaluation(makeEval({ strategyId: 'strat-2' }))
      journal.recordOutcome(makeOutcome({ strategyId: 'strat-1' }))

      const s1 = journal.getEntries({ strategyId: 'strat-1' })
      expect(s1).toHaveLength(2)

      const s2 = journal.getEntries({ strategyId: 'strat-2' })
      expect(s2).toHaveLength(1)
    })

    it('filters by type', () => {
      const path = journalPath('filtered')
      const journal = new JournalImpl(path)

      journal.recordEvaluation(makeEval())
      journal.recordOutcome(makeOutcome())
      journal.recordAdjustment(makeAdjustment())

      const outcomes = journal.getEntries({ type: 'outcome' })
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0].type).toBe('outcome')
    })

    it('respects limit (takes last N)', () => {
      const path = journalPath('filtered')
      const journal = new JournalImpl(path)

      for (let i = 0; i < 10; i++) {
        journal.recordOutcome(makeOutcome({ pnl: i * 100 }))
      }

      const last3 = journal.getEntries({ limit: 3 })
      expect(last3).toHaveLength(3)
      expect((last3[0] as OutcomeEntry).pnl).toBe(700)
      expect((last3[2] as OutcomeEntry).pnl).toBe(900)
    })
  })

  describe('Reader handles edge cases', () => {
    it('returns empty array for non-existent file', () => {
      const reader = new JournalReader(journalPath('nonexistent'))
      expect(reader.readAll()).toEqual([])
    })

    it('skips malformed JSON lines gracefully', () => {
      const path = journalPath('malformed')
      const { writeFileSync } = require('node:fs')
      const valid = JSON.stringify(makeEval())
      writeFileSync(path, `${valid}\n{bad json\n${valid}\n`, 'utf-8')

      const reader = new JournalReader(path)
      const entries = reader.readAll()
      expect(entries).toHaveLength(2)
    })
  })

  describe('MAD confidence', () => {
    it('returns null for fewer than 5 values', () => {
      expect(computeMADConfidence([1, 2, 3])).toBeNull()
      expect(computeMADConfidence([])).toBeNull()
    })

    it('computes a numeric score for valid series', () => {
      const score = computeMADConfidence([100, 200, 300, 400, 500])
      expect(score).toBeTypeOf('number')
      expect(score).toBeGreaterThan(0)
    })

    it('handles all-identical values (MAD=0)', () => {
      const score = computeMADConfidence([1, 1, 1, 1, 1])
      // mean=1, MAD=0 → denominator=0 → should return Infinity (or 0 if mean is also 0)
      expect(score).toBe(Infinity)
    })

    it('returns 0 when all values are 0', () => {
      const score = computeMADConfidence([0, 0, 0, 0, 0])
      expect(score).toBe(0)
    })

    it('median helper works correctly', () => {
      expect(median([3, 1, 2])).toBe(2)
      expect(median([4, 1, 3, 2])).toBe(2.5)
      expect(median([5])).toBe(5)
    })
  })

  describe('checkAdjustmentStatus', () => {
    it('returns insufficient_data for null', () => {
      expect(checkAdjustmentStatus(null, 2.0, 1.0)).toBe('insufficient_data')
    })

    it('returns persist when score >= confidenceThreshold', () => {
      expect(checkAdjustmentStatus(2.5, 2.0, 1.0)).toBe('persist')
      expect(checkAdjustmentStatus(2.0, 2.0, 1.0)).toBe('persist')
    })

    it('returns revert when score < revertThreshold', () => {
      expect(checkAdjustmentStatus(0.5, 2.0, 1.0)).toBe('revert')
    })

    it('returns keep when between thresholds', () => {
      expect(checkAdjustmentStatus(1.5, 2.0, 1.0)).toBe('keep')
      expect(checkAdjustmentStatus(1.0, 2.0, 1.0)).toBe('keep')
    })
  })

  describe('getConfidenceScore', () => {
    it('computes MAD confidence from recorded outcomes', () => {
      const path = journalPath('confidence')
      const journal = new JournalImpl(path)

      // Record 5+ outcomes
      for (const pnl of [100, 200, 150, -50, 300]) {
        journal.recordOutcome(makeOutcome({ pnl }))
      }

      const score = journal.getConfidenceScore('strat-1')
      expect(score).toBeTypeOf('number')
      expect(score).not.toBeNull()
    })

    it('returns null with fewer than 5 outcomes', () => {
      const path = journalPath('confidence')
      const journal = new JournalImpl(path)

      journal.recordOutcome(makeOutcome({ pnl: 100 }))

      expect(journal.getConfidenceScore('strat-1')).toBeNull()
    })

    it('only uses outcomes for the given strategyId', () => {
      const path = journalPath('confidence')
      const journal = new JournalImpl(path)

      for (const pnl of [100, 200, 150, -50, 300]) {
        journal.recordOutcome(makeOutcome({ pnl, strategyId: 'strat-1' }))
      }
      journal.recordOutcome(makeOutcome({ pnl: 999, strategyId: 'strat-2' }))

      const score = journal.getConfidenceScore('strat-1')
      expect(score).toBeTypeOf('number')
      expect(journal.getConfidenceScore('strat-2')).toBeNull()
    })
  })

  describe('Summarizer', () => {
    it('returns a message for empty entries', () => {
      const result = summarize([], 'strat-1')
      expect(result).toContain('No journal entries')
    })

    it('includes verdict counts', () => {
      const entries: JournalEntry[] = [
        makeEval({ verdict: 'approve' }),
        makeEval({ verdict: 'approve' }),
        makeEval({ verdict: 'reject' }),
      ]
      const result = summarize(entries, 'strat-1')
      expect(result).toContain('2 approved')
      expect(result).toContain('1 rejected')
    })

    it('includes PnL stats', () => {
      const entries: JournalEntry[] = [
        makeOutcome({ pnl: 200 }),
        makeOutcome({ pnl: -100 }),
        makeOutcome({ pnl: 300 }),
      ]
      const result = summarize(entries, 'strat-1')
      expect(result).toContain('Win rate:')
      expect(result).toContain('Avg PnL:')
      expect(result).toContain('Max loss: -100')
    })

    it('includes regime info', () => {
      const entries: JournalEntry[] = [
        makeEval({ regime: 'volatile' }),
      ]
      const result = summarize(entries, 'strat-1')
      expect(result).toContain('Regime: volatile')
    })

    it('includes active adjustment info', () => {
      const entries: JournalEntry[] = [
        makeAdjustment({
          previousParams: { entryThreshold: 0.001 },
          newParams: { entryThreshold: 0.002 },
          status: 'applied',
        }),
      ]
      const result = summarize(entries, 'strat-1')
      expect(result).toContain('Active adjustment')
      expect(result).toContain('entryThreshold')
    })

    it('respects lastN parameter', () => {
      const entries: JournalEntry[] = []
      for (let i = 0; i < 30; i++) {
        entries.push(makeEval({ verdict: i < 20 ? 'approve' : 'reject' }))
      }
      // lastN=5 should only see the last 5 (all reject)
      const result = summarize(entries, 'strat-1', 5)
      expect(result).toContain('0 approved')
      expect(result).toContain('5 rejected')
    })
  })
})
