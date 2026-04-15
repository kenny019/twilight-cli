import { existsSync } from 'fs'
import { execFile as nodeExecFile } from 'node:child_process'
import { platform, arch } from 'os'
import { resolve } from 'path'
import inquirer from 'inquirer'
import { execFileAsync } from '../utils/exec.js'
import type { AppConfig } from '../types/index.js'

const RELAYER_REPO = 'https://github.com/twilight-project/nyks-wallet.git'
const RELAYER_RELEASES = 'https://github.com/twilight-project/nyks-wallet/releases/latest/download'

export interface SetupOptions {
  dryRun?: boolean
}

function shellExec(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    nodeExecFile(command, args, { cwd: options?.cwd, env: options?.env, timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) rej(err)
      else res({ stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

/** Run a command string through the shell (for pipes, env prefixes, etc.) */
function shellRun(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    nodeExecFile('sh', ['-c', command], { cwd, timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) rej(err)
      else res({ stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

function relayerAssetName(): string {
  const os = platform() === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'
  const cpu = arch() === 'arm64' ? 'aarch64' : 'x86_64'
  return `relayer-cli-${cpu}-${os}`
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await shellExec('which', [cmd])
    return true
  } catch {
    return false
  }
}

/** Minimum Rust version required (edition 2024 support) */
const MIN_RUST_VERSION = '1.85.0'

function parseVersion(v: string): number[] {
  return v.split('.').map(Number)
}

function versionLt(a: string, b: string): boolean {
  const pa = parseVersion(a), pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}

async function getRustVersion(): Promise<string | null> {
  try {
    const { stdout } = await shellExec('cargo', ['--version'])
    const match = stdout.match(/cargo (\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

async function upgradeRust(): Promise<boolean> {
  try {
    console.log('  Upgrading Rust toolchain...')
    await shellRun('rustup update stable')
    const newVersion = await getRustVersion()
    if (newVersion) {
      console.log(`  Rust upgraded to ${newVersion}.\n`)
    }
    return true
  } catch {
    return false
  }
}

interface DepCheck {
  name: string
  command: string
  brewPkg: string
  aptPkg: string
}

const BUILD_DEPS: DepCheck[] = [
  { name: 'Rust (cargo)', command: 'cargo', brewPkg: '', aptPkg: '' },
  { name: 'protoc', command: 'protoc', brewPkg: 'protobuf', aptPkg: 'protobuf-compiler' },
  { name: 'pkg-config', command: 'pkg-config', brewPkg: 'pkg-config', aptPkg: 'pkg-config' },
  { name: 'cmake', command: 'cmake', brewPkg: 'cmake', aptPkg: 'cmake' },
]

async function checkBuildDeps(): Promise<void> {
  const isMac = platform() === 'darwin'
  const missing: DepCheck[] = []

  console.log('\n  Checking build dependencies...')
  for (const dep of BUILD_DEPS) {
    const found = await commandExists(dep.command)
    const status = found ? 'ok' : 'MISSING'
    console.log(`    ${dep.name}: ${status}`)
    if (!found) missing.push(dep)
  }

  // Check libpq separately (header, not a command)
  if (isMac) {
    const libpqExists = existsSync('/opt/homebrew/opt/libpq/lib') || existsSync('/usr/local/opt/libpq/lib')
    console.log(`    libpq: ${libpqExists ? 'ok' : 'MISSING'}`)
    if (!libpqExists) {
      missing.push({ name: 'libpq', command: '', brewPkg: 'libpq', aptPkg: 'libpq-dev' })
    }
  }

  // Handle Rust separately — needs rustup, not a package manager
  const missingRust = missing.find(d => d.command === 'cargo')
  const missingPkgs = missing.filter(d => d.command !== 'cargo')

  if (missingRust) {
    console.log('\n  Rust toolchain not found.')
    const { installRust } = await inquirer.prompt([
      { type: 'confirm', name: 'installRust', message: 'Install Rust via rustup?', default: true },
    ])
    if (installRust) {
      console.log('  Installing Rust...')
      await shellRun('curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y')
      // Source cargo env for the rest of this process
      process.env.PATH = `${process.env.HOME}/.cargo/bin:${process.env.PATH}`
    } else {
      throw new Error('Rust is required to build relayer-cli. Install from https://rustup.rs')
    }
  }

  // Check Rust version is new enough (edition 2024 requires >= 1.85.0)
  const rustVersion = await getRustVersion()
  if (rustVersion) {
    console.log(`    Rust version: ${rustVersion}`)
    if (versionLt(rustVersion, MIN_RUST_VERSION)) {
      console.log(`\n  Rust ${rustVersion} is too old (need >= ${MIN_RUST_VERSION} for edition 2024).`)
      const { doUpgrade } = await inquirer.prompt([
        { type: 'confirm', name: 'doUpgrade', message: 'Upgrade Rust via "rustup update stable"?', default: true },
      ])
      if (doUpgrade) {
        const ok = await upgradeRust()
        if (!ok) {
          throw new Error(`Failed to upgrade Rust. Run "rustup update stable" manually.`)
        }
        const newVersion = await getRustVersion()
        if (newVersion && versionLt(newVersion, MIN_RUST_VERSION)) {
          throw new Error(`Rust upgraded to ${newVersion} but ${MIN_RUST_VERSION}+ is required. Try "rustup install nightly".`)
        }
      } else {
        throw new Error(`Rust ${MIN_RUST_VERSION}+ is required. Run "rustup update stable" manually.`)
      }
    }
  }

  if (missing.length === 0) {
    console.log('  All dependencies found.\n')
    return
  }

  if (missingPkgs.length > 0) {
    const names = missingPkgs.map(d => d.name).join(', ')
    const pkgs = isMac
      ? missingPkgs.map(d => d.brewPkg).filter(Boolean).join(' ')
      : missingPkgs.map(d => d.aptPkg).filter(Boolean).join(' ')
    const installCmd = isMac ? `brew install ${pkgs}` : `sudo apt-get install -y ${pkgs}`

    console.log(`\n  Missing: ${names}`)
    const { installDeps } = await inquirer.prompt([
      { type: 'confirm', name: 'installDeps', message: `Run "${installCmd}"?`, default: true },
    ])
    if (installDeps) {
      console.log(`  Running: ${installCmd}`)
      await shellRun(installCmd)
      console.log('  Dependencies installed.\n')
    } else {
      throw new Error(`Missing dependencies: ${names}. Install them manually and re-run setup.`)
    }
  }
}

/** Parse plain-text wallet output (binary ignores --json for wallet commands) */
function parseWalletOutput(stdout: string): { walletId: string; address: string; btcAddress: string } {
  const walletId = stdout.match(/Wallet ID:\s*(.+)/)?.[1]?.trim() ?? ''
  const address = stdout.match(/Address:\s*(.+)/)?.[1]?.trim() ?? ''
  const btcAddress = stdout.match(/BTC address:\s*(.+)/)?.[1]?.trim() ?? ''
  return { walletId: walletId || address, address, btcAddress }
}

/** List wallet IDs already stored in the database */
async function listExistingWallets(binaryPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['wallet', 'list'], { timeout: 10_000 })
    // Parse the table: lines between the dashes header and the "Total:" footer
    const ids: string[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('WALLET') || trimmed.startsWith('Total:')) continue
      const id = trimmed.split(/\s{2,}/)[0] // wallet ID is the first column
      if (id) ids.push(id)
    }
    return ids
  } catch {
    return []
  }
}

async function verifyBinary(binaryPath: string): Promise<boolean> {
  try {
    await execFileAsync(binaryPath, ['--help'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

async function ensureBinary(dryRun?: boolean): Promise<string> {
  const defaultPath = resolve('bin/relayer-cli')

  // Check common locations
  const candidates = [defaultPath, resolve('./target/release/relayer-cli'), '/usr/local/bin/relayer-cli']
  const found = candidates.find(p => existsSync(p))
  if (found) {
    const works = await verifyBinary(found)
    if (works) {
      console.log(`\n  Found relayer-cli at ${found}\n`)
      const { useExisting } = await inquirer.prompt([
        { type: 'confirm', name: 'useExisting', message: `Use ${found}?`, default: true },
      ])
      if (useExisting) return found
    } else {
      console.log(`\n  Found binary at ${found} but it doesn't appear to be relayer-cli.\n`)
    }
  }

  const { method } = await inquirer.prompt([
    {
      type: 'list',
      name: 'method',
      message: 'relayer-cli binary not found. How would you like to install it?',
      choices: [
        { name: 'Download pre-built binary (recommended)', value: 'download' },
        { name: 'Build from source (requires Rust toolchain)', value: 'build' },
        { name: 'Provide path to existing binary', value: 'path' },
      ],
    },
  ])

  if (method === 'path') {
    const { customPath } = await inquirer.prompt([
      { type: 'input', name: 'customPath', message: 'Full path to relayer-cli:' },
    ])
    const resolved = resolve(customPath)
    if (!existsSync(resolved)) {
      throw new Error(`Binary not found at ${resolved}`)
    }
    if (!await verifyBinary(resolved)) {
      throw new Error(`Binary at ${resolved} is not a valid relayer-cli`)
    }
    console.log('  Binary verified.\n')
    return resolved
  }

  if (dryRun) return defaultPath

  if (method === 'download') {
    const asset = relayerAssetName()
    const url = `${RELAYER_RELEASES}/${asset}`
    console.log(`\n  Downloading ${asset}...`)
    await shellExec('mkdir', ['-p', 'bin'])
    try {
      await shellExec('curl', ['-fSL', '--progress-bar', '-o', defaultPath, url])
      await shellExec('chmod', ['+x', defaultPath])
      if (!await verifyBinary(defaultPath)) {
        throw new Error('Downloaded binary failed verification')
      }
      console.log(`  Installed and verified at ${defaultPath}\n`)
      return defaultPath
    } catch {
      console.error(`\n  Download failed. The release asset "${asset}" may not exist yet.`)
      console.error('  Try building from source instead.\n')
      const { fallback } = await inquirer.prompt([
        { type: 'confirm', name: 'fallback', message: 'Build from source instead?', default: true },
      ])
      if (!fallback) throw new Error('relayer-cli installation aborted')
      // Fall through to build
    }
  }

  // Build from source — check dependencies first
  await checkBuildDeps()

  const { repoSource } = await inquirer.prompt([
    {
      type: 'list',
      name: 'repoSource',
      message: 'Relayer source:',
      choices: [
        { name: `Clone from ${RELAYER_REPO}`, value: 'clone' },
        { name: 'Use local directory', value: 'local' },
      ],
    },
  ])

  let buildDir: string
  if (repoSource === 'clone') {
    const cloneTarget = resolve('.relayer-src')
    console.log(`\n  Cloning into ${cloneTarget}...`)
    if (existsSync(cloneTarget)) {
      await shellExec('git', ['-C', cloneTarget, 'pull'])
    } else {
      await shellExec('git', ['clone', '--depth', '1', RELAYER_REPO, cloneTarget])
    }
    buildDir = cloneTarget
  } else {
    const { localDir } = await inquirer.prompt([
      { type: 'input', name: 'localDir', message: 'Path to relayer source directory:' },
    ])
    buildDir = resolve(localDir)
  }

  console.log('\n  Building relayer-cli (this may take a few minutes)...')
  const buildArgs = ['build', '--release', '--bin', 'relayer-cli']
  const buildEnv = platform() === 'darwin'
    ? { ...process.env, RUSTFLAGS: '-L /opt/homebrew/opt/libpq/lib' }
    : undefined

  const attemptBuild = () => shellExec('cargo', buildArgs, { cwd: buildDir, env: buildEnv })

  try {
    await attemptBuild()
  } catch (buildErr) {
    const msg = (buildErr as Error).message ?? ''
    // Auto-resolve: outdated Rust toolchain
    if (msg.includes('edition2024') || msg.includes('edition 2024') || msg.includes('newer version of Cargo')) {
      console.error('\n  Build failed: Rust toolchain is too old for this crate.')
      const ok = await upgradeRust()
      if (!ok) throw new Error('Rust upgrade failed. Run "rustup update stable" manually, then re-run setup.')
      console.log('  Retrying build...\n')
      await attemptBuild()
    } else {
      // Surface the error clearly and suggest re-running
      console.error(`\n  Build failed:\n  ${msg.split('\n').slice(0, 8).join('\n  ')}`)
      throw new Error('cargo build failed. Fix the issue above and re-run "npx twilight-bots setup".')
    }
  }

  const builtBinary = resolve(buildDir, 'target/release/relayer-cli')
  if (!existsSync(builtBinary)) {
    throw new Error(`Build succeeded but binary not found at ${builtBinary}`)
  }

  // Copy to bin/
  await shellExec('mkdir', ['-p', 'bin'])
  await shellExec('cp', [builtBinary, defaultPath])
  if (!await verifyBinary(defaultPath)) {
    throw new Error('Built binary failed verification')
  }
  console.log(`  Installed and verified at ${defaultPath}\n`)
  return defaultPath
}

export async function runSetupWizard(options?: SetupOptions): Promise<AppConfig> {
  console.log('\n  Twilight Bots — Setup Wizard\n')

  // Step 1: Ensure relayer-cli binary
  console.log('  Step 1/7: relayer-cli binary')
  const binaryPath = await ensureBinary(options?.dryRun)

  // Step 2: Wallet setup
  console.log('  Step 2/7: Twilight Wallet')

  // Check for existing wallets so we can offer to reuse them
  const existingWallets = await listExistingWallets(binaryPath)

  const walletChoices: Array<{ name: string; value: string }> = []
  if (existingWallets.length > 0) {
    for (const id of existingWallets) {
      walletChoices.push({ name: `Use existing wallet "${id}"`, value: `existing:${id}` })
    }
  }
  walletChoices.push({ name: 'Create a new wallet', value: 'create' })
  walletChoices.push({ name: 'Import from mnemonic', value: 'import' })

  const { walletAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletAction',
      message: 'Wallet setup:',
      choices: walletChoices,
    },
  ])

  const { walletPassword } = await inquirer.prompt([
    {
      type: 'password',
      name: 'walletPassword',
      message: walletAction.startsWith('existing:') ? 'Wallet password:' : 'Set wallet password:',
      validate: (input: string) => input.length > 0 || 'Password cannot be empty',
    },
  ])

  if (!walletAction.startsWith('existing:')) {
    await inquirer.prompt([
      {
        type: 'password',
        name: 'walletPasswordConfirm',
        message: 'Confirm password:',
        validate: (input: string) => input === walletPassword || 'Passwords do not match',
      },
    ])
  }

  let walletId: string

  if (walletAction.startsWith('existing:')) {
    walletId = walletAction.slice('existing:'.length)
    // Verify the password works by loading the wallet
    try {
      await execFileAsync(binaryPath, [
        'wallet', 'load',
        '--wallet-id', walletId,
        '--password', walletPassword,
      ])
      console.log(`\n  Wallet "${walletId}" loaded successfully.\n`)
    } catch (err) {
      throw new Error(`Failed to load wallet "${walletId}": ${(err as Error).message}\nCheck your password.`)
    }
  } else if (walletAction === 'create') {
    const { walletName } = await inquirer.prompt([
      { type: 'input', name: 'walletName', message: 'Wallet ID (name):', default: 'default' },
    ])

    try {
      const { stdout } = await execFileAsync(binaryPath, [
        'wallet', 'create',
        '--wallet-id', walletName,
        '--password', walletPassword,
      ])
      const result = parseWalletOutput(stdout)
      walletId = result.walletId

      console.log(`\n  Wallet created successfully`)
      console.log(`    Address:     ${result.address}`)
      console.log(`    BTC address: ${result.btcAddress}`)
      console.log(`    Wallet ID:   ${walletId}\n`)
    } catch (err) {
      throw new Error(`Wallet creation failed: ${(err as Error).message}\nIs relayer-cli at "${binaryPath}" working?`)
    }
  } else {
    const { mnemonic, walletName } = await inquirer.prompt([
      { type: 'password', name: 'mnemonic', message: 'Enter 24-word mnemonic:' },
      { type: 'input', name: 'walletName', message: 'Wallet ID (name):', default: 'default' },
    ])

    try {
      const { stdout } = await execFileAsync(binaryPath, [
        'wallet', 'import',
        '--mnemonic', mnemonic,
        '--wallet-id', walletName,
        '--password', walletPassword,
      ])
      const result = parseWalletOutput(stdout)
      walletId = result.walletId
      console.log(`\n  Wallet "${walletId}" imported successfully.\n`)
    } catch (err) {
      throw new Error(`Wallet import failed: ${(err as Error).message}`)
    }
  }

  // Step 3: Binance API keys (required for funding-arb hedge leg; optional for lending-yield)
  console.log('  Step 3/7: Binance API Keys')
  console.log('  Needed for funding-arb (hedge leg on Binance Futures). Press Enter to skip.\n')
  const binanceAnswers = await inquirer.prompt([
    { type: 'input', name: 'apiKey', message: 'Binance API key (optional):' },
    { type: 'password', name: 'apiSecret', message: 'Binance API secret (optional):' },
  ])

  const hasBinanceKeys = !!(binanceAnswers.apiKey?.trim() && binanceAnswers.apiSecret?.trim())
  if (hasBinanceKeys && !options?.dryRun) {
    console.log('  Verifying Binance connection...')
    try {
      const { default: ccxt } = await import('ccxt')
      const exchange = new (ccxt as any).binanceusdm({
        apiKey: binanceAnswers.apiKey.trim(),
        secret: binanceAnswers.apiSecret.trim(),
        options: { defaultType: 'future' },
      })
      const balance = await exchange.fetchBalance()
      console.log('  Binance connection verified (Futures account active).\n')
      await exchange.close()
    } catch (err) {
      const msg = (err as Error).message
      const hint = msg.includes('secret') || msg.includes('credential')
        ? 'API key or secret is invalid.'
        : msg.includes('permission') || msg.includes('403')
          ? 'API key needs USD-M Futures trading permission.'
          : msg
      console.error(`  WARNING: Binance verification failed — ${hint}\n`)
      const { proceed } = await inquirer.prompt([
        { type: 'confirm', name: 'proceed', message: 'Continue without Binance?', default: true },
      ])
      if (!proceed) throw new Error('Setup aborted — fix Binance API keys and retry.')
      binanceAnswers.apiKey = ''
      binanceAnswers.apiSecret = ''
    }
  } else if (!hasBinanceKeys) {
    console.log('  Skipped — funding-arb strategy will be unavailable.\n')
  }

  // Step 4: Discord webhook
  console.log('  Step 4/7: Discord Alerts')
  const discordAnswers = await inquirer.prompt([
    { type: 'input', name: 'webhookUrl', message: 'Discord webhook URL (optional, press Enter to skip):' },
  ])

  if (discordAnswers.webhookUrl && !options?.dryRun) {
    console.log('  Sending test message...')
    try {
      const resp = await fetch(discordAnswers.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: 'Twilight Bots — Setup Complete',
            description: 'Discord alerts are working. You will receive trade notifications here.',
            color: 0x00ff00,
          }],
        }),
      })
      if (resp.ok) {
        console.log('  Test message sent — check your Discord channel.\n')
      } else {
        console.error(`  WARNING: Discord returned ${resp.status}. Check your webhook URL.\n`)
      }
    } catch {
      console.error('  WARNING: Could not reach Discord. Alerts will fall back to console.\n')
    }
  }

  // Step 5: Strategy selection
  console.log('  Step 5/7: Strategy Selection')
  const hasBinance = !!(binanceAnswers.apiKey?.trim() && binanceAnswers.apiSecret?.trim())
  const strategyChoices = [
    ...(hasBinance ? [{ name: 'funding-arb', value: 'funding-arb', checked: true }] : []),
    { name: 'lending-yield', value: 'lending-yield', checked: true },
  ]
  const strategyAnswers = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'strategies',
      message: 'Select strategies to enable:',
      choices: strategyChoices,
      validate: (input: string[]) => input.length > 0 || 'Select at least one strategy.',
    },
  ])

  // Step 6: Risk profile
  console.log('  Step 6/7: Risk Profile')
  const riskAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'riskProfile',
      message: 'Select risk profile:',
      choices: ['conservative', 'moderate', 'aggressive'],
    },
  ])

  // Step 7: AI Agent (Optional)
  console.log('  Step 7/7: AI Agent (Optional)')
  const { enableAgent } = await inquirer.prompt([
    { type: 'confirm', name: 'enableAgent', message: 'Enable AI agent evaluation?', default: false },
  ])

  let agentConfig: AppConfig['agent'] | undefined
  if (enableAgent) {
    const agentAnswers = await inquirer.prompt([
      {
        type: 'list',
        name: 'provider',
        message: 'LLM provider:',
        choices: ['anthropic', 'openai', 'google'],
        default: 'anthropic',
      },
      {
        type: 'password',
        name: 'apiKey',
        message: 'API key:',
        validate: (input: string) => input.length > 0 || 'API key cannot be empty',
      },
      {
        type: 'input',
        name: 'model',
        message: 'Model:',
        default: 'claude-sonnet-4-20250514',
      },
      {
        type: 'number',
        name: 'cadence',
        message: 'Evaluation cadence (ms):',
        default: 300000,
      },
      {
        type: 'number',
        name: 'maxCalls',
        message: 'Max calls/hour:',
        default: 60,
      },
      {
        type: 'number',
        name: 'maxTokens',
        message: 'Max tokens/day:',
        default: 500000,
      },
    ])

    agentConfig = {
      enabled: true,
      provider: agentAnswers.provider,
      model: agentAnswers.model,
      apiKey: agentAnswers.apiKey,
      evaluationCadenceMs: agentAnswers.cadence,
      evaluationTimeoutMs: 10000,
      confidenceThreshold: 2.0,
      revertThreshold: 1.0,
      budget: {
        maxCallsPerHour: agentAnswers.maxCalls,
        maxTokensPerDay: agentAnswers.maxTokens,
      },
      journalPath: 'agent-journal.jsonl',
    }
  }

  const config: AppConfig = {
    twilight: {
      walletId,
      password: walletPassword,
      binaryPath,
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
    ...(agentConfig ? { agent: agentConfig } : {}),
  }

  if (!options?.dryRun) {
    const { writeFile } = await import('fs/promises')
    await writeFile('twilight-bots.config.json', JSON.stringify(config, null, 2))
  }

  console.log('\n  ── Setup Complete ──────────────────────────────────────────')
  console.log(`  Config written to: twilight-bots.config.json`)
  console.log(`  Wallet:            ${walletId}`)
  console.log(`  Strategies:        ${config.strategies.length > 0 ? config.strategies.join(', ') : '(none selected)'}`)
  console.log(`  Risk profile:      ${config.riskProfile}`)
  console.log(`  API port:          ${config.server.port}`)
  console.log(`  Bearer token:      ${config.server.bearerToken}`)
  if (config.agent?.enabled) {
    console.log(`  AI Agent:          enabled (${config.agent.provider}/${config.agent.model})`)
  }
  console.log(`\n  Next: run "npm run dev" to start the bot.\n`)

  return config
}
