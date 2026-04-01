// Stub — WS-10 will implement
import type { AppConfig } from '../types/index.js'

export interface SetupOptions {
  dryRun?: boolean
}

export async function runSetupWizard(_options?: SetupOptions): Promise<AppConfig> {
  throw new Error('Not implemented — WS-10')
}
