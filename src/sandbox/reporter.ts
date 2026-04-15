import type { SandboxReport, EvaluationEntry, OutcomeEntry, MarketRegime } from '../types/agent.js'

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((sum, v) => sum + v, 0) / arr.length
}

export function std(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1)
  return Math.sqrt(variance)
}

export function computeMaxDrawdown(pnls: number[]): number {
  if (pnls.length === 0) return 0

  let cumulative = 0
  let peak = 0
  let maxDd = 0

  for (const pnl of pnls) {
    cumulative += pnl
    if (cumulative > peak) peak = cumulative
    const dd = peak - cumulative
    if (dd > maxDd) maxDd = dd
  }

  return maxDd
}

export function computeReport(
  outcomes: OutcomeEntry[],
  evaluations: EvaluationEntry[],
  durationMs: number,
): SandboxReport {
  const totalPnl = outcomes.reduce((sum, o) => sum + o.pnl, 0)
  const tradeCount = outcomes.length
  const wins = outcomes.filter((o) => o.pnl > 0).length
  const winRate = tradeCount > 0 ? wins / tradeCount : 0

  // Sharpe: group outcomes by day, sum PnL per day, annualize
  const dailyMap = new Map<string, number>()
  for (const o of outcomes) {
    const day = o.timestamp.slice(0, 10) // YYYY-MM-DD
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + o.pnl)
  }
  const dailyReturns = Array.from(dailyMap.values())
  let sharpeRatio = 0
  if (dailyReturns.length >= 2) {
    const s = std(dailyReturns)
    sharpeRatio = s > 0 ? (mean(dailyReturns) / s) * Math.sqrt(365) : 0
  }

  const maxDrawdown = computeMaxDrawdown(outcomes.map((o) => o.pnl))

  // Agent decision counts
  const agentDecisions = { approved: 0, rejected: 0, adjusted: 0 }
  for (const e of evaluations) {
    if (e.verdict === 'approve') agentDecisions.approved++
    else if (e.verdict === 'reject') agentDecisions.rejected++
    else if (e.verdict === 'adjust') agentDecisions.adjusted++
  }

  // Regime breakdown
  const regimeBreakdown: Record<MarketRegime, number> = {
    trending: 0,
    ranging: 0,
    volatile: 0,
    quiet: 0,
  }
  for (const e of evaluations) {
    if (e.regime && e.regime in regimeBreakdown) {
      regimeBreakdown[e.regime]++
    }
  }

  return {
    totalPnl,
    tradeCount,
    winRate,
    sharpeRatio,
    maxDrawdown,
    agentDecisions,
    regimeBreakdown,
    durationMs,
  }
}
