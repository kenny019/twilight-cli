// Stub — WS-3 will implement
import type { TwilightClient } from '../types/index.js'

export interface TwilightClientConfig {
  binaryPath: string
  walletId: string
  password: string
}

export class TwilightClientImpl implements TwilightClient {
  constructor(_config: TwilightClientConfig) {
    throw new Error('Not implemented — WS-3')
  }
  walletBalance(): Promise<{ nyks: number; sats: number }> { throw new Error('Not implemented') }
  walletAccounts(): Promise<any[]> { throw new Error('Not implemented') }
  fund(_amountSats: number): Promise<any> { throw new Error('Not implemented') }
  withdraw(_accountIndex: number): Promise<any> { throw new Error('Not implemented') }
  transfer(_fromAccountIndex: number): Promise<any> { throw new Error('Not implemented') }
  split(_fromAccountIndex: number, _balancesSats: number[]): Promise<any> { throw new Error('Not implemented') }
  openTrade(_accountIndex: number, _side: any, _entryPrice: number, _leverage: number, _orderType?: any): Promise<any> { throw new Error('Not implemented') }
  closeTrade(_accountIndex: number, _options?: any): Promise<any> { throw new Error('Not implemented') }
  cancelTrade(_accountIndex: number): Promise<any> { throw new Error('Not implemented') }
  queryTrade(_accountIndex: number): Promise<any> { throw new Error('Not implemented') }
  unlockTrade(_accountIndex: number): Promise<any> { throw new Error('Not implemented') }
  openLend(_accountIndex: number): Promise<any> { throw new Error('Not implemented') }
  closeLend(_accountIndex: number): Promise<any> { throw new Error('Not implemented') }
  queryLend(_accountIndex: number): Promise<any> { throw new Error('Not implemented') }
  marketPrice(): Promise<number> { throw new Error('Not implemented') }
  fundingRate(): Promise<number> { throw new Error('Not implemented') }
  feeRate(): Promise<any> { throw new Error('Not implemented') }
  marketStats(): Promise<any> { throw new Error('Not implemented') }
  lendPool(): Promise<any> { throw new Error('Not implemented') }
  lastDayApy(): Promise<number> { throw new Error('Not implemented') }
  orderbook(): Promise<any> { throw new Error('Not implemented') }
}
