/**
 * Validation contract for WS-8: REST API
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp } from '../../server.js'

describe('WS-8: REST API', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    app = createApp({
      bearerToken: 'test-token',
      scheduler: {
        getStatuses: vi.fn().mockReturnValue([
          { id: 'funding-arb', status: 'active', config: {}, lastTick: '2026-04-01T00:00:00Z', tickCount: 42, errorCount: 1 },
        ]),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      } as any,
      db: {
        listPositions: vi.fn().mockReturnValue([
          { id: 'p1', strategyId: 's1', exchange: 'twilight', side: 'LONG', entryPrice: 65000, size: 10000, leverage: 5, status: 'open', openedAt: '2026-04-01T00:00:00Z', closedAt: null },
        ]),
        listTrades: vi.fn().mockReturnValue([
          { id: 't1', positionId: 'p1', type: 'open', price: 65000, size: 10000, fee: 400, pnl: 0, executedAt: '2026-04-01T00:00:00Z' },
        ]),
        listStrategies: vi.fn().mockReturnValue([]),
        getStrategy: vi.fn().mockReturnValue({ id: 'funding-arb', name: 'Funding Arb', type: 'template', status: 'active', config: '{}', createdAt: '', updatedAt: '' }),
        updateStrategy: vi.fn().mockReturnValue({ id: 'funding-arb', name: 'Funding Arb', type: 'template', status: 'active', config: '{"threshold":0.02}', createdAt: '', updatedAt: '' }),
        listAlerts: vi.fn().mockReturnValue([]),
      } as any,
      startTime: Date.now(),
    })
  })

  function request(path: string, options?: RequestInit) {
    return app.request(path, {
      ...options,
      headers: {
        Authorization: 'Bearer test-token',
        ...options?.headers,
      },
    })
  }

  describe('GET /health (no auth required)', () => {
    it('returns 200 with uptime and strategy count', async () => {
      const res = await app.request('/health')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('uptime')
      expect(body).toHaveProperty('strategies')
    })
  })

  describe('Authentication', () => {
    it('rejects requests without bearer token', async () => {
      const res = await app.request('/status')
      expect(res.status).toBe(401)
    })

    it('rejects requests with wrong bearer token', async () => {
      const res = await app.request('/status', {
        headers: { Authorization: 'Bearer wrong-token' },
      })
      expect(res.status).toBe(401)
    })

    it('accepts requests with correct bearer token', async () => {
      const res = await request('/status')
      expect(res.status).toBe(200)
    })
  })

  describe('GET /status', () => {
    it('returns all running strategies and state', async () => {
      const res = await request('/status')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('strategies')
      expect(body.strategies).toHaveLength(1)
      expect(body.strategies[0].id).toBe('funding-arb')
    })
  })

  describe('GET /positions', () => {
    it('returns open positions', async () => {
      const res = await request('/positions')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toBeInstanceOf(Array)
      expect(body[0]).toHaveProperty('exchange')
      expect(body[0]).toHaveProperty('side')
    })
  })

  describe('GET /pnl', () => {
    it('returns PnL summary per-strategy and total', async () => {
      const res = await request('/pnl')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('total')
      expect(body).toHaveProperty('strategies')
    })
  })

  describe('GET /history', () => {
    it('returns trade history', async () => {
      const res = await request('/history')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toBeInstanceOf(Array)
    })

    it('supports query filters', async () => {
      const res = await request('/history?strategyId=s1&limit=10')
      expect(res.status).toBe(200)
    })
  })

  describe('POST /strategies/:id/start', () => {
    it('starts a strategy', async () => {
      const res = await request('/strategies/funding-arb/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { threshold: 0.01 } }),
      })
      expect(res.status).toBe(200)
    })

    it('returns 404 for non-existent strategy', async () => {
      const db = app as any
      // Override getStrategy to return undefined
      const appWithMissing = createApp({
        bearerToken: 'test-token',
        scheduler: { getStatuses: vi.fn().mockReturnValue([]), start: vi.fn(), stop: vi.fn() } as any,
        db: { ...db.db, getStrategy: vi.fn().mockReturnValue(undefined), listPositions: vi.fn().mockReturnValue([]), listTrades: vi.fn().mockReturnValue([]), listStrategies: vi.fn().mockReturnValue([]), listAlerts: vi.fn().mockReturnValue([]), updateStrategy: vi.fn() } as any,
        startTime: Date.now(),
      })
      const res = await appWithMissing.request('/strategies/nonexistent/start', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /strategies/:id/stop', () => {
    it('stops a running strategy', async () => {
      const res = await request('/strategies/funding-arb/stop', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
    })
  })

  describe('PUT /strategies/:id/config', () => {
    it('updates strategy configuration', async () => {
      const res = await request('/strategies/funding-arb/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: 0.02 }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('config')
    })
  })

  describe('GET /strategies/:id/logs', () => {
    it('returns recent log entries', async () => {
      const res = await request('/strategies/funding-arb/logs')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toBeInstanceOf(Array)
    })
  })
})
