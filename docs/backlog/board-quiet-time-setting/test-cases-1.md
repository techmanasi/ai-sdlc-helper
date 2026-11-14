# Board quiet time test matrix

| Area | Scenario | Expected | Coverage |
| --- | --- | --- | --- |
| Personal registry | Save 1 and 5 seconds; clear with null | Values persist, unrelated overrides survive, null removes the key | `test/edit-settings.test.ts` |
| Validation | Zero, negative, fraction, string, object, NaN and infinities | Rejected with the specified error; stored value remains intact | `test/edit-settings.test.ts` |
| Settings API | Missing, valid, rounded, too-small and non-finite environment values | Returns seconds rounded to integer or null | `web/test/server.test.ts` |
| Overrides API | Save, reject invalid values, clear | 200 and persisted value; 400 and unchanged value; key removed | `web/test/server.test.ts` |
| Active feed | Saved interval, then update while SSE is open | Audits recur at saved interval and use the new interval after rearming | `web/test/board-feed.test.ts` |
| Precedence | Environment interval versus saved interval | Environment value wins | `web/test/board-feed.test.ts` |
| Precedence | Programmatic option versus environment and saved values; default versus saved value | Option wins, saved value wins over default | Review and targeted runtime verification required |
| Config modal | Registered/unregistered, default, saved and environment-locked states | Correct label, attributes, visibility, value and explanation | UI review required |
| Config modal | Invalid, valid and cleared input, including env-locked save | Error before requests; persist or remove value; do not overwrite locked value | UI review required |
| Documentation | Config setting, storage, minimum, default, timing and environment precedence | `docs/web-ui.md` describes the behavior accurately | Review item |
| Test quality | Tests exercise real code and do not inspect test or documentation text | Confirm by reviewing changes | Review item |
