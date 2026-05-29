import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createDatabase } from './db/index.js'
import { RiskManagerImpl } from './engine/risk.js'
import { Scheduler } from './engine/scheduler.js'
import { ensureZkAccounts } from './engine/prefund.js'
import { StrategyLoader } from './engine/loader.js'
import { TwilightClientImpl } from './exchanges/twilight.js'
import { BinanceClientImpl } from './exchanges/binance.js'
import { HyperliquidClientImpl } from './exchanges/hyperliquid.js'
import { DiscordAlertClient } from './alerts/discord.js'
import { FundingArbStrategy } from './strategies/templates/funding-arb.js'
import { LendingYieldStrategy } from './strategies/templates/lending-yield.js'
import { MarketMakerStrategy } from './strategies/templates/market-maker.js'
import { VolumeFarmStrategy } from './strategies/templates/volume-farm.js'
import { createLogger } from './utils/logger.js'
import { applyAdjustedParams } from './types/agent.js'
import type {
  AppConfig,
  AlertClient,
  AlertMessage,
  Logger,
  RiskCheckResult,
  Strategy,
  StrategyConfig,
  Context,
  Database,
  AgentEvaluator,
  Journal,
} from './types/index.js'

export interface SchedulerLike {
  getStatuses(): Array<{ id: string; status: string; config: object; lastTick: string | null; tickCount: number; errorCount: number }>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
}

export interface AppDeps {
  bearerToken: string
  scheduler: SchedulerLike
  db: Database
  startTime: number
  ctx?: Context
  strategies?: Map<string, Strategy>
  risk?: import('./types/index.js').RiskManager
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  // ── Health (no auth) ────────────────────────────────────────────
  app.get('/health', (c) => {
    const statuses = deps.scheduler.getStatuses()
    return c.json({
      uptime: Date.now() - deps.startTime,
      strategies: statuses.length,
    })
  })

  // ── Auth middleware (all routes below require Bearer token) ─────
  app.use('*', async (c, next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader || authHeader !== `Bearer ${deps.bearerToken}`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })

  // ── GET /status ─────────────────────────────────────────────────
  app.get('/status', (c) => {
    return c.json({ strategies: deps.scheduler.getStatuses() })
  })

  // ── GET /positions ──────────────────────────────────────────────
  app.get('/positions', (c) => {
    return c.json(deps.db.listPositions())
  })

  // ── GET /pnl ────────────────────────────────────────────────────
  app.get('/pnl', (c) => {
    const allTrades = deps.db.listTrades()
    const total = allTrades.reduce((sum, t) => sum + t.pnl, 0)

    const strategyIds = deps.scheduler.getStatuses().map((s) => s.id)
    const strategies: Record<string, number> = {}
    for (const id of strategyIds) {
      strategies[id] = deps.db.listTrades({ strategyId: id }).reduce((sum, t) => sum + t.pnl, 0)
    }

    return c.json({ total, strategies })
  })

  // ── GET /history ────────────────────────────────────────────────
  app.get('/history', (c) => {
    const strategyId = c.req.query('strategyId')
    const limitParam = c.req.query('limit')
    const filter: { strategyId?: string; limit?: number } = {}
    if (strategyId) filter.strategyId = strategyId
    if (limitParam) filter.limit = parseInt(limitParam, 10)

    return c.json(deps.db.listTrades(filter))
  })

  // ── POST /strategies/:id/start ──────────────────────────────────
  app.post('/strategies/:id/start', async (c) => {
    const id = c.req.param('id')
    const strategy = deps.db.getStrategy(id)
    if (!strategy) {
      return c.json({ error: 'Strategy not found' }, 404)
    }
    await deps.scheduler.start(id)
    return c.json({ ok: true })
  })

  // ── POST /strategies/:id/stop ───────────────────────────────────
  app.post('/strategies/:id/stop', async (c) => {
    const id = c.req.param('id')
    await deps.scheduler.stop(id)
    return c.json({ ok: true })
  })

