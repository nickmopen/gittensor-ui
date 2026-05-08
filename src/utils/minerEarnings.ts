import { parseNumber } from './ExplorerUtils';
import type { MinerEvaluation } from '../api/models/Dashboard';

export type ResolvedEarnings = {
  usdPerDay: number;
  lifetimeUsd: number;
  /**
   * Always `true` — the split is derived, not an explicit API figure.
   * Callers should render a "~" prefix to communicate the approximation.
   */
  isEstimated: true;
  tooltipNote: string;
};

type RatePair = { ossRate: number; issRate: number };

/**
 * Derive per-track incentive-per-score-point rates from the full miner list.
 *
 * Uses pure-track reference miners to calibrate the weighting:
 *   ossRate = avg(metagraphIncentive / totalScore)        across OSS-only miners
 *   issRate = avg(metagraphIncentive / issueDiscoveryScore) across issue-only miners
 *
 * Returns `null` when there are not enough reference miners to calibrate
 * (falls back to score-proportional split in that case).
 */
export const computeTrackRates = (
  allMiners: Pick<
    MinerEvaluation,
    'totalScore' | 'issueDiscoveryScore' | 'metagraphIncentive'
  >[],
): RatePair | null => {
  const ossRef = allMiners.filter(
    (m) =>
      parseNumber(m.totalScore) > 1 &&
      parseNumber(m.issueDiscoveryScore) === 0 &&
      (m.metagraphIncentive ?? 0) > 0,
  );
  const issRef = allMiners.filter(
    (m) =>
      parseNumber(m.totalScore) === 0 &&
      parseNumber(m.issueDiscoveryScore) > 1 &&
      (m.metagraphIncentive ?? 0) > 0,
  );

  if (ossRef.length === 0 || issRef.length === 0) return null;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const ossRate = avg(
    ossRef.map((m) => (m.metagraphIncentive ?? 0) / parseNumber(m.totalScore)),
  );
  const issRate = avg(
    issRef.map(
      (m) =>
        (m.metagraphIncentive ?? 0) / parseNumber(m.issueDiscoveryScore),
    ),
  );

  return ossRate > 0 && issRate > 0 ? { ossRate, issRate } : null;
};

/**
 * Resolve mode-specific earnings from a miner record.
 *
 * When `rates` are available (derived from `computeTrackRates`):
 *   Uses calibrated incentive-per-score-point weights so that score units
 *   from different tracks are not treated as equivalent. Empirically,
 *   one issue-discovery score point yields ~2× more metagraph incentive
 *   than one OSS score point on the current subnet.
 *
 * When `rates` are not available (insufficient reference miners):
 *   Falls back to simple score-proportional split.
 *
 * Zero-score fallback: OSS receives the full combined amount; issues show $0.
 *
 * Always returns `isEstimated: true` — values are approximations until the
 * API returns explicit per-track fields (ossUsdPerDay / issueUsdPerDay).
 */
export const resolveEarnings = (
  miner: Pick<
    MinerEvaluation,
    'usdPerDay' | 'lifetimeUsd' | 'totalScore' | 'issueDiscoveryScore'
  >,
  mode: 'prs' | 'issues',
  rates: RatePair | null = null,
): ResolvedEarnings => {
  const combinedUsd = miner.usdPerDay ?? 0;
  const combinedLife = miner.lifetimeUsd ?? 0;

  const ossScore = Math.max(0, parseNumber(miner.totalScore));
  const issScore = Math.max(0, parseNumber(miner.issueDiscoveryScore));

  // Zero-score fallback — nothing to split.
  if (ossScore === 0 && issScore === 0) {
    if (mode === 'issues') {
      return {
        usdPerDay: 0,
        lifetimeUsd: 0,
        isEstimated: true,
        tooltipNote: 'No issue discovery score yet; issue-track earnings shown as zero.',
      };
    }
    return {
      usdPerDay: combinedUsd,
      lifetimeUsd: combinedLife,
      isEstimated: true,
      tooltipNote: 'No score data to split earnings; showing combined estimate.',
    };
  }

  // Compute weighted scores using calibrated rates when available,
  // otherwise fall back to treating scores as directly comparable.
  const ossWeight = rates ? ossScore * rates.ossRate : ossScore;
  const issWeight = rates ? issScore * rates.issRate : issScore;
  const totalWeight = ossWeight + issWeight;

  const fraction = mode === 'prs' ? ossWeight / totalWeight : issWeight / totalWeight;

  const splitNote =
    ossScore > 0 && issScore > 0
      ? rates
        ? 'Earnings split by calibrated track weights derived from validator incentive data.'
        : 'Split proportionally by score — calibrated split unavailable until more single-track miners exist.'
      : '';

  return {
    usdPerDay: combinedUsd * fraction,
    lifetimeUsd: combinedLife * fraction,
    isEstimated: true,
    tooltipNote: splitNote,
  };
};
