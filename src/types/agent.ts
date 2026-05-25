import type { OrderSide, Context } from './index.js'

// ─── Trade Proposal (strategies emit these) ─────────────────────
export interface TradeProposal {
  strategyId: string
  action: 'open' | 'close' | 'rebalance'
  side?: OrderSide
  sizeSats?: number
  entryPrice?: number
  leverage?: number
  reason: string
  marketSnapshot: MarketSnapshot
}

export interface MarketSnapshot {
  price: number
  twilightFundingRate: number
  binanceFundingRate: number
  hyperliquidFundingRate?: number
  signedDifferential?: number   // signed: twilightRate - hedgeRate (used by funding-arb)
  differential: number          // absolute differential
  lendingApy?: number
  timestamp: string
}

// ─── Agent Evaluation (agent returns these) ─────────────────────
export type AgentVerdict = 'approve' | 'reject' | 'adjust'

export interface AgentEvaluation {
  verdict: AgentVerdict
  confidence: number // 0-1 (agent's self-assessed confidence)
  reasoning: string
  adjustedParams?: Record<string, unknown> // only present when verdict === 'adjust'
  regime?: MarketRegime
}

export type MarketRegime = 'trending' | 'ranging' | 'volatile' | 'quiet'

// ─── Agent Evaluator Interface ──────────────────────────────────
export interface AgentEvaluator {
  /** Evaluate a concrete trade proposal. Always calls LLM (no caching). */
  evaluate(proposal: TradeProposal, journal: Journal): Promise<AgentEvaluation>
  /** Detect market regime. Cached for evaluationCadenceMs. */
  detectRegime(snapshot: MarketSnapshot): Promise<{ regime: MarketRegime; confidence: number }>
  status(): AgentStatus
}

export interface AgentStatus {
  enabled: boolean
  lastEvaluation: string | null
  lastRegimeCheck: string | null
  currentRegime: MarketRegime | null
  evaluationCount: number
  callsThisHour: number
  budgetRemaining: { calls: number; tokens: number }
}

// ─── Journal Interface ──────────────────────────────────────────
export interface Journal {
  recordEvaluation(entry: EvaluationEntry): void
  recordOutcome(entry: OutcomeEntry): void
  recordAdjustment(entry: AdjustmentEntry): void
  getEntries(filter?: { strategyId?: string; type?: string; limit?: number }): JournalEntry[]
  /** MAD-based confidence score. Returns null if < 5 outcomes. */
  getConfidenceScore(strategyId: string): number | null
  /** Returns compact text summary for LLM context window. */
  getSummary(strategyId: string, lastN?: number): string
  /** Rebuild in-memory state from JSONL on startup. */
  reconstruct(): void
  /** Flush buffered writes (used by sandbox for batch mode). */
  flush(): void
}

export type JournalEntry = EvaluationEntry | OutcomeEntry | AdjustmentEntry

export interface EvaluationEntry {
  type: 'evaluation'
  timestamp: string
  strategyId: string
  proposal: TradeProposal
  verdict: AgentVerdict
  confidence: number
  reasoning: string
  regime: MarketRegime | null
  asi: Record<string, string> // actionable side information
}

export interface OutcomeEntry {
  type: 'outcome'
  timestamp: string
  strategyId: string
  evaluationTimestamp: string // links back to evaluation
  pnl: number
  holdDurationMs: number
  exitReason: string
  metrics: Record<string, number>
}

export interface AdjustmentEntry {
  type: 'adjustment'
  timestamp: string
  strategyId: string
  previousParams: Record<string, unknown>
  newParams: Record<string, unknown>
  reasoning: string
  confidence: number // agent's self-assessed confidence
  madConfidence?: number // computed later after outcomes, null until 5+ trades
  status: 'applied' | 'persisted' | 'reverted'
}

// ─── Proposable Strategy Extension ──────────────────────────────
export interface ProposableStrategy {
  /** Gather market data + evaluate conditions. Returns null if no action needed. Pure read, no side effects. */
  propose(ctx: Context): Promise<TradeProposal | null>
  /** Execute trade based on agent evaluation. Side effects: exchange calls, DB writes, alerts. */
  execute(ctx: Context, evaluation: AgentEvaluation): Promise<void>
}

// ─── Shared Helpers ─────────────────────────────────────────────
import type { Strategy } from './index.js'

export const DEFAULT_EVALUATION: AgentEvaluation = {
  verdict: 'approve',
  confidence: 1,
  reasoning: 'no agent',
}

export function isProposable(s: Strategy): s is Strategy & ProposableStrategy {
  return 'propose' in s && typeof (s as Record<string, unknown>).propose === 'function'
}

export function applyAdjustedParams(strategy: Strategy, params: Record<string, unknown>): Record<string, unknown> {
  const strat = strategy as unknown as { config?: Record<string, unknown> }
  const previous = strat.config ? { ...strat.config } : {}
  if (strat.config) Object.assign(strat.config, params)
  return previous
}

// ─── Agent Config (added to AppConfig) ──────────────────────────
export interface AgentConfig {
  enabled: boolean
  provider: string // 'anthropic' | 'openai' | etc.
  model: string
  apiKey: string
  evaluationCadenceMs: number // regime detection cadence, e.g. 300000 (5 min)
  evaluationTimeoutMs: number // LLM call timeout, default 10000
  confidenceThreshold: number // MAD threshold for persisting param changes, e.g. 2.0
  revertThreshold: number // MAD threshold below which to revert, e.g. 1.0
  budget: {
    maxCallsPerHour: number
    maxTokensPerDay: number
  }
  journalPath: string
}

// ─── Sandbox Types ──────────────────────────────────────────────
export interface MarketDataPoint {
  timestamp: string
  price: number
  twilightFundingRate: number
  binanceFundingRate: number
  volume?: number
  volatility?: number
  lendingApy?: number
}

export interface SandboxConfig {
  dataPath: string
  strategyId: string
  startDate?: string
  endDate?: string
  dryRun: boolean // skip LLM calls, use mock evaluator
  cacheDir?: string // persistent LLM response cache
}

export interface SandboxReport {
  totalPnl: number
  tradeCount: number
  winRate: number
  sharpeRatio: number
  maxDrawdown: number
  agentDecisions: { approved: number; rejected: number; adjusted: number }
  regimeBreakdown: Record<MarketRegime, number>
  durationMs: number
}

// ─── Twilight Historical Data API ───────────────────────────────
export interface TwilightHistoricalFundingRate {
  id: number
  price: string // decimal string
  rate: string // decimal string
  timestamp: string // ISO 8601
}
