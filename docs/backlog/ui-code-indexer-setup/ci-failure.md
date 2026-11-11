# CI failure of the pull request

Pull request: https://github.com/techmanasi/ai-sdlc-helper/pull/91
Failing checks: check (18), check (20), check (22), check (24)

### Run 42703667219

```
[Run npm run lint]
70:81  error  Unnecessary escape character: \/  no-useless-escape
1:32  error  'vi' is defined but never used  @typescript-eslint/no-unused-vars
1:32  error  'vi' is defined but never used                                                                                                                             @typescript-eslint/no-unused-vars
6:1   error  '../../src/registry/projects.js' import is restricted from being used by a pattern. Import the engine from 'ai-sdlc-helper' (src/index.ts), not its files  no-restricted-imports
✖ 4 problems (4 errors, 0 warnings)
Process completed with exit code 1.
```
