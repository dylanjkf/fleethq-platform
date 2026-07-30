import { AU_STANDARD_HOURS } from './au-fatigue-rules';
import type { FatigueRuleSet } from './fatigue-rule-set.interface';

const FATIGUE_RULE_SETS: Record<string, FatigueRuleSet> = {
  AU: AU_STANDARD_HOURS,
};

/**
 * 08-Compliance/Jurisdiction_Model.md: "a hypothetical second jurisdiction
 * module could be added and assigned to a company without modifying the core
 * compliance service." A company whose jurisdiction has no registered rule
 * set gets `null` back — fatigue is then reported `not_assessed`, per the
 * doc's own "must be modeled as present-or-absent per jurisdiction, not
 * force-fit" edge case, rather than silently falling back to AU's rules.
 */
export function getFatigueRuleSet(jurisdiction: string): FatigueRuleSet | null {
  return FATIGUE_RULE_SETS[jurisdiction] ?? null;
}
