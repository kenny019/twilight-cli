export type {
  TradeProposal,
  MarketSnapshot,
  AgentVerdict,
  AgentEvaluation,
  MarketRegime,
  AgentEvaluator,
  AgentStatus,
  Journal,
  JournalEntry,
  EvaluationEntry,
  OutcomeEntry,
  AdjustmentEntry,
  ProposableStrategy,
  AgentConfig,
  MarketDataPoint,
  SandboxConfig,
  SandboxReport,
  TwilightHistoricalFundingRate,
} from './agent.js'

export { DEFAULT_EVALUATION, isProposable, applyAdjustedParams } from './agent.js'

// ─── Strategy Types ──────────────────────────────────────────────

export type StrategyType = 'template' | 'custom'
export type StrategyStatus = 'active' | 'stopped' | 'error'
export type OrderSide = 'LONG' | 'SHORT'
export type OrderType = 'MARKET' | 'LIMIT'
export type PositionStatus = 'open' | 'closed' | 'liquidated'
export type AccountStatus = 'idle' | 'active' | 'locked'
export type TradeType = 'open' | 'close'
export type AlertType = 'trade' | 'pnl' | 'error' | 'risk' | 'info'
export type RiskProfile = 'conservative' | 'moderate' | 'aggressive'

export interface RiskProfileConfig {
  maxDrawdownPct: number
  positionSizeCapPct: number
  cooldownMinutes: number
}

export const RISK_PROFILES: Record<RiskProfile, RiskProfileConfig> = {
  conservative: { maxDrawdownPct: 10, positionSizeCapPct: 30, cooldownMinutes: 15 },
  moderate: { maxDrawdownPct: 20, positionSizeCapPct: 50, cooldownMinutes: 5 },
  aggressive: { maxDrawdownPct: 30, positionSizeCapPct: 80, cooldownMinutes: 0 },
}

export const DAILY_LOSS_LIMIT_PCT = 5

// ─── Config ──────────────────────────────────────────────────────

export interface AppConfig {
  twilight: {
    walletId: string
    password: string
    binaryPath: string
  }
  binance: {
    apiKey: string
    apiSecret: string
  }
  hyperliquid?: {
    privateKey: string
    accountAddress: string
    testnet?: boolean
  }
  discord: {
    webhookUrl: string
  }
  strategies: string[]
  riskProfile: RiskProfile
  server: {
    port: number
    bearerToken: string
  }
  agent?: import('./agent.js').AgentConfig
}

// ─── Exchange Client Interfaces ──────────────────────────────────

export interface TwilightMarketData {
  price: number
  fundingRate: number
  feeRate: { marketFill: number; limitFill: number; marketSettle: number; limitSettle: number }
  timestamp: number
}

export interface TwilightAccount {
  index: number
  balance: number
  onChain: boolean
  ioType: string
}

export interface TwilightTradeResult {
  requestId: string
  accountIndex: number
  status: string
}

export type TwilightOrderStatus = 'PENDING' | 'FILLED' | 'SETTLED' | 'CANCELLED' | 'LIQUIDATED' | 'UNKNOWN'

export interface TwilightTradeQuery {
  orderStatus: TwilightOrderStatus
  raw: Record<string, unknown>
}

export interface TwilightLendPool {
  totalDeposits: number
  shareValue: number
  apy: number
}

export interface TwilightClient {
  // Wallet
  walletBalance(): Promise<{ nyks: number; sats: number }>
  walletAccounts(): Promise<TwilightAccount[]>
  // ZkAccount
  fund(amountSats: number): Promise<TwilightTradeResult>
  withdraw(accountIndex: number): Promise<TwilightTradeResult>
  transfer(fromAccountIndex: number): Promise<TwilightTradeResult>
  split(fromAccountIndex: number, balancesSats: number[]): Promise<TwilightTradeResult>
  // Orders
  openTrade(accountIndex: number, side: OrderSide, entryPrice: number, leverage: number, orderType?: OrderType): Promise<TwilightTradeResult>
  closeTrade(accountIndex: number, options?: { stopLoss?: number; takeProfit?: number }): Promise<TwilightTradeResult>
  cancelTrade(accountIndex: number): Promise<TwilightTradeResult>
  queryTrade(accountIndex: number): Promise<TwilightTradeQuery>
  unlockTrade(accountIndex: number): Promise<TwilightTradeResult>
  // Lending
  openLend(accountIndex: number): Promise<TwilightTradeResult>
  closeLend(accountIndex: number): Promise<TwilightTradeResult>
  queryLend(accountIndex: number): Promise<Record<string, unknown>>
  // Market data
  marketPrice(): Promise<number>
  fundingRate(): Promise<number>
  feeRate(): Promise<TwilightMarketData['feeRate']>
  marketStats(): Promise<Record<string, unknown>>
  lendPool(): Promise<TwilightLendPool>
  lastDayApy(): Promise<number>
  orderbook(): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }>
}

