/**
 * Validation contract for WS-1: Shared Types & Config
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect } from 'vitest'
import type {
  Strategy,
  Context,
  StrategyConfig,
  StrategyStatus,
  StrategyInfo,
  TwilightClient,
  BinanceClient,
  RiskManager,
  AlertClient,
  Logger,
  Database,
  AppConfig,
  RiskProfile,
  RiskProfileConfig,
  RiskCheckResult,
  AlertMessage,
  AlertType,
  OrderSide,
  OrderType,
  PositionStatus,
  AccountStatus,
  TradeType,
  StrategyType,
  TwilightMarketData,
  TwilightAccount,
  TwilightTradeResult,
  TwilightLendPool,
  BinancePosition,
  BinanceOrderResult,
  StrategyRecord,
  PositionRecord,
  TradeRecord,
  AccountRecord,
  AlertRecord,
} from '../index.js'
import { RISK_PROFILES, DAILY_LOSS_LIMIT_PCT } from '../index.js'

describe('WS-1: Shared Types & Config', () => {
  describe('Strategy interface', () => {
    it('matches PRD section 10.1 — has id, name, description, configSchema, init, tick, stop, status', () => {
      const mockStrategy: Strategy = {
        id: 'funding-arb',
        name: 'Funding Rate Arbitrage',
        description: 'Delta-neutral funding rate arbitrage between Twilight and Binance',
        configSchema: {
          type: 'object',
          properties: {
            entryThreshold: { type: 'number' },
            exitThreshold: { type: 'number' },
          },
        },
        init: async (_config: StrategyConfig, _ctx: Context) => {},
        tick: async () => {},
        stop: async () => {},
        status: () => ({
          id: 'funding-arb',
          status: 'active' as StrategyStatus,
          config: {},
          lastTick: null,
          tickCount: 0,
          errorCount: 0,
        }),
      }
      expect(mockStrategy.id).toBe('funding-arb')
      expect(mockStrategy.name).toBe('Funding Rate Arbitrage')
      expect(typeof mockStrategy.init).toBe('function')
      expect(typeof mockStrategy.tick).toBe('function')
      expect(typeof mockStrategy.stop).toBe('function')
      expect(typeof mockStrategy.status).toBe('function')
    })

    it('StrategyInfo contains runtime state', () => {
      const info: StrategyInfo = {
        id: 'test',
        status: 'active',
        config: { interval: 60 },
        lastTick: '2026-04-01T00:00:00Z',
        tickCount: 42,
        errorCount: 1,
      }
      expect(info.status).toBe('active')
      expect(info.tickCount).toBe(42)
      expect(info.lastTick).toBeTruthy()
    })
  })

  describe('Context interface', () => {
    it('contains all required clients', () => {
      // Type-level check: Context must have these fields
      const _typeCheck = (ctx: Context) => {
        const _t: TwilightClient = ctx.twilight
        const _b: BinanceClient = ctx.binance
        const _r: RiskManager = ctx.risk
        const _l: Logger = ctx.log
        const _d: Database = ctx.db
        const _a: AlertClient = ctx.alert
        return { _t, _b, _r, _l, _d, _a }
      }
      expect(typeof _typeCheck).toBe('function')
    })
  })

  describe('TwilightClient interface', () => {
    it('has all required methods', () => {
      const methods: (keyof TwilightClient)[] = [
        'walletBalance', 'walletAccounts',
        'fund', 'withdraw', 'transfer', 'split',
        'openTrade', 'closeTrade', 'cancelTrade', 'queryTrade', 'unlockTrade',
        'openLend', 'closeLend', 'queryLend',
        'marketPrice', 'fundingRate', 'feeRate', 'marketStats', 'lendPool', 'lastDayApy', 'orderbook',
      ]
      // This is a compile-time check; at runtime we just verify the list is complete
      expect(methods).toHaveLength(21)
    })
  })

  describe('BinanceClient interface', () => {
    it('has all required methods', () => {
      const methods: (keyof BinanceClient)[] = [
        'getPrice', 'getFundingRate', 'getOrderbook',
        'openPosition', 'closePosition', 'getPosition', 'getPositions',
        'getBalance', 'getMarginBalance',
        'watchPrice', 'watchFundingRate',
        'close',
      ]
      expect(methods).toHaveLength(12)
    })
  })

  describe('RiskManager interface', () => {
    it('has all required methods', () => {
      const methods: (keyof RiskManager)[] = [
        'checkPreTrade', 'checkDrawdown', 'checkDailyLoss', 'checkCooldown',
        'isKillSwitchActive', 'activateKillSwitch', 'deactivateKillSwitch',
        'recordTrade', 'checkConnectionHealth', 'reportConnectionStatus',
      ]
      expect(methods).toHaveLength(10)
    })
  })

  describe('Risk profiles', () => {
    it('defines conservative profile matching PRD section 11', () => {
      expect(RISK_PROFILES.conservative).toEqual({
        maxDrawdownPct: 10,
        positionSizeCapPct: 30,
        cooldownMinutes: 15,
      })
    })

    it('defines moderate profile matching PRD section 11', () => {
      expect(RISK_PROFILES.moderate).toEqual({
        maxDrawdownPct: 20,
        positionSizeCapPct: 50,
        cooldownMinutes: 5,
      })
    })

    it('defines aggressive profile matching PRD section 11', () => {
      expect(RISK_PROFILES.aggressive).toEqual({
        maxDrawdownPct: 30,
        positionSizeCapPct: 80,
        cooldownMinutes: 0,
      })
    })

    it('daily loss limit is 5%', () => {
      expect(DAILY_LOSS_LIMIT_PCT).toBe(5)
    })
  })

  describe('AppConfig', () => {
    it('covers all setup wizard outputs', () => {
      const config: AppConfig = {
        twilight: {
          walletId: 'my-wallet',
          password: 'test',
          binaryPath: './bin/relayer-cli',
        },
        binance: {
          apiKey: 'key',
          apiSecret: 'secret',
        },
        discord: {
          webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        },
        strategies: ['funding-arb', 'lending-yield'],
        riskProfile: 'moderate',
        server: {
          port: 3000,
          bearerToken: 'token',
        },
      }
      expect(config.twilight.walletId).toBe('my-wallet')
      expect(config.binance.apiKey).toBe('key')
      expect(config.discord.webhookUrl).toContain('discord.com')
      expect(config.strategies).toHaveLength(2)
      expect(config.riskProfile).toBe('moderate')
      expect(config.server.port).toBe(3000)
    })
  })

  describe('Type enums', () => {
    it('StrategyStatus has correct values', () => {
      const statuses: StrategyStatus[] = ['active', 'stopped', 'error']
      expect(statuses).toHaveLength(3)
    })

    it('OrderSide has correct values', () => {
      const sides: OrderSide[] = ['LONG', 'SHORT']
      expect(sides).toHaveLength(2)
    })

    it('RiskProfile has correct values', () => {
      const profiles: RiskProfile[] = ['conservative', 'moderate', 'aggressive']
      expect(profiles).toHaveLength(3)
    })

    it('AlertType has correct values', () => {
      const types: AlertType[] = ['trade', 'pnl', 'error', 'risk', 'info']
      expect(types).toHaveLength(5)
    })
  })

  describe('Database interface', () => {
    it('has CRUD methods for all 5 tables plus KV store', () => {
      const methods: (keyof Database)[] = [
        'createStrategy', 'getStrategy', 'updateStrategy', 'listStrategies',
        'createPosition', 'getPosition', 'updatePosition', 'listPositions',
        'createTrade', 'listTrades',
        'createAccount', 'getAccount', 'updateAccount', 'listAccounts',
        'createAlert', 'listAlerts',
        'getKV', 'setKV',
      ]
      expect(methods).toHaveLength(18)
    })
  })

  describe('Record types match PRD section 9.5 schema', () => {
    it('StrategyRecord has all columns', () => {
      const record: StrategyRecord = {
        id: '1',
        name: 'Funding Arb',
        type: 'template',
        status: 'active',
        config: '{"threshold": 0.01}',
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }
      expect(record.type).toBe('template')
      expect(JSON.parse(record.config)).toHaveProperty('threshold')
    })

    it('PositionRecord has all columns', () => {
      const record: PositionRecord = {
        id: '1',
        strategyId: 's1',
        exchange: 'twilight',
        side: 'LONG',
        entryPrice: 65000,
        size: 10000,
        leverage: 5,
        status: 'open',
        openedAt: '2026-04-01T00:00:00Z',
        closedAt: null,
      }
      expect(record.exchange).toBe('twilight')
      expect(record.closedAt).toBeNull()
    })

    it('TradeRecord has all columns', () => {
      const record: TradeRecord = {
        id: '1',
        positionId: 'p1',
        type: 'open',
        price: 65000,
        size: 10000,
        fee: 400,
        pnl: 0,
        executedAt: '2026-04-01T00:00:00Z',
      }
      expect(record.type).toBe('open')
      expect(record.fee).toBe(400)
    })

    it('AccountRecord has all columns', () => {
      const record: AccountRecord = {
        id: '1',
        exchange: 'twilight',
        accountIndex: 0,
        status: 'idle',
        balance: 50000,
      }
      expect(record.status).toBe('idle')
    })

    it('AlertRecord has all columns', () => {
      const record: AlertRecord = {
        id: '1',
        strategyId: 's1',
        type: 'trade',
        message: 'Opened LONG position',
        sentAt: '2026-04-01T00:00:00Z',
      }
      expect(record.type).toBe('trade')
    })
  })
})
