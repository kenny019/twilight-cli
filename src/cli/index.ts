import { Command } from 'commander'
import { runSetupWizard } from './setup.js'

export interface ProgramOptions {
  apiUrl?: string
  token?: string
  exitOverride?: boolean
}

export function createProgram(options?: ProgramOptions): Command {
  const apiUrl = options?.apiUrl ?? 'http://localhost:3000'
  const token = options?.token ?? ''

  const program = new Command()
  program.name('twilight-bots')
  if (options?.exitOverride) program.exitOverride()

  program
    .command('setup')
    .description('Run the interactive setup wizard')
    .action(async () => {
      await runSetupWizard()
    })

  program
    .command('status')
    .description('Show bot status')
    .action(async () => {
      try {
        await fetch(apiUrl + '/status', {
          headers: { Authorization: 'Bearer ' + token },
        })
      } catch (err) {
        console.error('Connection error:', (err as Error).message)
      }
    })

  program
    .command('start <strategy>')
    .description('Start a strategy')
    .action(async (strategy: string) => {
      try {
        await fetch(apiUrl + '/strategies/' + strategy + '/start', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
        })
      } catch (err) {
        console.error('Connection error:', (err as Error).message)
      }
    })

  program
    .command('stop <strategy>')
    .description('Stop a strategy')
    .action(async (strategy: string) => {
      try {
        await fetch(apiUrl + '/strategies/' + strategy + '/stop', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
        })
      } catch (err) {
        console.error('Connection error:', (err as Error).message)
      }
    })

  program
    .command('config')
    .description('View or edit configuration')
    .action(() => {
      console.log('config command — not yet implemented')
    })

  program
    .command('wallet')
    .description('Manage wallet')
    .action(() => {
      console.log('wallet command — not yet implemented')
    })

  program
    .command('market')
    .description('Show market data')
    .action(() => {
      // no-op for now
    })

  program
    .command('logs')
    .description('Show logs')
    .action(() => {
      console.log('logs command — not yet implemented')
    })

  // ─── Sandbox commands ──────────────────────────────────────────
  const sandbox = program
    .command('sandbox')
    .description('Run strategy backtests in sandbox mode')
    .option('--data <path>', 'Path to market data CSV/JSON file')
    .option('--strategy <id>', 'Strategy ID to test (e.g. funding-arb)')
    .option('--dry-run', 'Skip LLM calls, use mock evaluator', false)
    .option('--cache-dir <path>', 'Cache directory for LLM responses')
    .action(async (opts) => {
      // Default action: alias for `sandbox run`
      if (opts.data && opts.strategy) {
        const { runSandbox } = await import('../sandbox/cli-handler.js')
        await runSandbox(opts)
      } else {
        sandbox.outputHelp()
      }
    })

  sandbox
    .command('run')
    .description('Run sandbox replay against historical data')
    .requiredOption('--data <path>', 'Path to market data CSV/JSON file')
    .requiredOption('--strategy <id>', 'Strategy ID to test (e.g. funding-arb)')
    .option('--dry-run', 'Skip LLM calls, use mock evaluator', false)
    .option('--cache-dir <path>', 'Cache directory for LLM responses')
    .action(async (opts) => {
      const { runSandbox } = await import('../sandbox/cli-handler.js')
      await runSandbox(opts)
    })

  sandbox
    .command('fetch')
    .description('Fetch historical market data')
    .requiredOption('--symbol <pair>', 'Trading pair (e.g. BTC/USDT)')
    .requiredOption('--from <date>', 'Start date (YYYY-MM-DD)')
    .requiredOption('--to <date>', 'End date (YYYY-MM-DD)')
    .requiredOption('--twilight-api <url>', 'Twilight API endpoint')
    .requiredOption('--output <path>', 'Output CSV file path')
    .action(async (opts) => {
      const { runFetch } = await import('../sandbox/cli-handler.js')
      await runFetch(opts)
    })

  return program
}