  // ── POST /strategies/:id/disable (per-strategy soft killswitch) ─
  app.post('/strategies/:id/disable', async (c) => {
    const id = c.req.param('id')
    const strategy = deps.strategies?.get(id)
    if (!strategy) return c.json({ error: 'Strategy not found in memory' }, 404)
    const writable = strategy as unknown as { disabled?: boolean }
    if (typeof writable.disabled !== 'boolean') {
      return c.json({ error: 'Strategy does not support per-strategy disable' }, 400)
    }
    writable.disabled = true
    return c.json({ ok: true, disabled: true })
  })

  // ── POST /strategies/:id/enable ─────────────────────────────────
  app.post('/strategies/:id/enable', async (c) => {
    const id = c.req.param('id')
    const strategy = deps.strategies?.get(id)
    if (!strategy) return c.json({ error: 'Strategy not found in memory' }, 404)
    const writable = strategy as unknown as { disabled?: boolean }
    if (typeof writable.disabled !== 'boolean') {
      return c.json({ error: 'Strategy does not support per-strategy enable' }, 400)
    }
    writable.disabled = false
    return c.json({ ok: true, disabled: false })
  })

  // ── PUT /strategies/:id/config ──────────────────────────────────
  app.put('/strategies/:id/config', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json()
    const updated = deps.db.updateStrategy(id, { config: JSON.stringify(body) })
    return c.json(updated)
  })

  // ── GET /strategies/:id/logs ────────────────────────────────────
  app.get('/strategies/:id/logs', (c) => {
    const id = c.req.param('id')
    return c.json(deps.db.listAlerts({ strategyId: id }))
  })

  // ── GET /agent/status ─────────────────────────────────────────
  app.get('/agent/status', (c) => {
    if (!deps.ctx?.agent) return c.json({ enabled: false })
    return c.json(deps.ctx.agent.status())
  })

  // ── GET /agent/journal ────────────────────────────────────────
  app.get('/agent/journal', (c) => {
    if (!deps.ctx?.journal) return c.json([])
    const strategyId = c.req.query('strategyId')
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 50
    return c.json(deps.ctx.journal.getEntries({ strategyId: strategyId ?? undefined, limit }))
  })

  // ── POST /kill-switch ─────────────────────────────────────────
  app.post('/kill-switch', async (c) => {
    if (!deps.risk) return c.json({ error: 'Risk manager unavailable' }, 500)
    await deps.risk.activateKillSwitch()
    return c.json({ ok: true, killSwitch: 'active' })
  })

  // ── POST /kill-switch/release ─────────────────────────────────
  app.post('/kill-switch/release', async (c) => {
    if (!deps.risk) return c.json({ error: 'Risk manager unavailable' }, 500)
    await deps.risk.deactivateKillSwitch()
    return c.json({ ok: true, killSwitch: 'inactive' })
  })

  // ── POST /agent/override ─────────────────────────────────────
  app.post('/agent/override', async (c) => {
    if (!deps.ctx?.journal) return c.json({ error: 'Agent not enabled' }, 400)
    const { strategyId, params } = await c.req.json()
    if (!strategyId || typeof strategyId !== 'string') return c.json({ error: 'strategyId required' }, 400)
    if (!params || typeof params !== 'object') return c.json({ error: 'params object required' }, 400)

    const liveStrategy = deps.strategies?.get(strategyId)
    const previousParams = liveStrategy ? applyAdjustedParams(liveStrategy, params) : {}

    deps.ctx.journal.recordAdjustment({
      type: 'adjustment',
      timestamp: new Date().toISOString(),
      strategyId,
      previousParams,
      newParams: params,
      reasoning: 'manual override via API',
      confidence: 1,
      status: 'persisted',
    })
    // Write merged config to DB so it survives restart
    deps.db.updateStrategy(strategyId, { config: JSON.stringify({ ...previousParams, ...params }) })
    return c.json({ ok: true })
  })

  return app
}

// ── Bootstrap (skipped when imported by tests) ───────────────────

