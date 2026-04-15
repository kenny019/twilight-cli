import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type { SandboxReport, MarketRegime } from '../types/agent.js'

export interface SandboxRunOpts {
  data: string
  strategy: string
  dryRun: boolean
  cacheDir?: string
}

export interface FetchOpts {
  symbol: string
  from: string
  to: string
  twilightApi: string
  output: string
}

function formatPnl(sats: number): string {
  const sign = sats >= 0 ? '+' : ''
  return `${sign}${sats.toLocaleString()} sats`
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function printReport(report: SandboxReport, strategyId: string, dataPoints: number): void {
  const line = '\u2500'.repeat(49)

  console.log(`\n\u2500\u2500 Sandbox Report \u2500${line}`)
  console.log(`  Strategy:      ${strategyId}`)
  console.log(`  Data points:   ${dataPoints}`)
  console.log(`  Duration:      ${formatDuration(report.durationMs)}`)
  console.log()
  console.log('  Performance:')
  console.log(`    Total PnL:     ${formatPnl(report.totalPnl)}`)
  console.log(`    Trade count:   ${report.tradeCount}`)
  console.log(`    Win rate:      ${formatPercent(report.winRate)}`)
  console.log(`    Sharpe ratio:  ${report.sharpeRatio.toFixed(2)}`)
  console.log(`    Max drawdown:  ${formatPnl(-report.maxDrawdown)}`)
  console.log()
  console.log('  Agent Decisions:')
  console.log(`    Approved:      ${report.agentDecisions.approved}`)
  console.log(`    Rejected:      ${report.agentDecisions.rejected}`)
  console.log(`    Adjusted:      ${report.agentDecisions.adjusted}`)
  console.log()
  console.log('  Regime Breakdown:')
  const regimes: MarketRegime[] = ['trending', 'ranging', 'volatile', 'quiet']
  for (const r of regimes) {
    console.log(`    ${r.padEnd(15)}${report.regimeBreakdown[r]}`)
  }
  console.log(`\u2500${line}\u2500`)
}

export async function runSandbox(opts: SandboxRunOpts): Promise<void> {
  const dataPath = resolve(opts.data)
  if (!existsSync(dataPath)) {
    console.error(`Error: Data file not found: ${dataPath}`)
    process.exit(1)
  }

  console.log(`Loading market data from ${dataPath}...`)

  // Pre-load data to report count before running
  const { loadMarketData } = await import('./data-loader.js')
  const data = loadMarketData(dataPath)
  console.log(`  Loaded ${data.length} data points.`)

  // Journal setup
  const journalPath = resolve(dirname(dataPath), `sandbox-journal-${Date.now()}.jsonl`)
  const { JournalImpl } = await import('../agent/journal/index.js')
  const journal = new JournalImpl(journalPath, { buffered: true })

  // Sandbox always uses dry-run evaluator (LLM evaluator requires full server context with exchange clients)
  if (!opts.dryRun) {
    console.warn('Note: Sandbox uses dry-run evaluator. Full LLM evaluation requires the running server.')
  }
  const { DryRunEvaluator } = await import('./runner.js')
  const evaluator = new DryRunEvaluator()

  // Resolve strategy class
  const strategyMap: Record<string, () => Promise<{ new(): import('../types/index.js').Strategy }>> = {
    'funding-arb': async () => (await import('../strategies/templates/funding-arb.js')).FundingArbStrategy,
    'lending-yield': async () => (await import('../strategies/templates/lending-yield.js')).LendingYieldStrategy,
  }

  const loadStrategy = strategyMap[opts.strategy]
  if (!loadStrategy) {
    console.error(`Error: Unknown strategy "${opts.strategy}". Available: ${Object.keys(strategyMap).join(', ')}`)
    process.exit(1)
  }

  const StrategyClass = await loadStrategy()

  // Build SandboxConfig and run
  const { SandboxRunner } = await import('./runner.js')
  const runner = new SandboxRunner({
    strategy: new StrategyClass(),
    evaluator,
    journal,
    preloadedData: data,
    config: {
      dataPath,
      strategyId: opts.strategy,
      dryRun: opts.dryRun,
      cacheDir: opts.cacheDir,
    },
  })

  const report = await runner.run()
  journal.flush()

  printReport(report, opts.strategy, data.length)
  console.log(`\n  Journal written to ${journalPath}`)
}

export async function runFetch(opts: FetchOpts): Promise<void> {
  console.log('Fetching historical data...')
  console.log(`  Binance: ${opts.symbol} from ${opts.from} to ${opts.to}`)
  console.log(`  Twilight: ${opts.twilightApi}`)

  const { fetchAndSave } = await import('./data-fetcher.js')
  const count = await fetchAndSave({
    symbol: opts.symbol,
    from: opts.from,
    to: opts.to,
    twilightApiEndpoint: opts.twilightApi,
    output: opts.output,
  })

  console.log(`\n  Saved ${count} data points to ${opts.output}`)
}
