# Governance parameters (versioned configuration)

Single source: `api/orchestrator/config.ts` (`PARAM_SPECS`). Version `GOVERNANCE_CONFIG_VERSION`; every audit event stores the version and a
SHA-256 fingerprint of the effective values, so a decision can always be tied to the exact parameters that produced it.

Classes: **REFERENCE** = taken from the PDF (or a user instruction); **EMPIRICAL** = calculated and tested on data (none exist yet: nothing has been
calibrated, so no value may claim this class); **PROPOSED** = a project guess, temporary, configurable, never silently permanent.

`loadGovernanceConfig(overrides)` rejects (throws `GovernanceConfigError`): unknown keys, non-finite or non-number values, values outside `[min, max]`,
`invalidationMinAtr >= invalidationMaxAtr`, `borderlineRr < minRr`. Overrides are listed in `config.overridden`.

The three thresholds the audit flagged as not coming from the PDF:

| Parameter | Value | Class | Source / rationale |
|---|---|---|---|
| `borderlineRr` (the "R:R 1.8") | 1.8 | PROPOSED | none; 20% above the 1.5 floor, Elite fallback only |
| `borderlineFreshnessRatio` (the "75%") | 0.75 | PROPOSED | none; Elite fallback only |
| `approvalThreshold` (the "60%") | 0.6 | PROPOSED | none; PDF only says "a threshold" |

All other parameters, with class, bounds, unit, source and rationale, are the entries of `PARAM_SPECS` (generated documentation would duplicate them;
`api/tests/hardening.test.ts` asserts that every entry has class, source, rationale and a default inside its bounds).
