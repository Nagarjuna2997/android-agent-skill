# Roadmap and current limitations

This is a functional developer preview, not completion of the full production platform vision.

## Before production readiness

- Run real Android SDK builds, emulator boot/install/UI tests and physical-device tests; current local environment has no configured SDK/adb.
- Validate each MCP host integration and the CI operating-system matrix.
- Add a compiler-backed Gradle model and Kotlin/Compose semantic analysis. Current analysis is heuristic and cannot prove recomposition, coroutine ownership, variant correctness or resolved dependency compatibility.
- Add merged-release-manifest, signing, bundletool, native page-size and full Play listing checks. No publication or guaranteed store approval.
- Add a Firebase Emulator Suite rules test harness and service-specific configuration checks. Current Firebase audit never queries deployed rules or proves App Check enforcement.
- Add verified vulnerability-data queries with explicit coordinate-sharing consent. Current SBOM lists declared direct dependencies only.
- Add measured contrast, density-aware touch targets, TalkBack/focus and font scaling tests; runtime metrics are raw dumps, not comprehensive profiling.
- Add guided code changes with reviewed patches, verification gates and rollback. No autonomous fix command currently exists.
- Add automatic multi-device screenshot matrices, real hardware-frame catalogs, multilingual shaping/overflow tests and screenshot comparison.
- Add complete streaming tool-call handling and schema validation across providers. Provider request contracts are mocked; no paid live provider calls were made.
- Add isolated WITH/WITHOUT agent benchmark trials. Fixture checks are not agent-performance scores.
- Harden concurrent confirmations, cancellation across transports and native Windows Gradle execution. Use WSL for Gradle on Windows today.

## Platform maturity

ADB operations are generic to authorized Android devices. Phones, tablets, foldables, Wear OS, TV, Automotive, ChromeOS Android and XR devices can use applicable ADB operations, but none has been runtime-certified by this release. Android Auto host integration and specialized Wear/TV/Automotive/XR journeys remain separate future modules. Official XR APIs may still be preview APIs; do not treat transport access as stable SDK support.

## Release sequence

1. Publish source and validation evidence.
2. Run CI and SDK-backed acceptance tests; fix failures.
3. Review package metadata, security and API stability.
4. Publish a preview npm package only with maintainer authentication and intent.
5. Expand Android fixture lanes and independent agent evaluations before stable v1.
