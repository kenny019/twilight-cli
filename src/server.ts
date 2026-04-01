import { Hono } from 'hono'
import type { Database, StrategyRecord } from './types/index.js'

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
