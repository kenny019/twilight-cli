import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  AgentConfig,
  AgentStatus,
  Journal,
  MarketRegime,
  MarketSnapshot,
  TradeProposal,
} from '../../types/agent.js'
import type { TwilightClient, BinanceClient, Database } from '../../types/index.js'
import { BudgetTracker } from '../provider.js'

// ─── Mock @ax-llm/ax before importing evaluator ────────────────

const mockForward = vi.fn()
const mockGetUsage = vi.fn(() => [{ tokens: { totalTokens: 100 } }])

vi.mock('@ax-llm/ax', () => ({
  ai: vi.fn(() => ({})),
  ax: vi.fn(() => ({
    forward: mockForward,
    getUsage: mockGetUsage,
  })),
  fn: vi.fn(() => ({
    description: vi.fn().mockReturnThis(),
    arg: vi.fn().mockReturnThis(),
    returns: vi.fn().mockReturnThis(),
    handler: vi.fn().mockReturnThis(),
    build: vi.fn(() => ({ name: 'mock-tool', description: 'mock', parameters: {}, func: vi.fn() })),
  })),
  f: Object.assign(vi.fn(() => ({
    description: vi.fn().mockReturnThis(),
    input: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    build: vi.fn(() => ({})),
  })), {
    string: vi.fn(() => ({
      min: vi.fn().mockReturnThis(),
      max: vi.fn().mockReturnThis(),
      optional: vi.fn().mockReturnThis(),
      internal: vi.fn().mockReturnThis(),
      cache: vi.fn().mockReturnThis(),
      array: vi.fn().mockReturnThis(),
    })),
    number: vi.fn(() => ({
      min: vi.fn().mockReturnThis(),
      max: vi.fn().mockReturnThis(),
      optional: vi.fn().mockReturnThis(),
      internal: vi.fn().mockReturnThis(),
    })),
    boolean: vi.fn(() => ({ optional: vi.fn().mockReturnThis() })),
    json: vi.fn(() => ({
      optional: vi.fn().mockReturnThis(),
      array: vi.fn().mockReturnThis(),
    })),
    class: vi.fn(() => ({
      optional: vi.fn().mockReturnThis(),
    })),
    object: vi.fn(() => ({
      optional: vi.fn().mockReturnThis(),
      array: vi.fn().mockReturnThis(),
    })),
  }),
  s: vi.fn(() => ({})),
}))

import { AxAgentEvaluator } from '../evaluator.js'

// ─── Fixtures ──────────────────────────────────────────────────

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'test-key',
    evaluationCadenceMs: 300_000,
    evaluationTimeoutMs: 10_000,
    confidenceThreshold: 2.0,
    revertThreshold: 1.0,
    budget: { maxCallsPerHour: 60, maxTokensPerDay: 100_000 },
    journalPath: '/tmp/journal.jsonl',
    ...overrides,
  }
}

function makeProposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    strategyId: 'funding-arb',
    action: 'open',
    side: 'LONG',
    sizeSats: 100_000,
    entryPrice: 65000,
    leverage: 2,
    reason: 'Funding differential above threshold',
    marketSnapshot: {
      price: 65000,
      twilightFundingRate: 0.001,
      binanceFundingRate: -0.0005,
      differential: 0.0015,
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    price: 65000,
    twilightFundingRate: 0.001,
    binanceFundingRate: -0.0005,
    differential: 0.0015,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeJournal(): Journal {
  return {
    recordEvaluation: vi.fn(),
    recordOutcome: vi.fn(),
    recordAdjustment: vi.fn(),
    getEntries: vi.fn().mockReturnValue([]),
    getConfidenceScore: vi.fn().mockReturnValue(null),
    getSummary: vi.fn().mockReturnValue('No recent evaluations.'),
    reconstruct: vi.fn(),
    flush: vi.fn(),
  }
}

function makeTwilightClient(): TwilightClient {
  return {
    walletBalance: vi.fn().mockResolvedValue({ nyks: 100, sats: 500_000 }),
    walletAccounts: vi.fn().mockResolvedValue([]),
    fund: vi.fn().mockResolvedValue({ requestId: 'r1', accountIndex: 0, status: 'ok' }),
    withdraw: vi.fn().mockResolvedValue({ requestId: 'r2', accountIndex: 0, status: 'ok' }),
    transfer: vi.fn().mockResolvedValue({ requestId: 'r3', accountIndex: 0, status: 'ok' }),
    split: vi.fn().mockResolvedValue({ requestId: 'r4', accountIndex: 0, status: 'ok' }),
    openTrade: vi.fn().mockResolvedValue({ requestId: 'r5', accountIndex: 0, status: 'ok' }),
    closeTrade: vi.fn().mockResolvedValue({ requestId: 'r6', accountIndex: 0, status: 'ok' }),
    cancelTrade: vi.fn().mockResolvedValue({ requestId: 'r7', accountIndex: 0, status: 'ok' }),
    queryTrade: vi.fn().mockResolvedValue({}),
    unlockTrade: vi.fn().mockResolvedValue({ requestId: 'r8', accountIndex: 0, status: 'ok' }),
    openLend: vi.fn().mockResolvedValue({ requestId: 'r9', accountIndex: 0, status: 'ok' }),
    closeLend: vi.fn().mockResolvedValue({ requestId: 'r10', accountIndex: 0, status: 'ok' }),
    queryLend: vi.fn().mockResolvedValue({}),
    marketPrice: vi.fn().mockResolvedValue(65000),
    fundingRate: vi.fn().mockResolvedValue(0.001),
    feeRate: vi.fn().mockResolvedValue({ marketFill: 0.001, limitFill: 0.0005, marketSettle: 0.001, limitSettle: 0.0005 }),
    marketStats: vi.fn().mockResolvedValue({}),
    lendPool: vi.fn().mockResolvedValue({ totalDeposits: 1_000_000, shareValue: 1.05, apy: 8.5 }),
    lastDayApy: vi.fn().mockResolvedValue(8.5),
    orderbook: vi.fn().mockResolvedValue({ bids: [[64999, 1]], asks: [[65001, 1]] }),
  }
}

function makeBinanceClient(): BinanceClient {
  return {
    getPrice: vi.fn().mockResolvedValue(65000),
    getFundingRate: vi.fn().mockResolvedValue(-0.0005),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [[64999, 1]], asks: [[65001, 1]] }),
    openPosition: vi.fn().mockResolvedValue({ orderId: 'b1', status: 'ok', price: 65000, size: 1, fee: 0.1 }),
    closePosition: vi.fn().mockResolvedValue({ orderId: 'b2', status: 'ok', price: 65000, size: 1, fee: 0.1 }),
    getPosition: vi.fn().mockResolvedValue(null),
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(10000),
    getMarginBalance: vi.fn().mockResolvedValue(10000),
    watchPrice: vi.fn().mockResolvedValue(() => {}),
    watchFundingRate: vi.fn().mockResolvedValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function makeDatabase(): Database {
  return {
    createStrategy: vi.fn(),
    getStrategy: vi.fn(),
    updateStrategy: vi.fn(),
    listStrategies: vi.fn().mockReturnValue([]),
    createPosition: vi.fn(),
    getPosition: vi.fn().mockReturnValue({ strategyId: 'funding-arb' }),
    updatePosition: vi.fn(),
    listPositions: vi.fn().mockReturnValue([]),
    createTrade: vi.fn(),
    listTrades: vi.fn().mockReturnValue([]),
    createAccount: vi.fn(),
    getAccount: vi.fn(),
    updateAccount: vi.fn(),
    listAccounts: vi.fn().mockReturnValue([]),
    createAlert: vi.fn(),
    listAlerts: vi.fn().mockReturnValue([]),
    getKV: vi.fn(),
    setKV: vi.fn(),
  } as unknown as Database
}

// ─── Tests ─────────────────────────────────────────────────────

describe('AxAgentEvaluator', () => {
  let evaluator: AxAgentEvaluator
  let journal: Journal
  let config: AgentConfig

  beforeEach(() => {
    vi.clearAllMocks()
    config = makeConfig()
    journal = makeJournal()
    evaluator = new AxAgentEvaluator(
      config,
      { twilight: makeTwilightClient(), binance: makeBinanceClient() },
      makeDatabase(),
    )

    // Default: LLM returns a valid approval
    mockForward.mockResolvedValue({
      verdict: 'approve',
      confidence: 0.85,
      verdictReasoning: 'Funding differential is favorable',
      adjustedParams: '',
    })
  })

  // ─── evaluate() ─────────────────────────────────────────────

  it('returns a valid AgentEvaluation on success', async () => {
    const result = await evaluator.evaluate(makeProposal(), journal)

    expect(result.verdict).toBe('approve')
    expect(result.confidence).toBe(0.85)
    expect(result.reasoning).toBe('Funding differential is favorable')
    expect(result.regime).toBeDefined()
  })

  it('returns fallback when budget is exhausted', async () => {
    // Exhaust the budget
    const exhaustedConfig = makeConfig({ budget: { maxCallsPerHour: 0, maxTokensPerDay: 0 } })
    const exhaustedEvaluator = new AxAgentEvaluator(
      exhaustedConfig,
      { twilight: makeTwilightClient(), binance: makeBinanceClient() },
      makeDatabase(),
    )

    const result = await exhaustedEvaluator.evaluate(makeProposal(), journal)

    expect(result.verdict).toBe('approve')
    expect(result.confidence).toBe(0)
    expect(result.reasoning).toMatch(/budget/i)
    expect(mockForward).not.toHaveBeenCalled()
  })

  it('returns fallback on timeout', async () => {
    const slowConfig = makeConfig({ evaluationTimeoutMs: 50 })
    const slowEvaluator = new AxAgentEvaluator(
      slowConfig,
      { twilight: makeTwilightClient(), binance: makeBinanceClient() },
      makeDatabase(),
    )

    // Simulate slow LLM
    mockForward.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ verdict: 'approve', confidence: 0.9, verdictReasoning: 'late' }), 200)),
    )

    const result = await slowEvaluator.evaluate(makeProposal(), journal)

    expect(result.verdict).toBe('approve')
    expect(result.confidence).toBe(0)
    expect(result.reasoning).toMatch(/fallback|timed out|failed/i)
  })

  it('returns fallback on LLM error', async () => {
    mockForward.mockRejectedValue(new Error('API error'))

    const result = await evaluator.evaluate(makeProposal(), journal)

    expect(result.verdict).toBe('approve')
    expect(result.confidence).toBe(0)
    expect(result.reasoning).toMatch(/fallback|failed/i)
  })

  it('parses adjustedParams when verdict is adjust', async () => {
    mockForward.mockResolvedValue({
      verdict: 'adjust',
      confidence: 0.7,
      verdictReasoning: 'Reduce leverage',
      adjustedParams: '{"leverage": 1}',
    })

    const result = await evaluator.evaluate(makeProposal(), journal)

    expect(result.verdict).toBe('adjust')
    expect(result.adjustedParams).toEqual({ leverage: 1 })
  })

  // ─── detectRegime() ─────────────────────────────────────────

  it('detects regime from LLM', async () => {
    mockForward.mockResolvedValue({
      regime: 'trending',
      confidence: 0.9,
    })

    const result = await evaluator.detectRegime(makeSnapshot())

    expect(result.regime).toBe('trending')
    expect(result.confidence).toBe(0.9)
  })

  it('caches regime within cadence window', async () => {
    mockForward.mockResolvedValue({
      regime: 'volatile',
      confidence: 0.8,
    })

    const first = await evaluator.detectRegime(makeSnapshot())
    mockForward.mockClear()

    const second = await evaluator.detectRegime(makeSnapshot())

    // Should return cached result without a second LLM call
    expect(second).toEqual(first)
    expect(mockForward).not.toHaveBeenCalled()
  })

  it('refreshes regime after cadence expires', async () => {
    const shortCadence = makeConfig({ evaluationCadenceMs: 100 })
    const shortEvaluator = new AxAgentEvaluator(
      shortCadence,
      { twilight: makeTwilightClient(), binance: makeBinanceClient() },
      makeDatabase(),
    )

    mockForward.mockResolvedValue({ regime: 'trending', confidence: 0.9 })
    await shortEvaluator.detectRegime(makeSnapshot())

    // Wait for cadence to expire
    await new Promise((r) => setTimeout(r, 150))
    mockForward.mockResolvedValue({ regime: 'ranging', confidence: 0.7 })

    const result = await shortEvaluator.detectRegime(makeSnapshot())

    expect(result.regime).toBe('ranging')
    expect(mockForward).toHaveBeenCalledTimes(2)
  })

  it('returns fallback regime when budget exhausted', async () => {
    const exhaustedConfig = makeConfig({ budget: { maxCallsPerHour: 0, maxTokensPerDay: 0 } })
    const exhaustedEvaluator = new AxAgentEvaluator(
      exhaustedConfig,
      { twilight: makeTwilightClient(), binance: makeBinanceClient() },
      makeDatabase(),
    )

    const result = await exhaustedEvaluator.detectRegime(makeSnapshot())

    expect(result.regime).toBe('quiet')
    expect(result.confidence).toBe(0)
    expect(mockForward).not.toHaveBeenCalled()
  })

  // ─── status() ───────────────────────────────────────────────

  it('returns correct AgentStatus shape', () => {
    const s = evaluator.status()

    expect(s).toEqual({
      enabled: true,
      lastEvaluation: null,
      lastRegimeCheck: null,
      currentRegime: null,
      evaluationCount: 0,
      callsThisHour: 0,
      budgetRemaining: {
        calls: 60,
        tokens: 100_000,
      },
    })
  })

  it('status reflects state after evaluation', async () => {
    await evaluator.evaluate(makeProposal(), journal)

    const s = evaluator.status()

    expect(s.evaluationCount).toBe(1)
    expect(s.lastEvaluation).not.toBeNull()
    expect(s.callsThisHour).toBe(1)
    expect(s.budgetRemaining.calls).toBe(59)
    expect(s.budgetRemaining.tokens).toBeLessThan(100_000)
  })

  it('status reflects regime after detectRegime()', async () => {
    mockForward.mockResolvedValue({ regime: 'volatile', confidence: 0.8 })
    await evaluator.detectRegime(makeSnapshot())

    const s = evaluator.status()

    expect(s.currentRegime).toBe('volatile')
    expect(s.lastRegimeCheck).not.toBeNull()
  })
})

