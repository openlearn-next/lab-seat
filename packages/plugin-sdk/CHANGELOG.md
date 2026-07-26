# Changelog

All notable changes to **@openlearn/plugin-sdk** are documented here.

> This package is versioned independently from the platform `openlearn-next` host.
> Bumping the SDK does not change the platform version.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [3.4.3] - 2026-07-26

### Features
- **Remote Update Detection**: Add `updateSource` field to `Manifest` interface (`openlearn.d.ts`), allowing plugins to declare a GitHub/Gitee release source (`github-release` | `gitee-release` + `repo`). Plugin center can then dynamically check for new versions via `git ls-remote` (with GitHub/Gitee Releases API fallback) and semver comparison.

## [3.4.2] - 2026-07-26

### Fixes
- **Token & Facade Export Sync**: Add missing DI token declarations and type exports to `openlearn.d.ts` (points ledger, activity registry, lesson/classroom/presence/teaching/analytics engine facades) so plugin TypeScript code resolves them correctly. Switch unified foundation facade classes to `export type` so the runtime surface matches the declaration file.

## [3.4.1] - 2026-07-24

### Fixes
- **Build Externalization**: Switch `build.mjs` from `external:['zod']` to `packages:'external'` so the ESM dist no longer bundles `express`/`better-sqlite3`/`body-parser`, fixing `Dynamic require of "path" is not supported` on import.

## [3.4.0] - 2026-07-24

### Features
- **Unified Plugin Facades**: Export `PluginDistributionManager` facade (value + `IPluginDistributionManager` type) and `CapabilityRegistry` type so plugins can consume unified plugin services via DI.

## [3.3.1] - 2026-07-22

### Features
- Simplify `PluginTabPanel` by removing the tab bar; export `DOMExtensionWrapper`.

## [3.3.0] - 2026-07-21

### Features
- Cross-plugin type-safe service DI with help page plugin docs slot.

## [3.2.1] - 2026-07-20

### Features
- Initial published release. CLI scaffolding tool with `init` / `build` commands. Core TypeScript types, DI tokens, and plugin manifest interface.

[3.4.3]: https://github.com/aymwoo/OpenLearn-Next-V2/compare/v3.4.2...v3.4.3
[3.4.2]: https://github.com/aymwoo/OpenLearn-Next-V2/compare/v3.4.0...v3.4.2
[3.4.1]: https://github.com/aymwoo/OpenLearn-Next-V2/compare/v3.4.0...v3.4.1
[3.4.0]: https://github.com/aymwoo/OpenLearn-Next-V2/compare/v3.3.1...v3.4.0
[3.3.1]: https://github.com/aymwoo/OpenLearn-Next-V2/compare/v3.3.0...v3.3.1
[3.3.0]: https://github.com/aymwoo/OpenLearn-Next-V2/compare/v3.2.1...v3.3.0
[3.2.1]: https://github.com/aymwoo/OpenLearn-Next-V2/compare/v2.0...v3.2.1
