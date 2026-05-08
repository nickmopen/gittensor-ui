import { describe, it, expect } from 'vitest';
import { computeTrackRates, resolveEarnings } from '../utils/minerEarnings';
import type { MinerEvaluation } from '../api/models/Dashboard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeMiner = (
  overrides: Partial<
    Pick<
      MinerEvaluation,
      'usdPerDay' | 'lifetimeUsd' | 'totalScore' | 'issueDiscoveryScore'
    >
  > = {},
): Pick<
  MinerEvaluation,
  'usdPerDay' | 'lifetimeUsd' | 'totalScore' | 'issueDiscoveryScore'
> => ({
  usdPerDay: 100,
  lifetimeUsd: 3000,
  totalScore: 0,
  issueDiscoveryScore: 0,
  ...overrides,
});

// Pure-track reference miners for calibration tests.
// ossRate = incentive / totalScore = 0.0004
// issRate = incentive / issueDiscoveryScore = 0.0008 (2× oss)
const makeOssRefMiner = (totalScore: number) =>
  ({
    totalScore,
    issueDiscoveryScore: 0,
    metagraphIncentive: totalScore * 0.0004,
  }) as Pick<
    MinerEvaluation,
    'totalScore' | 'issueDiscoveryScore' | 'metagraphIncentive'
  >;

const makeIssRefMiner = (issueDiscoveryScore: number) =>
  ({
    totalScore: 0,
    issueDiscoveryScore,
    metagraphIncentive: issueDiscoveryScore * 0.0008,
  }) as Pick<
    MinerEvaluation,
    'totalScore' | 'issueDiscoveryScore' | 'metagraphIncentive'
  >;