export interface BinancePosition {
  symbol: string
  side: OrderSide
  entryPrice: number
  size: number
  leverage: number
  unrealizedPnl: number
  liquidationPrice: number
}

export interface BinanceOrderResult {
  orderId: string
  status: string
  price: number
  size: number
  fee: number
}

export interface BinanceClient {
  // Market data
  getPrice(symbol?: string): Promise<number>
  getFundingRate(symbol?: string): Promise<number>
  getOrderbook(symbol?: string): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }>
  // Trading
  openPosition(side: OrderSide, size: number, leverage: number, orderType?: OrderType): Promise<BinanceOrderResult>
  closePosition(side: OrderSide, size: number): Promise<BinanceOrderResult>
  getPosition(symbol?: string): Promise<BinancePosition | null>
  getPositions(): Promise<BinancePosition[]>
  // Account
  getBalance(): Promise<number>
  getMarginBalance(): Promise<number>
  // WebSocket (returns cleanup function)
  watchPrice(callback: (price: number) => void): Promise<() => void>
  watchFundingRate(callback: (rate: number) => void): Promise<() => void>
  // Lifecycle
  close(): Promise<void>
}

export interface HyperliquidPosition {
  coin: string
  side: OrderSide
  entryPrice: number
  size: number       // base currency (BTC)
  leverage: number
  unrealizedPnl: number
  liquidationPrice: number | null
}

export interface HyperliquidOrderResult {
  orderId: number | null
  status: 'filled' | 'resting' | 'error'
  fillPrice: number  // averaged for the round
  size: number       // base currency (BTC)
  fee: number        // USDC
  raw: Record<string, unknown>
}

export interface HyperliquidFundingEntry {
  time: number
  coin: string
  usdc: number      // signed
  szi: number       // signed position size at funding time
  fundingRate: number
}

export interface HyperliquidClient {
  // Market data
  getMarkPrice(coin?: string): Promise<number>
  getFundingRate(coin?: string): Promise<number>
  // Trading (size in BTC; quantized to step internally — caller may pre-quantize)
  openPosition(side: OrderSide, sizeBtc: number, leverage: number): Promise<HyperliquidOrderResult>
  closePosition(side: OrderSide, sizeBtc: number): Promise<HyperliquidOrderResult>
  getPosition(coin?: string): Promise<HyperliquidPosition | null>
  // Account
  getBalance(): Promise<number>  // USDC
  // Funding history
  getRealizedFunding(sinceMs: number, coin?: string): Promise<HyperliquidFundingEntry[]>
  // Helpers
  quantizeBtcSize(sats: number, markPrice: number): number
}

// ─── Risk Manager ────────────────────────────────────────────────

export interface RiskCheckResult {
  allowed: boolean
  reason?: string
  control?: string
}

export interface RiskManager {
  checkPreTrade(strategyId: string, positionSizeSats: number, totalBalanceSats: number): Promise<RiskCheckResult>
  checkDrawdown(strategyId: string): Promise<RiskCheckResult>
  checkDailyLoss(): Promise<RiskCheckResult>
  checkCooldown(strategyId: string): Promise<RiskCheckResult>
  isKillSwitchActive(): Promise<boolean>
  activateKillSwitch(): Promise<void>
  deactivateKillSwitch(): Promise<void>
  recordTrade(strategyId: string, pnl: number): Promise<void>
  checkConnectionHealth(exchange: string): Promise<RiskCheckResult>
  reportConnectionStatus(exchange: string, connected: boolean): void
}

