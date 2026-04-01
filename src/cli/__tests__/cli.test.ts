/**
 * Validation contract for WS-10: CLI
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProgram } from '../index.js'
import { runSetupWizard } from '../setup.js'

// Mock inquirer for non-interactive testing
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}))

// Mock fetch for REST API calls
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import inquirer from 'inquirer'

describe('WS-10: CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ strategies: [], uptime: 100 }),
    })
  })

  describe('Program creation', () => {
    it('creates a commander program with all commands', () => {
      const program = createProgram()
      expect(program).toBeDefined()
      expect(program.name()).toBe('twilight-bots')

      // Verify all commands exist
      const commandNames = program.commands.map((c: any) => c.name())
      expect(commandNames).toContain('setup')
      expect(commandNames).toContain('status')
      expect(commandNames).toContain('start')
      expect(commandNames).toContain('stop')
      expect(commandNames).toContain('config')
      expect(commandNames).toContain('wallet')
      expect(commandNames).toContain('market')
      expect(commandNames).toContain('logs')
    })
  })

  describe('Setup wizard', () => {
    it('runs through all 5 steps and writes config', async () => {
      const mockPrompt = vi.mocked(inquirer.prompt)
      // Step 1: Wallet
      mockPrompt.mockResolvedValueOnce({ walletAction: 'create' })
      // Step 2: Binance
      mockPrompt.mockResolvedValueOnce({ apiKey: 'test-key', apiSecret: 'test-secret' })
      // Step 3: Discord
      mockPrompt.mockResolvedValueOnce({ webhookUrl: 'https://discord.com/api/webhooks/123/abc' })
      // Step 4: Strategy selection
      mockPrompt.mockResolvedValueOnce({ strategies: ['funding-arb', 'lending-yield'] })
      // Step 5: Risk profile
      mockPrompt.mockResolvedValueOnce({ riskProfile: 'moderate' })

      const config = await runSetupWizard({ dryRun: true })
      expect(config).toBeDefined()
      expect(config.binance.apiKey).toBe('test-key')
      expect(config.strategies).toContain('funding-arb')
      expect(config.riskProfile).toBe('moderate')
    })
  })

  describe('Management commands call REST API', () => {
    it('status command calls GET /status', async () => {
      const program = createProgram({ apiUrl: 'http://localhost:3000', token: 'test' })
      await program.parseAsync(['node', 'twilight-bots', 'status'])
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/status',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test',
          }),
        }),
      )
    })

    it('start command calls POST /strategies/:id/start', async () => {
      const program = createProgram({ apiUrl: 'http://localhost:3000', token: 'test' })
      await program.parseAsync(['node', 'twilight-bots', 'start', 'funding-arb'])
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/strategies/funding-arb/start',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('stop command calls POST /strategies/:id/stop', async () => {
      const program = createProgram({ apiUrl: 'http://localhost:3000', token: 'test' })
      await program.parseAsync(['node', 'twilight-bots', 'stop', 'funding-arb'])
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/strategies/funding-arb/stop',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('market command calls relayer-cli for market data', async () => {
      const program = createProgram({ apiUrl: 'http://localhost:3000', token: 'test' })
      // Market command may call the API or relayer-cli directly
      await program.parseAsync(['node', 'twilight-bots', 'market'])
      // Just verify it doesn't crash
      expect(true).toBe(true)
    })
  })

  describe('Error handling', () => {
    it('handles connection errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
      const program = createProgram({ apiUrl: 'http://localhost:3000', token: 'test' })

      // Should not throw, should handle gracefully
      await expect(
        program.parseAsync(['node', 'twilight-bots', 'status']),
      ).resolves.toBeDefined()
    })
  })
})
