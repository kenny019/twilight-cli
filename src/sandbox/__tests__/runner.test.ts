import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCSV, loadJSON, loadMarketData } from '../data-loader.js'
import { computeReport, mean, std, computeMaxDrawdown } from '../reporter.js'
import { DryRunEvaluator, EvaluationCache } from '../runner.js'
import type { TradeProposal, EvaluationEntry, OutcomeEntry, MarketRegime } from '../../types/agent.js'

// ─── Test fixtures ─────────────────────────────────────────────

const tmpBase = join(tmpdir(), 'sandbox-tests-' + process.pid)

function setupTmpDir(): string {
  mkdirSync(tmpBase, { recursive: true })
  return tmpBase
}

function cleanup(): void {
  rmSync(tmpBase, { recursive: true, force: true })
}

function makeProposal(overrides?: Partial<TradeProposal>): TradeProposal {
  return {
    strategyId: 'test',
    action: 'open',
    side: 'LONG',
    reason: 'test',
    marketSnapshot: {
      price: 65000,
      twilightFundingRate: 0.001,
      binanceFundingRate: 0.0005,
      differential: 0.0005,
      timestamp: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  }
}

// ─── CSV Parsing ───────────────────────────────────────────────

describe('data-loader: CSV parsing', () => {
  beforeEach(() => setupTmpDir())

  it('parses valid CSV with all columns', () => {
    const csv = [
      'timestamp,price,twilightFundingRate,binanceFundingRate,volume,volatility,lendingApy',
      '2026-01-01T00:00:00Z,65000,0.001,0.0005,100,0.02,5.5',
      '2026-01-01T01:00:00Z,65100,0.0012,0.0006,120,0.03,5.6',
    ].join('\n')
    const filePath = join(tmpBase, 'valid.csv')
    writeFileSync(filePath, csv)

    const points = loadCSV(filePath)
    expect(points).toHaveLength(2)
    expect(points[0].price).toBe(65000)
    expect(points[0].twilightFundingRate).toBe(0.001)
    expect(points[0].binanceFundingRate).toBe(0.0005)
    expect(points[0].volume).toBe(100)
    expect(points[0].volatility).toBe(0.02)
    expect(points[0].lendingApy).toBe(5.5)
    expect(points[1].price).toBe(65100)
  })

  it('skips rows with missing price', () => {
    const csv = [
      'timestamp,price,twilightFundingRate,binanceFundingRate',
      '2026-01-01T00:00:00Z,65000,0.001,0.0005',
      '2026-01-01T01:00:00Z,,0.001,0.0005',
      '2026-01-01T02:00:00Z,65200,0.001,0.0005',
    ].join('\n')
    const filePath = join(tmpBase, 'missing-price.csv')
    writeFileSync(filePath, csv)

    const points = loadCSV(filePath)
    expect(points).toHaveLength(2)
    expect(points[0].price).toBe(65000)
    expect(points[1].price).toBe(65200)
  })

  it('returns empty array for header-only file', () => {
    const csv = 'timestamp,price,twilightFundingRate,binanceFundingRate\n'
    const filePath = join(tmpBase, 'header-only.csv')
    writeFileSync(filePath, csv)

    const points = loadCSV(filePath)
    expect(points).toHaveLength(0)
  })

  it('throws on missing timestamp/price headers', () => {
    const csv = 'foo,bar\n1,2\n'
    const filePath = join(tmpBase, 'bad-headers.csv')
    writeFileSync(filePath, csv)

    expect(() => loadCSV(filePath)).toThrow('timestamp and price')
  })

  it('loadMarketData auto-detects CSV and sorts by timestamp', () => {
    const csv = [
      'timestamp,price,twilightFundingRate,binanceFundingRate',
      '2026-01-01T02:00:00Z,65200,0.001,0.0005',
      '2026-01-01T00:00:00Z,65000,0.001,0.0005',
      '2026-01-01T01:00:00Z,65100,0.001,0.0005',
    ].join('\n')
    const filePath = join(tmpBase, 'unsorted.csv')
    writeFileSync(filePath, csv)

    const points = loadMarketData(filePath)
    expect(points).toHaveLength(3)
    expect(points[0].price).toBe(65000)
    expect(points[1].price).toBe(65100)
    expect(points[2].price).toBe(65200)
  })

  it('loadMarketData throws on empty data', () => {
    const csv = 'timestamp,price,twilightFundingRate,binanceFundingRate\n'
    const filePath = join(tmpBase, 'empty.csv')
    writeFileSync(filePath, csv)

    expect(() => loadMarketData(filePath)).toThrow('No valid market data')
  })

  it('loadMarketData throws on unsupported extension', () => {
    const filePath = join(tmpBase, 'data.xml')
    writeFileSync(filePath, '<data/>')

    expect(() => loadMarketData(filePath)).toThrow('Unsupported file extension')
  })

  afterAll(() => cleanup())
})

// ─── JSON Parsing ──────────────────────────────────────────────

describe('data-loader: JSON parsing', () => {
  beforeEach(() => setupTmpDir())

  it('parses valid JSON array', () => {
    const data = [
      { timestamp: '2026-01-01T00:00:00Z', price: 65000, twilightFundingRate: 0.001, binanceFundingRate: 0.0005 },
      { timestamp: '2026-01-01T01:00:00Z', price: 65100, twilightFundingRate: 0.0012, binanceFundingRate: 0.0006 },
    ]
    const filePath = join(tmpBase, 'valid.json')
    writeFileSync(filePath, JSON.stringify(data))

    const points = loadJSON(filePath)
    expect(points).toHaveLength(2)
    expect(points[0].price).toBe(65000)
  })

  it('skips entries missing price', () => {
    const data = [
      { timestamp: '2026-01-01T00:00:00Z', price: 65000, twilightFundingRate: 0.001, binanceFundingRate: 0.0005 },
      { timestamp: '2026-01-01T01:00:00Z' }, // missing price
    ]
    const filePath = join(tmpBase, 'partial.json')
    writeFileSync(filePath, JSON.stringify(data))

    const points = loadJSON(filePath)
    expect(points).toHaveLength(1)
  })

  it('throws on non-array JSON', () => {
    const filePath = join(tmpBase, 'obj.json')
    writeFileSync(filePath, JSON.stringify({ foo: 'bar' }))

    expect(() => loadJSON(filePath)).toThrow('array')
  })

  afterAll(() => cleanup())
})

// ─── Reporter Math ─────────────────────────────────────────────

describe('reporter: math helpers', () => {
  it('mean of empty array is 0', () => {
    expect(mean([])).toBe(0)
  })

  it('mean of [1,2,3,4,5] is 3', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3)
  })

  it('std of empty array is 0', () => {
    expect(std([])).toBe(0)
  })

  it('std of single element is 0', () => {
    expect(std([5])).toBe(0)
  })

  it('std of [2,4,4,4,5,5,7,9] is approximately 2.138', () => {
    const s = std([2, 4, 4, 4, 5, 5, 7, 9])
    expect(s).toBeCloseTo(2.138, 2)
  })
})

