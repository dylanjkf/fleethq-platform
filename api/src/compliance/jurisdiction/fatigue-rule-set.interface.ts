export type FatigueStatus = 'ok' | 'approaching_limit' | 'breach';

export interface FatigueRuleFlag {
  /** Stable machine key, e.g. 'MAX_WORK_24H' — never localized, safe to key UI copy or tests off. */
  rule: string;
  label: string;
  message: string;
}

export interface FatigueShiftInterval {
  startedAt: Date;
  /** The shift's own `endedAt`, or `now` if it's still active. */
  endedAt: Date;
}

export interface FatigueEvaluationInput {
  /** All shifts overlapping the rule set's own lookback window, oldest first. */
  shifts: FatigueShiftInterval[];
  now: Date;
}

export interface FatigueEvaluationResult {
  status: FatigueStatus;
  breaches: FatigueRuleFlag[];
  approaching: FatigueRuleFlag[];
  workMinutesLast24h: number;
  longestRestMinutesLast24h: number;
  workMinutesLast7d: number;
  longestRestMinutesLast7d: number;
}

/**
 * A jurisdiction's fatigue rule set (08-Compliance/Jurisdiction_Model.md):
 * "every compliance rule is associated with a jurisdiction... the compliance
 * service resolves which rule set applies." `FatigueService` (the core,
 * jurisdiction-agnostic service) only ever calls `evaluate()` through this
 * interface — no jurisdiction-specific hour limit is allowed to live in the
 * core service itself.
 */
export interface FatigueRuleSet {
  jurisdiction: string;
  name: string;
  /** How far back from `now` the caller must fetch shifts for `evaluate()` to see everything it needs. */
  lookbackDays: number;
  evaluate(input: FatigueEvaluationInput): FatigueEvaluationResult;
}
