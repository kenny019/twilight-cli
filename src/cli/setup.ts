import inquirer from 'inquirer'
import type { AppConfig } from '../types/index.js'

export interface SetupOptions {
  dryRun?: boolean
}

export async function runSetupWizard(options?: SetupOptions): Promise<AppConfig> {
  // Step 1: Wallet setup
  const walletAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletAction',
      message: 'Wallet setup: create a new wallet or import existing?',
      choices: ['create', 'import'],
    },
  ])

  // Step 2: Binance API keys
  const binanceAnswers = await inquirer.prompt([
    { type: 'input', name: 'apiKey', message: 'Binance API key:' },
    { type: 'password', name: 'apiSecret', message: 'Binance API secret:' },
  ])

  // Step 3: Discord webhook
  const discordAnswers = await inquirer.prompt([
    { type: 'input', name: 'webhookUrl', message: 'Discord webhook URL (optional):' },
  ])

  // Step 4: Strategy selection
  const strategyAnswers = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'strategies',
      message: 'Select strategies to enable:',
      choices: ['funding-arb', 'lending-yield'],
    },
  ])

  // Step 5: Risk profile
  const riskAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'riskProfile',
      message: 'Select risk profile:',
      choices: ['conservative', 'moderate', 'aggressive'],
    },
  ])

  const config: AppConfig = {
    twilight: {
      walletId: walletAnswers.walletAction === 'create' ? 'new-wallet' : 'imported-wallet',
      password: '',
      binaryPath: '/usr/local/bin/twilight',
    },
    binance: {
      apiKey: binanceAnswers.apiKey,
      apiSecret: binanceAnswers.apiSecret,
    },
    discord: {
      webhookUrl: discordAnswers.webhookUrl,
    },
    strategies: strategyAnswers.strategies,
    riskProfile: riskAnswers.riskProfile,
    server: {
      port: 3000,
      bearerToken: crypto.randomUUID(),
    },
  }

  if (!options?.dryRun) {
    const { writeFile } = await import('fs/promises')
    await writeFile('twilight-bots.config.json', JSON.stringify(config, null, 2))
  }

  return config
}
