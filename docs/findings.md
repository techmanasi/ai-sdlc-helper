# Findings from real use

What trying the tool on real projects turned up, and what to do about it. Newest first. Each entry says what happened,
why, the way around it today, and the suggested change (with its status).

## 2026-10-19: web app on property-listing-al-badri (a repository with one Node package below the root)

### 7. `--test-dir` refuses the package folder itself
- **Seen:** `suggest --test-dir ./management-portal/mobile-app` → "no package.json in management-portal or above it; the
  test folder must be inside a Node package (packages here: management-portal/mobile-app)", although that folder is the
  package. `suggest management-portal/mobile-app` (the folder as the argument) works.
- **Why:** `--test-dir` names the folder the tests go in, inside a package; `locateTestDir` looks for `package.json`
  from that folder's parent upwards, so the package folder itself is never checked. The hint "pass --test-dir <folder
  inside one of them>" in finding 2's message invites exactly this mistake.
- **Today:** give the package folder as the argument (`suggest management-portal/mobile-app`), and `--test-dir` only
  for a tests folder inside it (`--test-dir management-portal/mobile-app/__tests__`).
- **Suggested:** accept the package folder as `--test-dir` (use the package's default tests folder), and make the
  "Packages below" hint name the argument form first: "run: suggest management-portal/mobile-app". Status: open.

### 8. `suggest` recommends Vitest with jsdom for what may be a React Native app
- **Seen:** for `management-portal/mobile-app` (TypeScript, "uses react"): "1. vitest (recommended) … component tests
  with jsdom and Testing Library (react)", the only suggestion.
- **Why:** `suggest` knows web frameworks (react, vue, svelte …) but not React Native or Expo: it does not look at the
  `react-native` or `expo` dependencies. React Native components do not render in jsdom; the usual setup is Jest with
  the `jest-expo` or `react-native` preset and `@testing-library/react-native`.
- **Today:** check `grep -E '"(react-native|expo)"' management-portal/mobile-app/package.json`. A web React app: the
  Vitest suggestion is right (`init-tests management-portal/mobile-app --runner vitest --yes --dry-run`, then without
  `--dry-run`). A React Native or Expo app: do not apply it; set up Jest with `jest-expo` (or the `react-native`
  preset) in the app and add the suite to `sdlc.config.json` by hand (finding 3).
- **Suggested:** detect React Native and Expo in `describeProject`; suggest Jest with the right preset and
  `@testing-library/react-native`, and list Vitest under "Not suggested" with the reason. Status: open.

### 1. The doctor checks on a project card go stale after Register
- **Seen:** after **Register** wrote `Docs/backlog/index.md`, the card still said "backlog index · Docs/backlog/index.md
  is missing"; the Register output on the same screen said it had written it.
- **Why:** the Projects screen runs `doctor` once when the card appears and not again after an action changes the
  project.
- **Today:** press **Run doctor again** on the card.
- **Suggested:** re-run the checks after Register (and after any palette command run for that project). Status: open for the card. Done on the server (#120): a request that changes a project drops its cached context, so the next read is fresh; the card still has to ask again.

### 2. "No test suite found" for a repository whose Node package is not at the root
- **Seen:** doctor: "settings · no test suite found"; `suggest` in the palette: "no package.json here; only
  Node/TypeScript projects are supported for now. Packages below: management-portal/mobile-app".
- **Why:** the root has no `package.json`; the one Node package is two levels down and has no test runner the detection
  knows. `suggest` and `init-tests` work on the folder they are given, the root by default.
- **Today:** in the palette, `suggest management-portal/mobile-app`, then
  `init-tests management-portal/mobile-app --runner <name> --yes --dry-run`, then the same without `--dry-run`; then
  **Run doctor again**, and commit the setup and `Docs/backlog/index.md` (runs start from the committed base).
- **Suggested:** a **Fix** button on the failing check. **Set up tests** lists the packages found below the root, lets
  you pick one, shows the `suggest` result and applies `init-tests` after a preview. Status: open.

### 3. Expo / React Native projects that run Jest through `jest-expo` are not detected
- **Seen:** not confirmed on this project yet; it is a likely cause of finding 2 for a folder named `mobile-app`.
- **Why:** detection does not read the `jest-expo` preset (already listed under "To build in" in PLAN.md).
- **Today:** check `grep -E '"jest"|jest-expo' management-portal/mobile-app/package.json`. If it finds Jest, do not run
  `init-tests` (it would add a second framework); write `sdlc.config.json` at the root with a suite
  (`"dir": "management-portal/mobile-app"`, `"runner": "jest"`, the test command and globs), commit it, and re-run doctor.
- **Suggested:** detect `jest-expo` as Jest. Status: open.

### 4. Only the Node package is covered in a mixed repository
- **Seen:** the rest of `management-portal` has no `package.json`.
- **Why:** the first release supports Node/TypeScript runners plus `generic-junit`.
- **Today:** items that change only the mobile app run well; a backend whose runner can write JUnit XML can be added as a
  second suite with `"runner": "generic-junit"`.
- **Suggested:** name the uncovered folders in doctor ("these folders have code but no suite"), so it is clear which
  items the pipeline can test. Status: open.

### 5. Settings cannot be fixed from the page
- **Seen:** writing a `suites` entry by hand was the only way around findings 2 and 3; the Settings screen is read-only.
- **Suggested:** phase 2's settings editor, starting with the `suites` block (add or edit a suite, validated before it is
  saved), since that is what a new project most often needs. Status: planned (phase 2, docs/web-ui.md).

### 6. The opening URL must be the one `ui` printed
- **Seen:** `127.0.0.1:4477` on its own answers "not signed in".
- **Why:** the token in the printed URL signs the browser in (then a cookie does), so other local pages cannot use the
  server.
- **Suggested:** the "not signed in" page should say where the URL is printed and offer to copy the command
  `ai-sdlc-helper ui --no-open` to get a new one. Status: open.
