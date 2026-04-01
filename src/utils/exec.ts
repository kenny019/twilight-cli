import { execFile as nodeExecFile } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
}

export function execFileAsync(
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(command, args, { timeout: options?.timeout ?? 30000, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
      }
    })
  })
}
