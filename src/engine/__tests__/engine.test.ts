/**
 * Validation contract for WS-7: Strategy Engine
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { Scheduler } from '../scheduler.js'
import { StrategyLoader } from '../loader.js'
import type { Strategy, StrategyConfig, StrategyInfo, Context, RiskManager } from '../../types/index.js'

// Helper: create a mock strategy
function createMockStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: 'mock-strategy',
    name: 'Mock Strategy',
    description: 'A mock strategy for testing',
    configSchema: {},
    init: vi.fn().mockResolvedValue(undefined),
    tick: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockReturnValue({
      id: 'mock-strategy',
      status: 'active',
      config: {},
      lastTick: null,
      tickCount: 0,
      errorCount: 0,
    } as StrategyInfo),
    ...overrides,
  }
}

// Mock risk manager
function createMockRiskManager(overrides: Partial<RiskManager> = {}): RiskManager {
  return {
    checkPreTrade: vi.fn().mockResolvedValue({ allowed: true }),
    checkDrawdown: vi.fn().mockResolvedValue({ allowed: true }),
    checkDailyLoss: vi.fn().mockResolvedValue({ allowed: true }),
    checkCooldown: vi.fn().mockResolvedValue({ allowed: true }),
    isKillSwitchActive: vi.fn().mockResolvedValue(false),
    activateKillSwitch: vi.fn().mockResolvedValue(undefined),
    deactivateKillSwitch: vi.fn().mockResolvedValue(undefined),
    recordTrade: vi.fn().mockResolvedValue(undefined),
    checkConnectionHealth: vi.fn().mockResolvedValue({ allowed: true }),
    reportConnectionStatus: vi.fn(),
    ...overrides,
  }
}

describe('WS-7: Strategy Engine', () => {
  describe('Scheduler', () => {
    let scheduler: Scheduler
    let mockRisk: RiskManager

    beforeEach(() => {
      vi.useFakeTimers()
      mockRisk = createMockRiskManager()
      scheduler = new Scheduler(mockRisk)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('registers and starts a strategy on its configured interval', async () => {
      const strategy = createMockStrategy()
      await scheduler.register(strategy, { interval: 1000 })
      await scheduler.start(strategy.id)

      // Advance time by one interval
      await vi.advanceTimersByTimeAsync(1000)

      expect(strategy.tick).toHaveBeenCalledTimes(1)
    })

    it('ticks at the configured interval repeatedly', async () => {
      const strategy = createMockStrategy()
      await scheduler.register(strategy, { interval: 500 })
      await scheduler.start(strategy.id)

      await vi.advanceTimersByTimeAsync(2500)

      // Should have ticked ~5 times (2500/500)
      expect((strategy.tick as any).mock.calls.length).toBeGreaterThanOrEqual(4)
    })

    it('strategy isolation: one failing does not affect others', async () => {
      const good = createMockStrategy({ id: 'good' })
      const bad = createMockStrategy({
        id: 'bad',
        tick: vi.fn().mockRejectedValue(new Error('boom')),
      })

      await scheduler.register(good, { interval: 1000 })
      await scheduler.register(bad, { interval: 1000 })
      await scheduler.start('good')
      await scheduler.start('bad')

      await vi.advanceTimersByTimeAsync(3000)

      // Good strategy should keep ticking despite bad one failing
      expect((good.tick as any).mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('catches errors per-tick without crashing', async () => {
      const strategy = createMockStrategy({
        tick: vi.fn()
          .mockRejectedValueOnce(new Error('transient error'))
          .mockResolvedValue(undefined),
      })

      await scheduler.register(strategy, { interval: 1000 })
      await scheduler.start(strategy.id)

      await vi.advanceTimersByTimeAsync(3000)

      // Should have attempted multiple ticks despite first failure
      expect((strategy.tick as any).mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('stops a strategy gracefully', async () => {
      const strategy = createMockStrategy()
      await scheduler.register(strategy, { interval: 1000 })
      await scheduler.start(strategy.id)

      await vi.advanceTimersByTimeAsync(1000)
      expect(strategy.tick).toHaveBeenCalled()

      await scheduler.stop(strategy.id)

      const tickCountAfterStop = (strategy.tick as any).mock.calls.length
      await vi.advanceTimersByTimeAsync(3000)

      // No more ticks after stop
      expect((strategy.tick as any).mock.calls.length).toBe(tickCountAfterStop)
      expect(strategy.stop).toHaveBeenCalled()
    })

    it('respects kill switch — skips ticks when active', async () => {
      const strategy = createMockStrategy()
      ;(mockRisk.isKillSwitchActive as any).mockResolvedValue(true)

      await scheduler.register(strategy, { interval: 1000 })
      await scheduler.start(strategy.id)

      await vi.advanceTimersByTimeAsync(3000)

      // Tick should NOT have been called because kill switch is active
      expect(strategy.tick).not.toHaveBeenCalled()
    })

    it('graceful shutdown stops all strategies', async () => {
      const s1 = createMockStrategy({ id: 's1' })
      const s2 = createMockStrategy({ id: 's2' })

      await scheduler.register(s1, { interval: 1000 })
      await scheduler.register(s2, { interval: 1000 })
      await scheduler.start('s1')
      await scheduler.start('s2')

      await scheduler.shutdown()

      expect(s1.stop).toHaveBeenCalled()
      expect(s2.stop).toHaveBeenCalled()
    })

    it('reports strategy status', async () => {
      const strategy = createMockStrategy()
      await scheduler.register(strategy, { interval: 1000 })
      await scheduler.start(strategy.id)

      const statuses = scheduler.getStatuses()
      expect(statuses).toHaveLength(1)
      expect(statuses[0].id).toBe('mock-strategy')
    })
  })

  describe('StrategyLoader', () => {
    it('can be instantiated with strategy directories', () => {
      const loader = new StrategyLoader(['strategies/templates', 'strategies/custom'])
      expect(loader).toBeDefined()
    })

    it('returns an empty list when directories do not exist', async () => {
      const loader = new StrategyLoader(['/nonexistent/path'])
      const strategies = await loader.loadAll()
      expect(strategies).toEqual([])
    })
  })
})