// ─── BudgetTracker unit tests ─────────────────────────────────

describe('BudgetTracker', () => {
  it('tracks calls and tokens', () => {
    const bt = new BudgetTracker()
    const cfg = makeConfig()

    bt.trackCall(500)
    bt.trackCall(300)

    expect(bt.callsThisHour).toBe(2)
    expect(bt.tokensToday).toBe(800)
    expect(bt.remaining(cfg)).toEqual({ calls: 58, tokens: 99_200 })
  })

  it('reports exhausted when calls exceed limit', () => {
    const bt = new BudgetTracker()
    const cfg = makeConfig({ budget: { maxCallsPerHour: 2, maxTokensPerDay: 100_000 } })

    bt.trackCall(100)
    bt.trackCall(100)

    expect(bt.isExhausted(cfg)).toBe(true)
  })

  it('reports exhausted when tokens exceed limit', () => {
    const bt = new BudgetTracker()
    const cfg = makeConfig({ budget: { maxCallsPerHour: 100, maxTokensPerDay: 500 } })

    bt.trackCall(600)

    expect(bt.isExhausted(cfg)).toBe(true)
  })

  it('remaining never goes negative', () => {
    const bt = new BudgetTracker()
    const cfg = makeConfig({ budget: { maxCallsPerHour: 1, maxTokensPerDay: 100 } })

    bt.trackCall(200)
    bt.trackCall(200)

    const rem = bt.remaining(cfg)
    expect(rem.calls).toBe(0)
    expect(rem.tokens).toBe(0)
  })
})
