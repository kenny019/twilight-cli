import { ai } from '@ax-llm/ax'
import type { AxAIService } from '@ax-llm/ax'
import type { AgentConfig } from '../types/agent.js'

/**
 * Map user-facing provider names to ax provider identifiers.
 * Covers common aliases so config stays ergonomic.
 */
const PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google-gemini',
  'google-gemini': 'google-gemini',
  groq: 'groq',
  deepseek: 'deepseek',
  mistral: 'mistral',
  cohere: 'cohere',
  together: 'together',
  openrouter: 'openrouter',
  ollama: 'ollama',
}

export function createAIProvider(config: AgentConfig): AxAIService {
  const providerName = PROVIDER_MAP[config.provider]
  if (!providerName) {
    throw new Error(`Unsupported AI provider: "${config.provider}". Supported: ${Object.keys(PROVIDER_MAP).join(', ')}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ax resolves model strings at runtime
  return ai({ name: providerName as any, apiKey: config.apiKey, config: { model: config.model as any } })
}

// ─── Budget Tracker ─────────────────────────────────────────────

export class BudgetTracker {
  callsThisHour = 0
  tokensToday = 0

  private hourStart = Date.now()
  private dayStartUtc = startOfDayUtc()

  trackCall(tokens: number): void {
    this.resetIfStale()
    this.callsThisHour++
    this.tokensToday += tokens
  }

  isExhausted(config: AgentConfig): boolean {
    this.resetIfStale()
    return (
      this.callsThisHour >= config.budget.maxCallsPerHour ||
      this.tokensToday >= config.budget.maxTokensPerDay
    )
  }

  remaining(config: AgentConfig): { calls: number; tokens: number } {
    this.resetIfStale()
    return {
      calls: Math.max(0, config.budget.maxCallsPerHour - this.callsThisHour),
      tokens: Math.max(0, config.budget.maxTokensPerDay - this.tokensToday),
    }
  }

  private resetIfStale(): void {
    const now = Date.now()

    // Reset hourly counter
    if (now - this.hourStart >= 3_600_000) {
      this.callsThisHour = 0
      this.hourStart = now
    }

    // Reset daily counter at midnight UTC
    const currentDayStart = startOfDayUtc()
    if (currentDayStart > this.dayStartUtc) {
      this.tokensToday = 0
      this.dayStartUtc = currentDayStart
    }
  }
}

function startOfDayUtc(): number {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime()
}
