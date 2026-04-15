import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  SandboxConfig,
  SandboxReport,
  AgentEvaluator,
  AgentEvaluation,
  AgentStatus,
  TradeProposal,
  MarketSnapshot,
  MarketRegime,
  Journal,
  EvaluationEntry,
  OutcomeEntry,
} from '../types/agent.js'
import type {
  Strategy,
  Context,
  Database,
  Logger,
  RiskManager,
  RiskCheckResult,
  AlertClient,
  AlertMessage,
  StrategyRecord,
  PositionRecord,
  TradeRecord,
  AccountRecord,
  AlertRecord,
  StrategyStatus,
  StrategyType,
  PositionStatus,
  AccountStatus,
  AlertType,
  OrderSide,
} from '../types/index.js'
import { isProposable, applyAdjustedParams } from '../types/agent.js'

import { SandboxClock } from './clock.js'
import { MockTwilightClient } from './mock-twilight.js'
import { MockBinanceClient } from './mock-binance.js'
import { loadMarketData } from './data-loader.js'
import { computeReport } from './reporter.js'

// ─── Dry-run evaluator: always approves ────────────────────────

export class DryRunEvaluator implements AgentEvaluator {
  async evaluate(): Promise<AgentEvaluation> {
    return { verdict: 'approve', confidence: 1, reasoning: 'dry-run' }
  }

  async detectRegime(): Promise<{ regime: MarketRegime; confidence: number }> {
    return { regime: 'quiet' as const, confidence: 1 }
  }

  status(): AgentStatus {
    return {
      enabled: true,
      lastEvaluation: null,
      lastRegimeCheck: null,
      currentRegime: null,
      evaluationCount: 0,
      callsThisHour: 0,
      budgetRemaining: { calls: Infinity, tokens: Infinity },
    }
  }
}

// ─── LLM response cache ────────────────────────────────────────

export class EvaluationCache {
  private cache: Map<string, AgentEvaluation> = new Map()
  private cacheDir?: string

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir
    if (cacheDir) {
      const filePath = join(cacheDir, 'eval-cache.json')
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const entries = JSON.parse(raw) as Array<[string, AgentEvaluation]>
          this.cache = new Map(entries)
        } catch {
          // Corrupted cache — start fresh
        }
      }
    }
  }

  static cacheKey(proposal: TradeProposal): string {
    const payload = JSON.stringify({
      action: proposal.action,
      side: proposal.side,
      snapshot: proposal.marketSnapshot,
    })
    return createHash('sha256').update(payload).digest('hex').slice(0, 16)
  }

  get(proposal: TradeProposal): AgentEvaluation | undefined {
    return this.cache.get(EvaluationCache.cacheKey(proposal))
  }

  set(proposal: TradeProposal, evaluation: AgentEvaluation): void {
    this.cache.set(EvaluationCache.cacheKey(proposal), evaluation)
  }

  save(): void {
    if (!this.cacheDir) return
    mkdirSync(this.cacheDir, { recursive: true })
    const filePath = join(this.cacheDir, 'eval-cache.json')
    writeFileSync(filePath, JSON.stringify(Array.from(this.cache.entries()), null, 2), 'utf-8')
  }
}

// ─── In-memory mock Database ───────────────────────────────────

function createMockDB(): Database {
  const strategies: StrategyRecord[] = []
  const positions: PositionRecord[] = []
  const trades: TradeRecord[] = []
  const accounts: AccountRecord[] = []
  const alerts: AlertRecord[] = []
  const kv = new Map<string, string>()
  let idCounter = 0

  const nextId = () => String(++idCounter)
  const now = () => new Date().toISOString()

  return {
    createStrategy(data) {
      const record: StrategyRecord = { ...data, id: nextId(), createdAt: now(), updatedAt: now() }
      strategies.push(record)
      return record
    },
    getStrategy(id) {
      return strategies.find((s) => s.id === id)
    },
    updateStrategy(id, data) {
      const s = strategies.find((r) => r.id === id)
      if (!s) return undefined
      Object.assign(s, data, { updatedAt: now() })
      return s
    },
    listStrategies(filter) {
      return strategies.filter((s) => {
        if (filter?.status && s.status !== filter.status) return false
        if (filter?.type && s.type !== filter.type) return false
        return true
      })
    },
    createPosition(data) {
      const record: PositionRecord = { ...data, id: nextId(), openedAt: now(), closedAt: null }
      positions.push(record)
      return record
    },
    getPosition(id) {
      return positions.find((p) => p.id === id)
    },
    updatePosition(id, data) {
      const p = positions.find((r) => r.id === id)
      if (!p) return undefined
      Object.assign(p, data)
      return p
    },
    listPositions(filter) {
      return positions.filter((p) => {
        if (filter?.strategyId && p.strategyId !== filter.strategyId) return false
        if (filter?.status && p.status !== filter.status) return false
        if (filter?.exchange && p.exchange !== filter.exchange) return false
        return true
      })
    },
    createTrade(data) {
      const record: TradeRecord = { ...data, id: nextId(), executedAt: now() }
      trades.push(record)
      return record
    },
    listTrades(filter) {
      return trades.filter((t) => {
        if (filter?.positionId && t.positionId !== filter.positionId) return false
        if (filter?.strategyId) {
          const pos = positions.find((p) => p.id === t.positionId)
          if (!pos || pos.strategyId !== filter.strategyId) return false
        }
        return true
      })
    },
    createAccount(data) {
      const record: AccountRecord = { ...data, id: nextId() }
      accounts.push(record)
      return record
    },
    getAccount(exchange, accountIndex) {
      return accounts.find((a) => a.exchange === exchange && a.accountIndex === accountIndex)
    },
    updateAccount(id, data) {
      const a = accounts.find((r) => r.id === id)
      if (!a) return undefined
      Object.assign(a, data)
      return a
    },
    listAccounts(filter) {
      return accounts.filter((a) => {
        if (filter?.exchange && a.exchange !== filter.exchange) return false
        if (filter?.status && a.status !== filter.status) return false
        return true
      })
    },
    createAlert(data) {
      const record: AlertRecord = { ...data, id: nextId(), sentAt: now() }
      alerts.push(record)
      return record
    },
    listAlerts(filter) {
      let result = alerts
      if (filter?.strategyId) result = result.filter((a) => a.strategyId === filter.strategyId)
      if (filter?.type) result = result.filter((a) => a.type === filter.type)
      if (filter?.limit) result = result.slice(-filter.limit)
      return result
    },
    getKV(key) {
      return kv.get(key)
    },
    setKV(key, value) {
      kv.set(key, value)
    },
  }
}

