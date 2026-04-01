// Stub — WS-5 will implement
import type { AlertClient } from '../types/index.js'

export class DiscordAlertClient implements AlertClient {
  constructor(_webhookUrl: string) {
    throw new Error('Not implemented — WS-5')
  }
  send(_message: any): Promise<boolean> { throw new Error('Not implemented') }
  sendTradeAlert(_strategyId: string, _action: string, _details: any): Promise<boolean> { throw new Error('Not implemented') }
  sendErrorAlert(_strategyId: string, _error: Error): Promise<boolean> { throw new Error('Not implemented') }
  sendRiskAlert(_strategyId: string, _check: any): Promise<boolean> { throw new Error('Not implemented') }
}
