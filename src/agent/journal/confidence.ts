/**
 * MAD-based confidence scoring for parameter adjustments.
 *
 * The 1.4826 factor normalizes MAD to be comparable to standard deviation
 * under a normal distribution assumption.
 */

const MIN_SAMPLES = 5
const MAD_NORMALIZATION = 1.4826

export function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

export function computeMADConfidence(pnlSeries: number[]): number | null {
  if (pnlSeries.length < MIN_SAMPLES) return null

  const med = median(pnlSeries)
  const absoluteDeviations = pnlSeries.map((v) => Math.abs(v - med))
  const mad = median(absoluteDeviations)
  const mean = pnlSeries.reduce((s, v) => s + v, 0) / pnlSeries.length

  const denominator = mad * MAD_NORMALIZATION
  if (denominator === 0) return Math.abs(mean) === 0 ? 0 : Infinity

  return Math.abs(mean) / denominator
}

export function checkAdjustmentStatus(
  confidenceScore: number | null,
  confidenceThreshold: number,
  revertThreshold: number,
): 'keep' | 'persist' | 'revert' | 'insufficient_data' {
  if (confidenceScore === null) return 'insufficient_data'
  if (confidenceScore >= confidenceThreshold) return 'persist'
  if (confidenceScore < revertThreshold) return 'revert'
  return 'keep'
}