// ─── Mock helpers ──────────────────────────────────────────────

function createMockLogger(): Logger {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, debug: noop }
}

function createMockRiskManager(): RiskManager {
  const ok: RiskCheckResult = { allowed: true }
  return {
    checkPreTrade: async () => ok,
    checkDrawdown: async () => ok,
    checkDailyLoss: async () => ok,
    checkCooldown: async () => ok,
    isKillSwitchActive: async () => false,
    activateKillSwitch: async () => {},
    deactivateKillSwitch: async () => {},
    recordTrade: async () => {},
    checkConnectionHealth: async () => ok,
    reportConnectionStatus: () => {},
  }
}

function createMockAlertClient(): AlertClient {
  return {
    send: async () => true,
    sendTradeAlert: async () => true,
    sendErrorAlert: async () => true,
    sendRiskAlert: async () => true,
  }
}

// ─── Sandbox Runner ────────────────────────────────────────────

export interface SandboxRunnerDeps {
  strategy: Strategy
  evaluator: AgentEvaluator
  journal: Journal
  config: SandboxConfig
  preloadedData?: import('../types/agent.js').MarketDataPoint[]
}

export class SandboxRunner {
  constructor(private deps: SandboxRunnerDeps) {}

  async run(): Promise<SandboxReport> {
    const startTime = Date.now()
    const { strategy, evaluator, journal, config } = this.deps

    const data = this.deps.preloadedData ?? loadMarketData(config.dataPath)

    // 2. Create sandbox infrastructure
    const clock = new SandboxClock(data)
    const twilight = new MockTwilightClient(clock)
    const binance = new MockBinanceClient(clock)

    // 3. Create mock context
    const ctx: Context = {
      twilight,
      binance,
      risk: createMockRiskManager(),
      log: createMockLogger(),
      db: createMockDB(),
      alert: createMockAlertClient(),
      agent: evaluator,
      journal,
    }

    // 4. Init strategy
    await strategy.init({}, ctx)

    // 5. Set up evaluation cache
    const cache = config.cacheDir ? new EvaluationCache(config.cacheDir) : new EvaluationCache()

    const evaluations: EvaluationEntry[] = []
    const outcomes: OutcomeEntry[] = []
    const proposable = isProposable(strategy)

    // 6. Main loop
    do {
      const currentPoint = clock.current()

      if (proposable) {
        const proposal = await strategy.propose(ctx)

        if (proposal) {
          // Check cache first
          let evaluation = cache.get(proposal)

          if (!evaluation) {
            evaluation = await evaluator.evaluate(proposal, journal)
            cache.set(proposal, evaluation)
          }

          const regime = evaluation.regime ?? null

          const evalEntry: EvaluationEntry = {
            type: 'evaluation',
            timestamp: currentPoint.timestamp,
            strategyId: config.strategyId,
            proposal,
            verdict: evaluation.verdict,
            confidence: evaluation.confidence,
            reasoning: evaluation.reasoning,
            regime,
            asi: {},
          }
          journal.recordEvaluation(evalEntry)
          evaluations.push(evalEntry)

          if (evaluation.verdict === 'approve' || evaluation.verdict === 'adjust') {
            if (evaluation.verdict === 'adjust' && evaluation.adjustedParams) {
              applyAdjustedParams(strategy, evaluation.adjustedParams)
            }
            await strategy.execute(ctx, evaluation)

            // Record a synthetic outcome (simplified: PnL from price movement to next tick)
            const nextPoint = clock.peek(1)
            if (nextPoint) {
              const priceChange = nextPoint.price - currentPoint.price
              const side = proposal.side
              const pnl = side === 'SHORT' ? -priceChange : priceChange

              const outcomeEntry: OutcomeEntry = {
                type: 'outcome',
                timestamp: currentPoint.timestamp,
                strategyId: config.strategyId,
                evaluationTimestamp: evalEntry.timestamp,
                pnl,
                holdDurationMs: 3600_000, // 1h synthetic
                exitReason: 'sandbox-tick',
                metrics: { entryPrice: currentPoint.price, exitPrice: nextPoint.price },
              }
              journal.recordOutcome(outcomeEntry)
              outcomes.push(outcomeEntry)
            }
          }
        }
      } else {
        await strategy.tick()
      }
    } while (clock.advance())

    // 7. Flush journal + persist cache
    journal.flush()
    cache.save()

    // 8. Compute report
    const durationMs = Date.now() - startTime
    return computeReport(outcomes, evaluations, durationMs)
  }
}
