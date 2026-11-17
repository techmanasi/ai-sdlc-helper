# Test repair

- **Test:** `invalid saved review loop limit > exposes the stored key so a settings save can clear it`
- **Defect:** `Response.json()` returns `unknown` under the project's TypeScript configuration, so accessing `fileReview`, `hash`, and `ok` fails typechecking. `npx tsc -p web --noEmit` reported TS18046 on the first two accesses and TS2571 on the third.
- **Change:** Typed the two parsed response bodies with the fields used by the test. The requests and every assertion remain unchanged. This repairs the test's build isolation while retaining the real server exercise required by specs-1.md acceptance criterion 9.
