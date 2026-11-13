# fix-dependabot-alerts

Type: bug
Priority: P2 (normal)

## Problem
GitHub reports 13 open Dependabot alerts on techmanasi/ai-sdlc-helper (1 critical, 1 high, 10 medium, 1 low). All are in development dependencies: 11 in the root `package-lock.json` and 2 in `e2e/projects/vitest-ts/package.json`. None is a runtime dependency of the published package.

| # | Severity | Package | Manifest | Scope | First patched version | Summary |
|---|---|---|---|---|---|---|
| 5 | critical | vitest | e2e/projects/vitest-ts/package.json | development | 3.2.6 | When Vitest UI server is listening, arbitrary file can be read and executed |
| 12 | high | vite | package-lock.json | development | 6.4.4 | launch-editor: `fs.existsSync()` existence check can be bypassed on Windows |
| 6 | medium | vitest | e2e/projects/vitest-ts/package.json | development | 4.1.11 | Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock |
| 7 | medium | esbuild | package-lock.json | development | 0.25.0 | esbuild enables any website to send any requests to the development server and read the response |
| 8 | medium | vite | package-lock.json | development | 6.4.2 | Vite Vulnerable to Path Traversal in Optimized Deps `.map` Handling |
| 9 | medium | vite | package-lock.json | development | 6.4.3 | vite: `server.fs.deny` bypass on Windows alternate paths |
| 10 | medium | vite | package-lock.json | development | 6.4.3 | launch-editor: NTLMv2 hash disclosure via UNC path handling on Windows |
| 11 | medium | vite | package-lock.json | development | 6.4.4 | launch-editor: escapeCmdArgs() omits % escaping on Windows |
| 13 | medium | vite | package-lock.json | development | 6.4.4 | launch-editor: Editor CLI flag misinterpretation causing arbitrary command execution for some editors |
| 14 | medium | vite | package-lock.json | development | 6.4.4 | Vite: Files outside `server.fs.allow` could be served when project paths match system paths on non-Windows machine |
| 16 | medium | @vitest/mocker | package-lock.json | development | 4.1.12 | Vitest: Code injection via unauthenticated manual mock registration |
| 18 | medium | minimatch | package-lock.json | development | 11.0.1 | minimatch has potential denial of service via globparts amplification |
| 15 | low | vite | package-lock.json | development | 6.4.4 | Vite: Cross origin script execution through Vite custom middleware |

## Goal
Every alert is closed by an upgrade, or dismissed with a written reason when the package is development-only and not reachable (for example, a dev server that is never started, or a Windows-only flaw on a project that does not run there).

## Decisions
- Prefer the smallest upgrade that reaches the first patched version; upgrade the lockfile (`npm update`, or an `overrides` entry for a transitive package) before changing a declared range.
- No major-version upgrade without saying why in the PR description.
- The e2e project at `e2e/projects/vitest-ts` is a fixture: upgrade it only if its tests still pass, and say so if its pinned version is intentional.

## Scope
- In: `package.json`, `package-lock.json`, `e2e/projects/vitest-ts/package.json` and its lockfile, and dismissals on GitHub with a written reason.
- Out: code changes beyond what an upgrade forces.

## Definition of done
- `npm audit` shows none of these advisories.
- CI is green.
- Each dismissed alert has a written reason recorded on the alert and in the PR description.
- No major-version upgrade, or each one is explained.

## Docs
-
