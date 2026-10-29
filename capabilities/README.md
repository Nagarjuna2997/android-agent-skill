# Capabilities

A capability is a self-contained feature recipe an agent follows to add one thing to an Android app: a database, sign-in, push notifications, a map. Each lives in its own folder with a single `README.md` that an agent can load on its own, without the rest of this repository, and still produce compiling code.

## What a capability entry contains

Every `capabilities/<id>/README.md` has the same sections in the same order:

| Section | What it must answer |
|---|---|
| `## When to use` | the problem it solves, the alternatives, and when not to use it |
| `## Dependencies` | the `gradle/libs.versions.toml` entries and `build.gradle.kts` lines; versions from `data/versions.json`, or `<version>` with the official release page when the catalog does not pin one |
| `## Manifest and permissions` | permissions, components, metadata, and any files hosted outside the app (`assetlinks.json`, `google-services.json`) |
| `## Implementation` | complete Kotlin: data layer behind an interface, the DI module (Hilt by default), ViewModel exposing one `UiState`, and the Compose integration where the feature has UI |
| `## Verify` | the exact `./gradlew` and `adb` commands that prove it works, plus at least one test the agent can paste |
| `## Pitfalls` | the mistakes that produce a build that compiles and then fails at runtime or in review |
| `## Sources` | official documentation URLs the recipe was written against |

Code uses `com.example.app` placeholders, Kotlin 2.4.20, Compose BOM 2026.09.00 and the toolchain in `data/versions.json`. Recipes follow the repository's architecture rules: unidirectional data flow, `StateFlow` + `collectAsStateWithLifecycle()`, injected dispatchers, sealed result types that rethrow `CancellationException`, explicit loading/empty/error states, and runtime permissions requested in context with a rationale.

## How an agent picks a capability

1. Search `CATALOG.md` (or `catalog.json` for tooling) by name, category or tag. Do not open every folder.
2. Read the one folder the task needs. A recipe cross-links its neighbors (for example `notifications` from `firebase-cloud-messaging`); follow a link only when the task actually needs that second feature.
3. Check the project first. If the app already has Koin, Retrofit, or XML Views, adapt the recipe to what exists rather than introducing a parallel stack. The `hilt-di`/`koin-di` and `retrofit-networking`/`ktor-client` pairs exist for this reason.
4. Resolve every `<version>` placeholder from the linked release page before writing `libs.versions.toml`. Never invent a version number.
5. Run the `## Verify` commands. Report what was built and tested, separately from what was only written.

## The honesty rule

A catalog entry is a recipe, not proof of a working build in the user's project.

- Each recipe was written against the official documentation listed in its `## Sources` and the versions in `data/versions.json`. The code is meant to compile in context, but it has not been built inside the user's project with the user's dependency graph, minSdk, flavors and existing code.
- An agent that applies a recipe must compile (`./gradlew :app:assembleDebug`), run the tests in `## Verify`, and only then say the feature works. The report must distinguish: inspected source, built and unit-tested, built and tested on a device or emulator, and unverified on device.
- Some capabilities cannot be verified on a standard emulator at all and say so in their text: on-device AI (`on-device-ai`), Play Billing purchase flows (`play-billing`), Credential Manager with passkeys, Wear OS pairing (`wear-os-companion`, which is marked runtime-unverified). Those must be reported as unverified until run on suitable hardware.
- Preview or device-gated APIs are flagged in the recipe (Gemini Nano availability, `@ExperimentalPagingApi` on `RemoteMediator`, Media3 `@UnstableApi` surfaces, Material 3 Expressive). The agent must repeat that flag to the user, not silently opt in.

## Adding a capability

Add a folder named with a kebab-case id, write its `README.md` with the sections above (150 to 350 lines), then add a row to `CATALOG.md` and an object to `catalog.json`. Keep the three in sync; `catalog.json` is the machine-readable source and `CATALOG.md` is rendered from the same data by hand for now.

## Layout

```text
capabilities/
  README.md          this file
  CATALOG.md         table of every capability
  catalog.json       the same table, machine-readable (schemaVersion 1)
  <id>/README.md     one recipe per capability
```
