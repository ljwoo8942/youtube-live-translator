# Security Hardening Review: YouTube Live Translator

## Evidence Basis

We reviewed the completed Codex Security scan `4fa106b8-6762-44a7-a08f-9d276ece870e`: local STT origin admission, local STT resource exhaustion, automatic provider-quota consumption, and popup model-name markup injection. I also inspected the direct callers and compatibility paths before applying focused fixes.

## Constraints

The extension must keep its current Chrome-origin connection to loopback STT, cached model selection, current-caption priority, and dependency-free build. No measured API-cost or GPU-throughput budget was supplied, so the selected ceilings are conservative defaults rather than performance claims.

## Opportunity Portfolio

No structural hardening opportunity qualified. The four findings live at distinct, already-owned boundaries; a shared broker, authentication service, or policy framework would add more operational and failure surface than it removes.

## Recommendation Summary

I recommend local remediation: validate browser origins at the FastAPI boundary, bound bytes/audio/model/inference work there, retain a per-video pretranslation budget in the background worker, and encode dynamic popup text at its HTML sink. These controls directly address the observed paths while preserving the existing component layout and rollback remains a focused file revert.

## Next Decisions

Keep the current fixed limits until real usage shows a compatibility problem. Revisit an exact extension-origin allowlist only if the extension gains a stable published ID, and make quota limits configurable only when users demonstrate a legitimate need beyond the defaults.