// ─── Alert Client ────────────────────────────────────────────────

export interface AlertMessage {
  type: AlertType
  title: string
  description: string
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  color?: number
}

export interface AlertClient {
  send(message: AlertMessage): Promise<boolean>
  sendTradeAlert(strategyId: string, action: string, details: Record<string, unknown>): Promise<boolean>
  sendErrorAlert(strategyId: string, error: Error): Promise<boolean>
  sendRiskAlert(strategyId: string, check: RiskCheckResult): Promise<boolean>
}

// ─── Logger ──────────────────────────────────────────────────────

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
}

// ─── Database Interface ──────────────────────────────────────────

export interface StrategyRecord {
  id: string
  name: string
  type: StrategyType
  status: StrategyStatus
  config: string // JSON text
  createdAt: string
  updatedAt: string
}

export interface PositionRecord {
  id: string
  strategyId: string
  exchange: string
  side: OrderSide
  entryPrice: number
  size: number
  leverage: number
  status: PositionStatus
  openedAt: string
  closedAt: string | null
}

export interface TradeRecord {
  id: string
  positionId: string
  type: TradeType
  price: number
  size: number
  fee: number
  pnl: number
  executedAt: string
}

export interface AccountRecord {
  id: string
  exchange: string
  accountIndex: number
  status: AccountStatus
  balance: number
}

export interface AlertRecord {
  id: string
  strategyId: string | null
  type: AlertType
  message: string
  sentAt: string
}

export interface Database {
  // Strategies
  createStrategy(data: Omit<StrategyRecord, 'id' | 'createdAt' | 'updatedAt'>): StrategyRecord
  getStrategy(id: string): StrategyRecord | undefined
  updateStrategy(id: string, data: Partial<Pick<StrategyRecord, 'status' | 'config' | 'name'>>): StrategyRecord | undefined
  listStrategies(filter?: { status?: StrategyStatus; type?: StrategyType }): StrategyRecord[]
  // Positions
  createPosition(data: Omit<PositionRecord, 'id' | 'openedAt' | 'closedAt'>): PositionRecord
  getPosition(id: string): PositionRecord | undefined
  updatePosition(id: string, data: Partial<Pick<PositionRecord, 'status' | 'closedAt'>>): PositionRecord | undefined
  listPositions(filter?: { strategyId?: string; status?: PositionStatus; exchange?: string }): PositionRecord[]
  // Trades
  createTrade(data: Omit<TradeRecord, 'id' | 'executedAt'>): TradeRecord
  listTrades(filter?: { positionId?: string; strategyId?: string }): TradeRecord[]
  // Accounts
  createAccount(data: Omit<AccountRecord, 'id'>): AccountRecord
  getAccount(exchange: string, accountIndex: number): AccountRecord | undefined
  updateAccount(id: string, data: Partial<Pick<AccountRecord, 'status' | 'balance'>>): AccountRecord | undefined
  listAccounts(filter?: { exchange?: string; status?: AccountStatus }): AccountRecord[]
  // Alerts
  createAlert(data: Omit<AlertRecord, 'id' | 'sentAt'>): AlertRecord
  listAlerts(filter?: { strategyId?: string; type?: AlertType; limit?: number }): AlertRecord[]
  // Key-value store (for kill switch, etc.)
  getKV(key: string): string | undefined
  setKV(key: string, value: string): void
}

// ─── Strategy Interface ──────────────────────────────────────────

export interface StrategyConfig {
  [key: string]: unknown
}

export interface StrategyInfo {
  id: string
  status: StrategyStatus
  config: StrategyConfig
  lastTick: string | null
  tickCount: number
  errorCount: number
}

export interface Context {
  twilight: TwilightClient
  binance: BinanceClient
  hyperliquid?: HyperliquidClient
  risk: RiskManager
  log: Logger
  db: Database
  alert: AlertClient
  agent?: import('./agent.js').AgentEvaluator
  journal?: import('./agent.js').Journal
}

export interface Strategy {
  id: string
  name: string
  description: string
  configSchema: Record<string, unknown> // JSON Schema

  init(config: StrategyConfig, ctx: Context): Promise<void>
  tick(): Promise<void>
  stop(): Promise<void>
  status(): StrategyInfo
}