// ---------------------------------------------------------------------------
// computeTrackRates
// ---------------------------------------------------------------------------
describe('computeTrackRates', () => {
  it('returns null when no OSS reference miners exist', () => {
    expect(computeTrackRates([makeIssRefMiner(50)])).toBeNull();
  });

  it('returns null when no issue reference miners exist', () => {
    expect(computeTrackRates([makeOssRefMiner(50)])).toBeNull();
  });

  it('returns null when reference miner lists are empty', () => {
    expect(computeTrackRates([])).toBeNull();
  });

  it('derives correct rates from known reference miners', () => {
    const miners = [
      makeOssRefMiner(100),
      makeOssRefMiner(200),
      makeIssRefMiner(50),
    ];
    const rates = computeTrackRates(miners);
    expect(rates).not.toBeNull();
    expect(rates!.ossRate).toBeCloseTo(0.0004);
    expect(rates!.issRate).toBeCloseTo(0.0008);
  });

  it('averages ossRate across multiple OSS reference miners', () => {
    const miners = [
      makeOssRefMiner(100), // rate = 0.0004
      makeOssRefMiner(200), // rate = 0.0004
      makeOssRefMiner(400), // rate = 0.0004
      makeIssRefMiner(80),
    ];
    const rates = computeTrackRates(miners);
    expect(rates!.ossRate).toBeCloseTo(0.0004);
  });

  it('ignores miners with zero metagraphIncentive', () => {
    const badMiner = { totalScore: 100, issueDiscoveryScore: 0, metagraphIncentive: 0 };
    const miners = [badMiner, makeOssRefMiner(150), makeIssRefMiner(60)];
    const rates = computeTrackRates(miners);
    // badMiner excluded; rates should still be correct
    expect(rates!.ossRate).toBeCloseTo(0.0004);
  });

  it('returns null when rates compute to zero', () => {
    // All incentive values are 0, so filtered out → both ref lists empty
    const miners = [
      { totalScore: 100, issueDiscoveryScore: 0, metagraphIncentive: 0 },
      { totalScore: 0, issueDiscoveryScore: 50, metagraphIncentive: 0 },
    ] as Pick<MinerEvaluation, 'totalScore' | 'issueDiscoveryScore' | 'metagraphIncentive'>[];
    expect(computeTrackRates(miners)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveEarnings — calibrated split (rates provided)
// ---------------------------------------------------------------------------
describe('resolveEarnings — calibrated split', () => {
  const rates = { ossRate: 0.0004, issRate: 0.0008 }; // issRate is 2× ossRate

  it('OSS-only miner: prs receives 100%, issues receives 0%', () => {
    const miner = makeMiner({ totalScore: 50, issueDiscoveryScore: 0 });
    expect(resolveEarnings(miner, 'prs', rates).usdPerDay).toBe(100);
    expect(resolveEarnings(miner, 'issues', rates).usdPerDay).toBe(0);
  });

  it('issue-only miner: issues receives 100%, prs receives 0%', () => {
    const miner = makeMiner({ totalScore: 0, issueDiscoveryScore: 50 });
    expect(resolveEarnings(miner, 'issues', rates).usdPerDay).toBe(100);
    expect(resolveEarnings(miner, 'prs', rates).usdPerDay).toBe(0);
  });

  it('equal raw scores split ~33% OSS / ~67% issue (because issRate is 2×)', () => {
    // ossWeight = 50 * 0.0004 = 0.02  →  fraction = 0.02 / 0.06 ≈ 33.3%
    // issWeight = 50 * 0.0008 = 0.04  →  fraction = 0.04 / 0.06 ≈ 66.7%
    const miner = makeMiner({ totalScore: 50, issueDiscoveryScore: 50 });
    const prs = resolveEarnings(miner, 'prs', rates);
    const iss = resolveEarnings(miner, 'issues', rates);
    expect(prs.usdPerDay).toBeCloseTo(33.33, 1);
    expect(iss.usdPerDay).toBeCloseTo(66.67, 1);
  });

  it('conservation: prs + issues always equals combined', () => {
    const miner = makeMiner({ totalScore: 30, issueDiscoveryScore: 70 });
    const prs = resolveEarnings(miner, 'prs', rates);
    const iss = resolveEarnings(miner, 'issues', rates);
    expect(prs.usdPerDay + iss.usdPerDay).toBeCloseTo(100);
    expect(prs.lifetimeUsd + iss.lifetimeUsd).toBeCloseTo(3000);
  });

  it('values change between modes — the original bug is fixed', () => {
    const miner = makeMiner({ totalScore: 40, issueDiscoveryScore: 60 });
    const prs = resolveEarnings(miner, 'prs', rates);
    const iss = resolveEarnings(miner, 'issues', rates);
    expect(prs.usdPerDay).not.toBe(iss.usdPerDay);
  });

  it('isEstimated is always true', () => {
    const miner = makeMiner({ totalScore: 40, issueDiscoveryScore: 60 });
    expect(resolveEarnings(miner, 'prs', rates).isEstimated).toBe(true);
    expect(resolveEarnings(miner, 'issues', rates).isEstimated).toBe(true);
  });

  it('calibrated result differs from naive score-proportional result', () => {
    // With equal scores and 2× issue rate, calibrated gives 33/67 not 50/50
    const miner = makeMiner({ totalScore: 50, issueDiscoveryScore: 50 });
    const calibrated = resolveEarnings(miner, 'prs', rates);
    const naive = resolveEarnings(miner, 'prs', null); // no rates = score-proportional
    expect(calibrated.usdPerDay).not.toBeCloseTo(naive.usdPerDay, 0);
  });
});

// ---------------------------------------------------------------------------
// resolveEarnings — score-proportional fallback (rates = null)
// ---------------------------------------------------------------------------
describe('resolveEarnings — score-proportional fallback (no rates)', () => {
  it('equal scores split 50/50', () => {
    const miner = makeMiner({ totalScore: 4, issueDiscoveryScore: 4 });
    expect(resolveEarnings(miner, 'prs', null).usdPerDay).toBeCloseTo(50);
    expect(resolveEarnings(miner, 'issues', null).usdPerDay).toBeCloseTo(50);
  });

  it('3:1 ratio splits correctly', () => {
    const miner = makeMiner({ totalScore: 6, issueDiscoveryScore: 2 });
    expect(resolveEarnings(miner, 'prs', null).usdPerDay).toBeCloseTo(75);
    expect(resolveEarnings(miner, 'issues', null).usdPerDay).toBeCloseTo(25);
  });
});

// ---------------------------------------------------------------------------
// resolveEarnings — zero-score fallback
// ---------------------------------------------------------------------------
describe('resolveEarnings — zero-score fallback', () => {
  it('prs mode receives the full combined amount when both scores are zero', () => {
    const r = resolveEarnings(makeMiner(), 'prs', null);
    expect(r.usdPerDay).toBe(100);
    expect(r.lifetimeUsd).toBe(3000);
  });

  it('issues mode receives $0 when both scores are zero', () => {
    const r = resolveEarnings(makeMiner(), 'issues', null);
    expect(r.usdPerDay).toBe(0);
    expect(r.lifetimeUsd).toBe(0);
  });

  it('negative scores are clamped to zero', () => {
    const miner = makeMiner({ totalScore: -5, issueDiscoveryScore: -3 });
    expect(resolveEarnings(miner, 'prs', null).usdPerDay).toBe(100);
  });

  it('missing usdPerDay/lifetimeUsd default to zero', () => {
    const miner = makeMiner({ totalScore: 5, issueDiscoveryScore: 3 });
    delete (miner as Partial<typeof miner>).usdPerDay;
    delete (miner as Partial<typeof miner>).lifetimeUsd;
    const r = resolveEarnings(miner, 'prs', null);
    expect(r.usdPerDay).toBe(0);
    expect(r.lifetimeUsd).toBe(0);
  });
});
