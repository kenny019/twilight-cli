import { Command } from 'commander'
import { runSetupWizard } from './setup.js'

export interface ProgramOptions {
  apiUrl?: string
  token?: string
}

export function createProgram(options?: ProgramOptions): Command {
  const apiUrl = options?.apiUrl ?? 'http://localhost:3000'
  const token = options?.token ?? ''

  const program = new Command()
  program.name('twilight-bots')
  program.exitOverride()

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

  return program
}
