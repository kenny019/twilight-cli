/**
 * Validation contract for WS-11: Docker & Deploy
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dirname, '..')

describe('WS-11: Docker & Deploy', () => {
  describe('Dockerfile', () => {
    it('exists', () => {
      expect(existsSync(join(ROOT, 'Dockerfile'))).toBe(true)
    })

    it('uses Node.js 20 Alpine base', () => {
      const content = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8')
      expect(content).toMatch(/FROM node:20.*alpine/i)
    })

    it('exposes port 3000', () => {
      const content = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8')
      expect(content).toContain('EXPOSE 3000')
    })

    it('has a health check', () => {
      const content = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8')
      expect(content).toMatch(/HEALTHCHECK/i)
    })

    it('uses multi-stage build', () => {
      const content = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8')
      const fromCount = (content.match(/^FROM /gm) || []).length
      expect(fromCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('railway.json', () => {
    it('exists', () => {
      expect(existsSync(join(ROOT, 'railway.json'))).toBe(true)
    })

    it('is valid JSON with deploy config', () => {
      const content = JSON.parse(readFileSync(join(ROOT, 'railway.json'), 'utf-8'))
      expect(content).toHaveProperty('$schema')
    })
  })

  describe('docker-compose.yml', () => {
    it('exists', () => {
      expect(existsSync(join(ROOT, 'docker-compose.yml'))).toBe(true)
    })

    it('defines a service with persistent volume', () => {
      const content = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf-8')
      expect(content).toContain('volumes')
    })
  })

  describe('.env.example', () => {
    it('exists', () => {
      expect(existsSync(join(ROOT, '.env.example'))).toBe(true)
    })

    it('documents all required environment variables', () => {
      const content = readFileSync(join(ROOT, '.env.example'), 'utf-8')
      // Core Twilight variables
      expect(content).toContain('TWILIGHT_WALLET_ID')
      expect(content).toContain('TWILIGHT_PASSWORD')
      // Binance variables
      expect(content).toContain('BINANCE_API_KEY')
      expect(content).toContain('BINANCE_API_SECRET')
      // Discord
      expect(content).toContain('DISCORD_WEBHOOK_URL')
      // Server
      expect(content).toContain('BEARER_TOKEN')
      expect(content).toContain('PORT')
    })
  })
})
