/**
 * Validation contract for WS-6: Risk Management
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RiskManagerImpl } from '../risk.js'
import { createDatabase } from '../../db/index.js'
import type { RiskManager, Database } from '../../types/index.js'

const TEST_DB_DIR = join(tmpdir(), 'twilight-bots-risk-test-' + process.pid)
const TEST_DB_PATH = join(TEST_DB_DIR, 'risk-test.db')

describe('WS-6: Risk Management', () => {
  let risk: RiskManager
  let db: Database

  beforeEach(() => {
    mkdirSync(TEST_DB_DIR, { recursive: true })
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH)
    db = createDatabase(TEST_DB_PATH)
    risk = new RiskManagerImpl(db, 'conservative')
  })

  afterEach(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH)
  })

  describe('Max drawdown', () => {
    it('allows trade when drawdown is below limit (conservative=10%)', async () => {
      const result = await risk.checkDrawdown('strategy-1')
      expect(result.allowed).toBe(true)
    })

    it('rejects trade when cumulative loss exceeds 10% (conservative)', async () => {
      // Record losses that exceed 10% of a 100,000 sat balance
      const strategy = db.createStrategy({ name: 'Test', type: 'template', status: 'active', config: JSON.stringify({ initialBalance: 100000 }) })
      await risk.recordTrade(strategy.id, -5000) // -5%
      await risk.recordTrade(strategy.id, -6000) // -11% cumulative

      const result = await risk.checkDrawdown(strategy.id)
      expect(result.allowed).toBe(false)
      expect(result.control).toBe('maxDrawdown')
    })
  })

  describe('Position size cap', () => {
    it('allows position within cap (conservative=30%)', async () => {
      const result = await risk.checkPreTrade('strategy-1', 25000, 100000)
      expect(result.allowed).toBe(true)
    })

    it('rejects position exceeding 30% of balance (conservative)', async () => {
      const result = await risk.checkPreTrade('strategy-1', 35000, 100000)
      expect(result.allowed).toBe(false)
      expect(result.control).toBe('positionSizeCap')
    })
  })

  describe('Daily loss limit', () => {
    it('allows trading when daily loss is below 5%', async () => {
      const result = await risk.checkDailyLoss()
      expect(result.allowed).toBe(true)
    })

    it('rejects trading when daily loss exceeds 5% of balance', async () => {
      // Record enough losses today to exceed 5%
      const strategy = db.createStrategy({ name: 'T', type: 'template', status: 'active', config: JSON.stringify({ initialBalance: 100000 }) })
      await risk.recordTrade(strategy.id, -3000)
      await risk.recordTrade(strategy.id, -3000) // -6% total today

      const result = await risk.checkDailyLoss()
      expect(result.allowed).toBe(false)
      expect(result.control).toBe('dailyLossLimit')
    })
  })

  describe('Cooldown period', () => {
    it('allows trade when no recent losing trade (conservative=15min)', async () => {
      const result = await risk.checkCooldown('strategy-1')
      expect(result.allowed).toBe(true)
    })

    it('rejects trade within cooldown after losing trade', async () => {
      const strategy = db.createStrategy({ name: 'T', type: 'template', status: 'active', config: '{}' })
      await risk.recordTrade(strategy.id, -1000) // losing trade

      const result = await risk.checkCooldown(strategy.id)
      expect(result.allowed).toBe(false)
      expect(result.control).toBe('cooldown')
    })
  })

  describe('Connection watchdog', () => {
    it('allows when exchange is connected', async () => {
      risk.reportConnectionStatus('twilight', true)
      const result = await risk.checkConnectionHealth('twilight')
      expect(result.allowed).toBe(true)
    })

    it('rejects when exchange disconnected for >60s', async () => {
      risk.reportConnectionStatus('twilight', false)
      // Simulate 61 seconds passing
      // The implementation should track disconnect timestamps
      const result = await risk.checkConnectionHealth('twilight')
      expect(result.allowed).toBe(false)
      expect(result.control).toBe('connectionWatchdog')
    })
  })

  describe('Kill switch', () => {
    it('is inactive by default', async () => {
      expect(await risk.isKillSwitchActive()).toBe(false)
    })

    it('can be activated', async () => {
      await risk.activateKillSwitch()
      expect(await risk.isKillSwitchActive()).toBe(true)
    })

    it('can be deactivated', async () => {
      await risk.activateKillSwitch()
      await risk.deactivateKillSwitch()
      expect(await risk.isKillSwitchActive()).toBe(false)
    })

    it('persists across instances (stored in DB)', async () => {
      await risk.activateKillSwitch()

      // Create a new instance with the same DB
      const risk2 = new RiskManagerImpl(db, 'conservative')
      expect(await risk2.isKillSwitchActive()).toBe(true)
    })

    it('kill switch blocks pre-trade check', async () => {
      await risk.activateKillSwitch()
      const result = await risk.checkPreTrade('strategy-1', 10000, 100000)
      expect(result.allowed).toBe(false)
      expect(result.control).toBe('killSwitch')
    })
  })

  describe('Risk profiles', () => {
    it('moderate profile allows larger positions (50%)', async () => {
      const moderateRisk = new RiskManagerImpl(db, 'moderate')
      const result = await moderateRisk.checkPreTrade('s1', 45000, 100000)
      expect(result.allowed).toBe(true)
    })

    it('aggressive profile allows largest positions (80%)', async () => {
      const aggressiveRisk = new RiskManagerImpl(db, 'aggressive')
      const result = await aggressiveRisk.checkPreTrade('s1', 75000, 100000)
      expect(result.allowed).toBe(true)
    })

    it('aggressive profile has no cooldown', async () => {
      const aggressiveRisk = new RiskManagerImpl(db, 'aggressive')
      const strategy = db.createStrategy({ name: 'T', type: 'template', status: 'active', config: '{}' })
      await aggressiveRisk.recordTrade(strategy.id, -1000)

      const result = await aggressiveRisk.checkCooldown(strategy.id)
      expect(result.allowed).toBe(true)
    })
  })

  describe('Pre-trade check (composite)', () => {
    it('checks all conditions: kill switch, position cap, drawdown, daily loss, cooldown', async () => {
      const result = await risk.checkPreTrade('strategy-1', 10000, 100000)
      expect(result.allowed).toBe(true)
    })

    it('rejects when any single condition fails', async () => {
      await risk.activateKillSwitch()
      const result = await risk.checkPreTrade('strategy-1', 10000, 100000)
      expect(result.allowed).toBe(false)
    })
  })
})
