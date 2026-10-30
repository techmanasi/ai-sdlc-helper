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
