// Stub — WS-10 will implement
import { Command } from 'commander'

export interface ProgramOptions {
  apiUrl?: string
  token?: string
}

export function createProgram(_options?: ProgramOptions): Command {
  const program = new Command()
  program.name('twilight-bots')
  // WS-10 will add all commands
  return program
}
