import { ax } from '@ax-llm/ax'
import type { AxAIService } from '@ax-llm/ax'

import type {
  AgentConfig,
  AgentEvaluation,
  AgentEvaluator,
  AgentStatus,
  Journal,
  MarketRegime,
  MarketSnapshot,
  TradeProposal,
} from '../types/agent.js'
import type { TwilightClient, BinanceClient, Database, Context } from '../types/index.js'

import { createAIProvider, BudgetTracker } from './provider.js'
import { createMarketTools } from './tools/market.js'
import { createPortfolioTools } from './tools/portfolio.js'
import { evaluateProposalSig, detectRegimeSig } from './signatures.js'

const DEFAULT_TIMEOUT_MS = 10_000

function rejectAfter(ms: number, reason: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms))
}

export class AxAgentEvaluator implements AgentEvaluator {
  private lastRegimeCheck = 0
  private cachedRegime: { regime: MarketRegime; confidence: number } | null = null
  private budget: BudgetTracker
  private llm: AxAIService
  private config: AgentConfig
  private tools: ReturnType<typeof createMarketTools>
  private evaluationCount = 0
  private lastEvaluation: string | null = null

  constructor(
    config: AgentConfig,
    clients: { twilight: TwilightClient; binance: BinanceClient },
    db: Database,
  ) {
    this.config = config
    this.budget = new BudgetTracker()
    this.llm = createAIProvider(config)

    const ctx: Context = {
      twilight: clients.twilight,
      binance: clients.binance,
      db,
      risk: undefined as unknown as Context['risk'],
      log: { info() {}, warn() {}, error() {}, debug() {} },
      alert: undefined as unknown as Context['alert'],
    }
    this.tools = [...createMarketTools(ctx), ...createPortfolioTools(ctx)]
  }

  async evaluate(proposal: TradeProposal, journal: Journal): Promise<AgentEvaluation> {
    // Budget gate
    if (this.budget.isExhausted(this.config)) {
      return {
        verdict: 'approve',
        confidence: 0,
        reasoning: 'Budget exhausted — defaulting to approve with zero confidence',
      }
    }

    const timeoutMs = this.config.evaluationTimeoutMs ?? DEFAULT_TIMEOUT_MS

    try {
      const result = await Promise.race([
        this.runEvaluation(proposal, journal),
        rejectAfter(timeoutMs, `Evaluation timed out after ${timeoutMs}ms`),
      ])
      return result
    } catch {
      return {
        verdict: 'approve',
        confidence: 0,
        reasoning: 'Evaluation failed or timed out — fallback approve',
      }
    }
  }

  async detectRegime(snapshot: MarketSnapshot): Promise<{ regime: MarketRegime; confidence: number }> {
    const cadence = this.config.evaluationCadenceMs ?? 300_000
    const now = Date.now()

    // Return cached if fresh
    if (this.cachedRegime && now - this.lastRegimeCheck < cadence) {
      return this.cachedRegime
    }

    // Budget gate
    if (this.budget.isExhausted(this.config)) {
      return this.cachedRegime ?? { regime: 'quiet', confidence: 0 }
    }

    try {
      const gen = ax(detectRegimeSig)
      const result = await gen.forward(this.llm, {
        snapshotJson: JSON.stringify(snapshot),
      })

      // Track usage
      const usage = gen.getUsage()
      const totalTokens = usage.reduce(
        (sum, u) => sum + (u.tokens?.totalTokens ?? 0),
        0,
      )
      this.budget.trackCall(totalTokens)

      const detected: { regime: MarketRegime; confidence: number } = {
        regime: result.regime as MarketRegime,
        confidence: result.confidence,
      }

      this.cachedRegime = detected
      this.lastRegimeCheck = now
      return detected
    } catch {
      return this.cachedRegime ?? { regime: 'quiet', confidence: 0 }
    }
  }

  status(): AgentStatus {
    return {
      enabled: this.config.enabled,
      lastEvaluation: this.lastEvaluation,
      lastRegimeCheck: this.lastRegimeCheck > 0 ? new Date(this.lastRegimeCheck).toISOString() : null,
      currentRegime: this.cachedRegime?.regime ?? null,
      evaluationCount: this.evaluationCount,
      callsThisHour: this.budget.callsThisHour,
      budgetRemaining: this.budget.remaining(this.config),
    }
  }

  // ─── Private ────────────────────────────────────────────────────

  private async runEvaluation(proposal: TradeProposal, journal: Journal): Promise<AgentEvaluation> {
    const gen = ax(evaluateProposalSig)

    const currentRegime = this.cachedRegime?.regime ?? 'quiet'
    const journalSummary = journal.getSummary(proposal.strategyId, 10)

    const result = await gen.forward(
      this.llm,
      {
        proposalJson: JSON.stringify(proposal),
        journalSummary,
        currentRegime,
      },
      {
        functions: this.tools,
        functionCallMode: 'auto',
        maxSteps: 5,
      },
    )

    // Track usage
    const usage = gen.getUsage()
    const totalTokens = usage.reduce(
      (sum, u) => sum + (u.tokens?.totalTokens ?? 0),
      0,
    )
    this.budget.trackCall(totalTokens)
    this.evaluationCount++
    this.lastEvaluation = new Date().toISOString()

    // Parse adjustedParams if present
    let adjustedParams: Record<string, unknown> | undefined
    if (result.verdict === 'adjust' && result.adjustedParams) {
      try {
        adjustedParams = JSON.parse(result.adjustedParams)
      } catch {
        adjustedParams = undefined
      }
    }

    return {
      verdict: result.verdict as AgentEvaluation['verdict'],
      confidence: result.confidence,
      reasoning: result.verdictReasoning,
      adjustedParams,
      regime: currentRegime,
    }
  }
}
