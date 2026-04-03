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
import { DiscordAlertClient } from './alerts/discord.js'
import { FundingArbStrategy } from './strategies/templates/funding-arb.js'
import { LendingYieldStrategy } from './strategies/templates/lending-yield.js'
import { createLogger } from './utils/logger.js'
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
}

const DEFAULT_CONFIGS: Record<string, StrategyConfig> = {
  'funding-arb': {
    entryThreshold: 0.001,
    exitThreshold: 0.0003,
    positionSizeSats: 100000,
    checkIntervalMs: 60000,
  },
  'lending-yield': {
    minApyThreshold: 5,
    rebalanceThreshold: 2,
    checkIntervalMs: 300000,
  },
}

if (!process.env.VITEST) {
  startServer()
}

function startServer() {
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

  const ctx: Context = { twilight, binance, risk: riskManager, log, db, alert: alertClient }

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
      await scheduler.register(strategy, { interval: (strategyConfig.checkIntervalMs as number) ?? 60000 })

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
      await scheduler.register(strategy, { interval: 60000 })
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
