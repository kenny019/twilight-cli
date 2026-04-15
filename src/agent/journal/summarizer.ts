import type {
  JournalEntry,
  EvaluationEntry,
  OutcomeEntry,
  AdjustmentEntry,
  MarketRegime,
} from '../../types/agent.js'
import { computeMADConfidence } from './confidence.js'

const DEFAULT_LAST_N = 20

export function summarize(
  entries: JournalEntry[],
  strategyId: string,
  lastN?: number,
): string {
  const limit = lastN ?? DEFAULT_LAST_N
  const filtered = entries
    .filter((e) => e.strategyId === strategyId)
    .slice(-limit)

  if (filtered.length === 0) return `No journal entries for strategy ${strategyId}.`

  const evals = filtered.filter((e): e is EvaluationEntry => e.type === 'evaluation')
  const outcomes = filtered.filter((e): e is OutcomeEntry => e.type === 'outcome')
  const adjustments = filtered.filter((e): e is AdjustmentEntry => e.type === 'adjustment')

  const lines: string[] = []

  // Verdict counts
  if (evals.length > 0) {
    const approved = evals.filter((e) => e.verdict === 'approve').length
    const rejected = evals.filter((e) => e.verdict === 'reject').length
    const adjusted = evals.filter((e) => e.verdict === 'adjust').length
    lines.push(
      `Last ${evals.length} evals: ${approved} approved, ${rejected} rejected, ${adjusted} adjusted.`,
    )
  }

  // Outcome stats
  if (outcomes.length > 0) {
    const pnls = outcomes.map((o) => o.pnl)
    const wins = pnls.filter((p) => p > 0).length
    const winRate = Math.round((wins / pnls.length) * 100)
    const avgPnl = Math.round(pnls.reduce((s, v) => s + v, 0) / pnls.length)
    const maxLoss = Math.min(...pnls)
    const sign = avgPnl >= 0 ? '+' : ''
    lines.push(`Win rate: ${winRate}%. Avg PnL: ${sign}${avgPnl} sats. Max loss: ${maxLoss} sats.`)
  }

  // Latest regime
  const regimeEval = [...evals].reverse().find((e) => e.regime !== null)
  if (regimeEval) {
    lines.push(`Regime: ${regimeEval.regime}.`)
  }

  // Active (non-reverted) adjustment
  const activeAdj = [...adjustments].reverse().find((a) => a.status !== 'reverted')
  if (activeAdj) {
    const paramChanges = Object.keys(activeAdj.newParams)
      .map((k) => `${k} ${String(activeAdj.previousParams[k] ?? '?')}→${String(activeAdj.newParams[k])}`)
      .join(', ')

    const stratOutcomes = outcomes.filter(
      (o) => o.timestamp >= activeAdj.timestamp,
    )
    const pnls = stratOutcomes.map((o) => o.pnl)
    const madConf = computeMADConfidence(pnls)
    const confStr = madConf !== null ? madConf.toFixed(1) : 'n/a'

    lines.push(
      `Active adjustment: ${paramChanges} (${stratOutcomes.length} outcomes, MAD confidence: ${confStr}, ${activeAdj.status}).`,
    )
  }

  return lines.join(' ')
}