function buildConsoleAlertClient(logger: Logger): AlertClient {
  return {
    send: async (message: AlertMessage) => { logger.info('alert', { type: message.type, title: message.title }); return true },
    sendTradeAlert: async (strategyId: string, action: string, details: Record<string, unknown>) => { logger.info('trade alert', { strategyId, action, ...details }); return true },
    sendErrorAlert: async (strategyId: string, error: Error) => { logger.error('error alert', { strategyId, error: error.message }); return true },
    sendRiskAlert: async (strategyId: string, check: RiskCheckResult) => { logger.warn('risk alert', { strategyId, allowed: check.allowed, reason: check.reason }); return true },
  }
}

const TEMPLATE_STRATEGIES: Record<string, new () => Strategy> = {
  'funding-arb': FundingArbStrategy,
  'lending-yield': LendingYieldStrategy,
  'market-maker': MarketMakerStrategy,
  'volume-farm': VolumeFarmStrategy,
}

const DEFAULT_CONFIGS: Record<string, StrategyConfig> = {
  'funding-arb': {
    entryThreshold: 0.01,
    exitThreshold: 0.002,
    positionSizeSats: 13_000,
    checkIntervalMs: 300_000,
    dedicatedAccountIndices: [],
    maxConsecutiveFailures: 3,
    minHoldUntilNextFundingMs: 600_000,
    maxHoldMs: 86_400_000,
    hyperliquidLeverage: 1,
    hyperliquidMarginBufferUsdc: 5,
  },
  'lending-yield': {
    minApyThreshold: 5,
    rebalanceThreshold: 2,
    checkIntervalMs: 300000,
  },
  'market-maker': {
    layers: 1,
    layerStepBps: 20,
    quoteSizeSats: 9_000,
    requoteIntervalMs: 600_000,
    requoteBps: 50,
    maxQuoteAgeMs: 1_800_000,
    leverage: 1,
    maxInventorySats: 27_000,
    walletFloorSats: 60_000,
    bypassCooldown: true,
    minNyks: 1000,
  },
  'volume-farm': {
    // Pilot config. With hedge='none' the per-round cost is ~$0.0003 (TW
    // fees + tiny slippage), so we can leave the daily cap generous.
    // Tiny per-round price variance (~$0.002 stdev for the ~10s TW open
    // window at $2.30 notional) is the trade we accept for ~95% lower
    // cost than the hedged path.
    positionSizeSats: 3_000,
    checkIntervalMs: 60_000,
    dedicatedAccountIndices: [],
    hedge: 'none',
    hyperliquidLeverage: 1,
    hyperliquidMarginBufferUsdc: 5,
    dailyVolumeCapSats: 3_000_000,
    maxConsecutiveFailures: 3,
    sideRotation: 'alternate',
  },
}

function tickIntervalForStrategy(id: string, cfg: StrategyConfig): number {
  if (id === 'market-maker') {
    return (cfg.requoteIntervalMs as number) ?? 60_000
  }
  return (cfg.checkIntervalMs as number) ?? 60_000
}

if (!process.env.VITEST) {
  startServer()
}

