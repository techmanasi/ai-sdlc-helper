# CI failure of the pull request

Pull request: https://github.com/techmanasi/ai-sdlc-helper/pull/85
Failing checks: check (18), e2e (20), check (20), e2e (22), check (22), check (24)

### Run 42910815135

```
[Run npm ci]
src/pipeline/gates.ts(162,53): error TS2345: Argument of type '{ file: string | null; name: string; }[]' is not assignable to parameter of type 'FailedTest[]'.
npm error code 2
npm error path /home/runner/work/ai-sdlc-helper/ai-sdlc-helper
npm error command failed
npm error command sh -c npm run build
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-10T22_02_53_909Z-debug-0.log
Process completed with exit code 2.
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-10T22_02_49_937Z-debug-0.log
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-10T22_02_54_945Z-debug-0.log
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-10T22_02_50_117Z-debug-0.log
```

### Run 42910815111

```
[Run npm ci]
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-10T22_02_55_362Z-debug-0.log
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-10T22_02_49_127Z-debug-0.log
```