describe('reporter: max drawdown', () => {
  it('returns 0 for empty PnLs', () => {
    expect(computeMaxDrawdown([])).toBe(0)
  })

  it('returns 0 for all-positive PnLs', () => {
    expect(computeMaxDrawdown([10, 20, 30])).toBe(0)
  })

  it('computes max drawdown from known PnLs', () => {
    // Cumulative: 100, 50, 250, -50, 50
    // Peak:       100, 100, 250, 250, 250
    // Drawdown:   0,   50,  0,   300, 200
    const dd = computeMaxDrawdown([100, -50, 200, -300, 100])
    expect(dd).toBe(300)
  })

  it('handles single negative PnL', () => {
    expect(computeMaxDrawdown([-100])).toBe(100)
  })
})

describe('reporter: computeReport', () => {
  it('returns zeros for empty outcomes', () => {
    const report = computeReport([], [], 1000)
    expect(report.totalPnl).toBe(0)
    expect(report.tradeCount).toBe(0)
    expect(report.winRate).toBe(0)
    expect(report.sharpeRatio).toBe(0)
    expect(report.maxDrawdown).toBe(0)
    expect(report.agentDecisions).toEqual({ approved: 0, rejected: 0, adjusted: 0 })
  })

  it('computes sharpe with known daily returns', () => {
    // 5 outcomes on different days
    const outcomes: OutcomeEntry[] = [1, 2, 3, -1, 2].map((pnl, i) => ({
      type: 'outcome' as const,
      timestamp: `2026-01-0${i + 1}T12:00:00Z`,
      strategyId: 'test',
      evaluationTimestamp: `2026-01-0${i + 1}T11:00:00Z`,
      pnl,
      holdDurationMs: 3600000,
      exitReason: 'test',
      metrics: {},
    }))

    const report = computeReport(outcomes, [], 5000)
    expect(report.totalPnl).toBe(7)
    expect(report.tradeCount).toBe(5)
    expect(report.winRate).toBe(4 / 5)
    // Sharpe should be positive and reasonable: mean=1.4, std ~= 1.517
    // sharpe = (1.4 / 1.517) * sqrt(365) ~= 17.63
    expect(report.sharpeRatio).toBeGreaterThan(0)
    expect(report.sharpeRatio).toBeLessThan(30)
  })

  it('counts agent decisions correctly', () => {
    const evaluations: EvaluationEntry[] = [
      { type: 'evaluation', timestamp: '2026-01-01T00:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'approve', confidence: 1, reasoning: 'ok', regime: 'quiet', asi: {} },
      { type: 'evaluation', timestamp: '2026-01-01T01:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'reject', confidence: 0.8, reasoning: 'no', regime: 'volatile', asi: {} },
      { type: 'evaluation', timestamp: '2026-01-01T02:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'adjust', confidence: 0.9, reasoning: 'tweak', regime: 'trending', asi: {} },
      { type: 'evaluation', timestamp: '2026-01-01T03:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'approve', confidence: 1, reasoning: 'ok', regime: 'quiet', asi: {} },
    ]

    const report = computeReport([], evaluations, 1000)
    expect(report.agentDecisions).toEqual({ approved: 2, rejected: 1, adjusted: 1 })
  })

  it('computes regime breakdown from evaluations', () => {
    const evaluations: EvaluationEntry[] = [
      { type: 'evaluation', timestamp: '2026-01-01T00:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'approve', confidence: 1, reasoning: '', regime: 'quiet', asi: {} },
      { type: 'evaluation', timestamp: '2026-01-01T01:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'approve', confidence: 1, reasoning: '', regime: 'volatile', asi: {} },
      { type: 'evaluation', timestamp: '2026-01-01T02:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'approve', confidence: 1, reasoning: '', regime: 'quiet', asi: {} },
      { type: 'evaluation', timestamp: '2026-01-01T03:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'approve', confidence: 1, reasoning: '', regime: 'trending', asi: {} },
      { type: 'evaluation', timestamp: '2026-01-01T04:00:00Z', strategyId: 'test', proposal: makeProposal(), verdict: 'approve', confidence: 1, reasoning: '', regime: null, asi: {} },
    ]

    const report = computeReport([], evaluations, 1000)
    expect(report.regimeBreakdown).toEqual({
      quiet: 2,
      volatile: 1,
      trending: 1,
      ranging: 0,
    })
  })
})

// ─── Evaluation Cache ──────────────────────────────────────────

describe('EvaluationCache', () => {
  it('set/get round-trip', () => {
    const cache = new EvaluationCache()
    const proposal = makeProposal()
    const evaluation = { verdict: 'approve' as const, confidence: 0.95, reasoning: 'looks good' }

    cache.set(proposal, evaluation)
    const result = cache.get(proposal)
    expect(result).toEqual(evaluation)
  })

  it('returns undefined for unknown proposals', () => {
    const cache = new EvaluationCache()
    expect(cache.get(makeProposal())).toBeUndefined()
  })

  it('cache key is deterministic', () => {
    const proposal = makeProposal()
    const key1 = EvaluationCache.cacheKey(proposal)
    const key2 = EvaluationCache.cacheKey(proposal)
    expect(key1).toBe(key2)
    expect(key1).toHaveLength(16)
  })

  it('different proposals produce different keys', () => {
    const p1 = makeProposal({ action: 'open' })
    const p2 = makeProposal({ action: 'close' })
    expect(EvaluationCache.cacheKey(p1)).not.toBe(EvaluationCache.cacheKey(p2))
  })

  it('persists to disk and reloads', () => {
    const dir = join(tmpdir(), 'eval-cache-test-' + process.pid)
    mkdirSync(dir, { recursive: true })

    const cache1 = new EvaluationCache(dir)
    const proposal = makeProposal()
    const evaluation = { verdict: 'reject' as const, confidence: 0.5, reasoning: 'risky' }
    cache1.set(proposal, evaluation)
    cache1.save()

    const cache2 = new EvaluationCache(dir)
    expect(cache2.get(proposal)).toEqual(evaluation)

    rmSync(dir, { recursive: true, force: true })
  })
})

// ─── DryRunEvaluator ───────────────────────────────────────────

describe('DryRunEvaluator', () => {
  it('always returns approve with confidence 1', async () => {
    const evaluator = new DryRunEvaluator()
    const result = await evaluator.evaluate(makeProposal(), {} as any)
    expect(result.verdict).toBe('approve')
    expect(result.confidence).toBe(1)
    expect(result.reasoning).toBe('dry-run')
  })

  it('detectRegime returns quiet', async () => {
    const evaluator = new DryRunEvaluator()
    const result = await evaluator.detectRegime({
      price: 65000,
      twilightFundingRate: 0.001,
      binanceFundingRate: 0.0005,
      differential: 0.0005,
      timestamp: '2026-01-01T00:00:00Z',
    })
    expect(result.regime).toBe('quiet')
    expect(result.confidence).toBe(1)
  })

  it('status returns default agent status', () => {
    const evaluator = new DryRunEvaluator()
    const status = evaluator.status()
    expect(status.enabled).toBe(true)
    expect(status.evaluationCount).toBe(0)
    expect(status.currentRegime).toBeNull()
  })
})