async function startServer() {
  const configPath = 'twilight-bots.config.json'
  let config: AppConfig
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    console.error(`Missing or invalid ${configPath} — run "npx twilight-bots setup" first.`)
    process.exit(1)
  }

  const db = createDatabase(process.env.DATABASE_PATH ?? 'twilight-bots.db')
  const log = createLogger('server')

  const twilight = new TwilightClientImpl(config.twilight)
  const binance = new BinanceClientImpl(config.binance)
  const hyperliquid = config.hyperliquid
    ? new HyperliquidClientImpl(config.hyperliquid)
    : undefined
  if (!hyperliquid) {
    log.warn('Hyperliquid config missing — funding-arb will be inert')
  }

  let alertClient: AlertClient
  if (config.discord?.webhookUrl) {
    try {
      alertClient = new DiscordAlertClient(config.discord.webhookUrl)
    } catch {
      log.warn('Invalid Discord webhook URL — falling back to console alerts')
      alertClient = buildConsoleAlertClient(log)
    }
  } else {
    alertClient = buildConsoleAlertClient(log)
  }

  const riskManager = new RiskManagerImpl(db, config.riskProfile, alertClient)
  const scheduler = new Scheduler(riskManager)

  // Agent + Journal initialization
  let agentEvaluator: AgentEvaluator | undefined
  let journal: Journal | undefined
  if (config.agent?.enabled) {
    const { JournalImpl } = await import('./agent/journal/index.js')
    const { AxAgentEvaluator } = await import('./agent/evaluator.js')
    journal = new JournalImpl(config.agent.journalPath)
    journal.reconstruct()
    agentEvaluator = new AxAgentEvaluator(config.agent, { twilight, binance }, db)
    log.info('Agent initialized', { provider: config.agent.provider, model: config.agent.model })
  }

  const ctx: Context = { twilight, binance, hyperliquid, risk: riskManager, log, db, alert: alertClient, agent: agentEvaluator, journal }
  const liveStrategies = new Map<string, Strategy>()

  async function loadStrategies(): Promise<void> {
    // Resolve configs first so we can prefund accounts before strategy init
    const resolvedConfigs: Record<string, StrategyConfig> = {}
    for (const id of config.strategies) {
      if (!TEMPLATE_STRATEGIES[id]) continue
      const record = db.getStrategy(id)
      if (record?.config) {
        try { resolvedConfigs[id] = JSON.parse(record.config) as StrategyConfig }
        catch { resolvedConfigs[id] = DEFAULT_CONFIGS[id] ?? {} }
      } else {
        resolvedConfigs[id] = DEFAULT_CONFIGS[id] ?? {}
      }
    }

    await ensureZkAccounts(ctx, config.strategies, resolvedConfigs)

    for (const id of config.strategies) {
      const StrategyClass = TEMPLATE_STRATEGIES[id]
      if (!StrategyClass) {
        log.warn('Unknown template strategy — skipping', { id })
        continue
      }

      const strategy = new StrategyClass()
      const strategyConfig = resolvedConfigs[id]
      const record = db.getStrategy(id)

      await strategy.init(strategyConfig, ctx)

      // Reclaim accounts left mid-lifecycle by a previous crash/restart
      // (orphaned open positions, settled-but-unrotated residue) before ticking.
      const reconcilable = strategy as unknown as { reconcileStuck?: (c: typeof ctx) => Promise<unknown> }
      if (typeof reconcilable.reconcileStuck === 'function') {
        try {
          await reconcilable.reconcileStuck(ctx)
        } catch (err) {
          log.warn('boot reconcile failed — continuing', { id, error: (err as Error).message })
        }
      }

      await scheduler.register(strategy, { interval: tickIntervalForStrategy(id, strategyConfig) }, ctx)
      liveStrategies.set(id, strategy)

      if (!record) {
        db.createStrategy({ name: strategy.name, type: 'template', status: 'active', config: JSON.stringify(strategyConfig) })
      }

      await scheduler.start(id)
      log.info('Strategy started', { id, name: strategy.name })
    }

    const loader = new StrategyLoader([resolve('src/strategies/custom')])
    const customStrategies = await loader.loadAll()
    for (const strategy of customStrategies) {
      await strategy.init({}, ctx)
      await scheduler.register(strategy, { interval: 60000 }, ctx)
      liveStrategies.set(strategy.id, strategy)
      await scheduler.start(strategy.id)
      log.info('Custom strategy started', { id: strategy.id, name: strategy.name })
    }

    log.info('Bootstrap complete', {
      templateStrategies: config.strategies.length,
      customStrategies: customStrategies.length,
    })
  }

  // Graceful shutdown
  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`Received ${signal}, shutting down...`)
    await scheduler.shutdown()
    await binance.close()
    log.info('Shutdown complete')
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  const app = createApp({
    bearerToken: config.server.bearerToken,
    scheduler,
    db,
    startTime: Date.now(),
    ctx,
    strategies: liveStrategies,
    risk: riskManager,
  })

  const port = config.server.port ?? 3000
  serve({ fetch: app.fetch, port }, () => {
    log.info(`twilight-bots server listening on http://localhost:${port}`)
    loadStrategies().catch((err: Error) => {
      log.error('Bootstrap failed', { error: err.message })
      process.exit(1)
    })
  })
}
