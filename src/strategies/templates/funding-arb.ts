// Stub — WS-9 will implement
import type { Strategy, StrategyConfig, StrategyInfo, Context } from '../../types/index.js'

export class FundingArbStrategy implements Strategy {
  id = 'funding-arb'
  name = 'Funding Rate Arbitrage'
  description = 'Delta-neutral funding rate arbitrage between Twilight and Binance'
  configSchema = { type: 'object', properties: {} }

  async init(_config: StrategyConfig, _ctx: Context): Promise<void> { throw new Error('Not implemented — WS-9') }
  async tick(): Promise<void> { throw new Error('Not implemented') }
  async stop(): Promise<void> { throw new Error('Not implemented') }
  status(): StrategyInfo { throw new Error('Not implemented') }
}
