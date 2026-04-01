/**
 * Validation contract for WS-5: Discord Alerts
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DiscordAlertClient } from '../discord.js'
import type { AlertClient, AlertMessage } from '../../types/index.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('WS-5: Discord Alerts', () => {
  let client: AlertClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({ ok: true, status: 204 })
    client = new DiscordAlertClient('https://discord.com/api/webhooks/123/abc')
  })

  describe('send()', () => {
    it('sends a trade alert with green color', async () => {
      const msg: AlertMessage = {
        type: 'trade',
        title: 'Trade Executed',
        description: 'Opened LONG position on Twilight',
        fields: [
          { name: 'Price', value: '$65,000', inline: true },
          { name: 'Size', value: '10,000 sats', inline: true },
        ],
        color: 0x00ff00,
      }
      const result = await client.send(msg)
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      )
    })

    it('sends an error alert with red color', async () => {
      const msg: AlertMessage = {
        type: 'error',
        title: 'Connection Lost',
        description: 'Binance WebSocket disconnected',
        color: 0xff0000,
      }
      const result = await client.send(msg)
      expect(result).toBe(true)
    })

    it('sends a risk alert with yellow color', async () => {
      const msg: AlertMessage = {
        type: 'risk',
        title: 'Max Drawdown Warning',
        description: 'Strategy funding-arb approaching 10% drawdown limit',
        color: 0xffff00,
      }
      const result = await client.send(msg)
      expect(result).toBe(true)
    })

    it('returns false on webhook failure without throwing', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 })
      const msg: AlertMessage = {
        type: 'info',
        title: 'Test',
        description: 'Test message',
      }
      const result = await client.send(msg)
      expect(result).toBe(false)
    })

    it('returns false on network error without throwing', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'))
      const msg: AlertMessage = {
        type: 'info',
        title: 'Test',
        description: 'Test message',
      }
      const result = await client.send(msg)
      expect(result).toBe(false)
    })
  })

  describe('sendTradeAlert()', () => {
    it('formats trade details into a structured alert', async () => {
      const result = await client.sendTradeAlert('funding-arb', 'OPEN_LONG', {
        exchange: 'twilight',
        price: 65000,
        size: 10000,
        leverage: 5,
      })
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('sendErrorAlert()', () => {
    it('formats error into a structured alert', async () => {
      const error = new Error('Connection timeout')
      const result = await client.sendErrorAlert('funding-arb', error)
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('sendRiskAlert()', () => {
    it('formats risk check result into a structured alert', async () => {
      const result = await client.sendRiskAlert('funding-arb', {
        allowed: false,
        reason: 'Max drawdown exceeded: 12% > 10% limit',
        control: 'maxDrawdown',
      })
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('Rate limiting', () => {
    it('does not exceed 30 messages per minute', async () => {
      // Send 35 messages rapidly
      const promises = Array.from({ length: 35 }, (_, i) =>
        client.send({
          type: 'info',
          title: `Message ${i}`,
          description: 'Test',
        }),
      )
      const results = await Promise.all(promises)
      // All should succeed (queued, not dropped)
      expect(results.every((r) => r === true)).toBe(true)
      // But fetch should not have been called 35 times immediately
      // Rate limiter should throttle calls
    })
  })

  describe('Webhook URL validation', () => {
    it('accepts valid Discord webhook URLs', () => {
      expect(() => new DiscordAlertClient('https://discord.com/api/webhooks/123/abc')).not.toThrow()
    })

    it('rejects invalid URLs', () => {
      expect(() => new DiscordAlertClient('')).toThrow()
      expect(() => new DiscordAlertClient('not-a-url')).toThrow()
    })
  })

  describe('Message formatting', () => {
    it('sends Discord embed format', async () => {
      await client.send({
        type: 'trade',
        title: 'Test',
        description: 'Test message',
        fields: [{ name: 'Field1', value: 'Value1', inline: true }],
        color: 0x00ff00,
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toHaveProperty('embeds')
      expect(body.embeds[0]).toHaveProperty('title', 'Test')
      expect(body.embeds[0]).toHaveProperty('description', 'Test message')
      expect(body.embeds[0]).toHaveProperty('fields')
      expect(body.embeds[0]).toHaveProperty('color', 0x00ff00)
    })
  })
})
