# non-node-ecosystem-support

Type: feature
Priority: P3 (low)
Source: User request: "Non-Node / Non-TypeScript Ecosystems - Lets not worry about it right now, as long as we can add support for more languages and test framework later, we are good. Keep this item in back log"

## Problem
Currently, `ai-sdlc-helper` only supports Node.js and TypeScript ecosystems (runners: `vitest`, `jest`, `node-test`, `mocha`). When invoked on projects using other languages (Python, Go, Rust, Ruby, Java), `ai-sdlc-helper suggest` and `doctor` flag the project as unsupported because of missing `package.json`. Furthermore, the testcheck subsystem and runners assume Node test formats and JUnit/TAP reporters.

## Expected behaviour
1. **Multi-Language Detection**:
   - `src/config/detect.ts` and `src/config/suggest.ts` detect non-Node project manifests:
     - Python: `pyproject.toml`, `requirements.txt`, `setup.py` (suggesting `pytest`)
     - Go: `go.mod` (suggesting `go test`)
     - Rust: `Cargo.toml` (suggesting `cargo test`)
2. **Runner Adapters**:
   - Introduce runner implementations under `src/runners/` capable of:
     - Running full test suites
     - Running isolated individual test cases (for red-test and retry phases)
     - Parsing test failure output and counts (passed, failed, skipped)
3. **Testcheck Integration**:
   - Update `src/testcheck/` to extract test names and keys across language syntax (e.g., Python `def test_*`, Go `Test*`, Rust `#[test]`).
4. **Provisioning (`init-tests`)**:
   - Support `ai-sdlc-helper init-tests` in non-Node projects (e.g. generating `pytest.ini` with sample test, creating `tests/test_example.py`).

## Scope
- In: `src/config/detect.ts`, `src/config/suggest.ts`, `src/runners/`, `src/testcheck/`.
- Out of scope: Language Server Protocol (LSP) setups, custom compilers, or exotic build tools.

## Tests
- Unit tests for detection and suggest on Python, Go, and Rust fixture projects.
- Runner tests validating execution and red-test check behavior.

## Docs
- Document supported languages and test runners in `docs/` and README.

## Note: running only the named tests

From the `board-quiet-time-setting` run (2026-11-15). The red gate runs every test file the Red tests stage touched,
so old, already-green tests in those files run too. In that run 3 files held 64 tests and only 5 were new. The 3 files
took 145 s. Running only the 5 new tests took 14 s (`vitest -t`). Each runner adapter should be able to run a given list
of tests by name, and the red gate should use it.

Checked in each runner's docs:

| Runner | Run only these tests | List test names without running them |
|---|---|---|
| Vitest | `-t <regex>` (`--testNamePattern`), matched on the full name. Before Vitest 5 the describe and test names are joined with a space, from 5 with `' > '` | `vitest list --json` (Vitest 2+) |
| Jest | `-t <regex>` (`--testNamePattern`) | None for names (`--listTests` lists files only) |
| Mocha | `--grep <regex>` or `--fgrep <text>` (not both) | `--dry-run` with the JSON reporter |
| node:test | `--test-name-pattern <regex>`, can be repeated. A subtest runs only if its parent also matches | None |
| pytest | Node IDs: `path/test_x.py::Class::test_name[param]`, exact, no regex. `-k` is a looser substring expression | `--collect-only -q` |
| go test | `-run '^TestA$\|^TestB$'`; subtests as `TestA/sub` | `-list <regex>` |
| cargo test | `cargo test <name> -- --exact` (one name through cargo; check whether libtest takes more after `--`) | `cargo test -- --list` |
| generic-junit | None: it runs the project's own `testCmd` | None |

So every named runner can run single tests, except `generic-junit`. Points for the adapters:

- **Finding the new tests.** Prefer the listing command at the base commit and at the red-tests commit; the names only
  in the second are the new tests. Where there is no listing (Jest, node:test), use the names from the red gate's own
  report: the gate already has a result per test. `logs/baseline.json` does not hold test names today.
- **Exact matching.** Regex filters must be escaped and anchored, or `adds` also runs `adds twice`. pytest node IDs and
  `cargo --exact` are exact already. Parametrised and nested tests need the full ID (pytest `[param]`, Go `Parent/sub`,
  node:test parent names).
- **Fallback when there is no filter** (`generic-junit`, or a name that cannot be expressed): let the config give an
  optional filter template for `testCmd`, for example `{names}` or `{files}`. Without one, run the files as today and
  judge only the new tests in the report. That is correct, just not faster.
- **Red gate behaviour to fix at the same time:** do not retry failures in the red gate (failing is the expected
  result there); reuse the gate's result for `red.json` instead of a third run; and flag a new test that already
  passes before Implement, since it proves nothing for the task (one did in this run).
