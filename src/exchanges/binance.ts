// Stub — WS-4 will implement
import type { BinanceClient } from '../types/index.js'

export interface BinanceClientConfig {
  apiKey: string
  apiSecret: string
  symbol?: string
  testnet?: boolean
}

export class BinanceClientImpl implements BinanceClient {
  constructor(_config: BinanceClientConfig) {
    throw new Error('Not implemented — WS-4')
  }
  getPrice(_symbol?: string): Promise<number> { throw new Error('Not implemented') }
  getFundingRate(_symbol?: string): Promise<number> { throw new Error('Not implemented') }
  getOrderbook(_symbol?: string): Promise<any> { throw new Error('Not implemented') }
  openPosition(_side: any, _size: number, _leverage: number, _orderType?: any): Promise<any> { throw new Error('Not implemented') }
  closePosition(_side: any, _size: number): Promise<any> { throw new Error('Not implemented') }
  getPosition(_symbol?: string): Promise<any> { throw new Error('Not implemented') }
  getPositions(): Promise<any[]> { throw new Error('Not implemented') }
  getBalance(): Promise<number> { throw new Error('Not implemented') }
  getMarginBalance(): Promise<number> { throw new Error('Not implemented') }
  watchPrice(_callback: (price: number) => void): Promise<() => void> { throw new Error('Not implemented') }
  watchFundingRate(_callback: (rate: number) => void): Promise<() => void> { throw new Error('Not implemented') }
  close(): Promise<void> { throw new Error('Not implemented') }
}
