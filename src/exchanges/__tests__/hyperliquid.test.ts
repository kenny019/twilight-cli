import { describe, it, expect } from 'vitest'
import { quantizeBtc, formatPerpPrice } from '../hyperliquid.js'

describe('Hyperliquid quantization', () => {
  describe('quantizeBtc', () => {
    it('rounds up to step size for typical BTC perp (szDecimals=5)', () => {
      // 13,000 sats = 0.00013 BTC — already on step
      expect(quantizeBtc(13_000, 77_000, 5)).toBe(0.00013)
    })

    it('rounds up sub-step sats to next step', () => {
      // 13,500 sats = 0.000135 BTC → ceil to 0.00014
      expect(quantizeBtc(13_500, 77_000, 5)).toBe(0.00014)
    })

    it('bumps below-min-notional sizes up to min-notional', () => {
      // 5,000 sats @ 77k = 0.00005 BTC = $3.85 — below $10 min
      const result = quantizeBtc(5_000, 77_000, 5)
      expect(result * 77_000).toBeGreaterThanOrEqual(10)
      // Should produce 0.00013 (next step above $10 / $77k)
      expect(result).toBe(0.00013)
    })

    it('handles lower mark price requiring larger size for min notional', () => {
      // At $50k, $10 min = 0.0002 BTC
      const result = quantizeBtc(5_000, 50_000, 5)
      expect(result * 50_000).toBeGreaterThanOrEqual(10)
      expect(result).toBe(0.0002)
    })

    it('rejects non-positive inputs', () => {
      expect(() => quantizeBtc(0, 77_000, 5)).toThrow()
      expect(() => quantizeBtc(-100, 77_000, 5)).toThrow()
      expect(() => quantizeBtc(10_000, 0, 5)).toThrow()
      expect(() => quantizeBtc(10_000, -1, 5)).toThrow()
    })

    it('respects szDecimals for non-BTC assets (e.g. ETH szDecimals=4)', () => {
      // 200_000 sats = 0.002 BTC equivalent — but if szDecimals=4 the step is 0.0001
      // 0.002 BTC / 0.0001 step = 20 steps exactly
      expect(quantizeBtc(200_000, 77_000, 4)).toBe(0.002)
    })
  })

  describe('formatPerpPrice', () => {
    it('truncates BTC mark price (~$77k) to integer (5 sig figs)', () => {
      // szDecimals=5 → maxDecimals=1; price 77123.456 → "77123" (integer part is already 5 digits)
      expect(formatPerpPrice(77_123.456, 5)).toBe('77123')
    })

    it('allows decimals up to (6 - szDecimals) when integer part is short', () => {
      // szDecimals=5 → maxDecimals = 6-5 = 1; price 999.5 → "999.5"
      expect(formatPerpPrice(999.5, 5)).toBe('999.5')
    })

    it('allows more decimals for assets with smaller szDecimals', () => {
      // szDecimals=2 → maxDecimals = 4; price 3.14159 → integer 1 digit → allow min(4, 4) = 4 decimals
      expect(formatPerpPrice(3.14159, 2)).toBe('3.1416')
    })

    it('uses integer when number is exactly at sig-fig boundary', () => {
      expect(formatPerpPrice(77_000, 5)).toBe('77000')
    })

    it('rejects non-positive prices', () => {
      expect(() => formatPerpPrice(0, 5)).toThrow()
      expect(() => formatPerpPrice(-1, 5)).toThrow()
    })
  })
})
