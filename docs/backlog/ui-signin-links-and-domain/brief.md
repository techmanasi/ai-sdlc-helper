# ui-signin-links-and-domain

Type: feature
Priority: P2 (normal)

## Problem

`ai-sdlc-helper ui` prints one sign-in link: `Open (signs this browser in): http://127.0.0.1:<port>/?t=<token>`
(`src/cli/ui.ts:49`, built at `web/server/index.ts:745`).

Browsers keep cookies per host name, not per port. Two boards open at once, for example 4481 and 4483, both on
`127.0.0.1`, share one sign-in cookie. Opening the second board's link signs the first one out, and it shows
"not signed in". To work around it today, open one of them at `localhost:<port>`, but that link is not printed, so
you have to rewrite it by hand.

There is no way to reach the board by a name of your own, for example `sdlc.test` pointed at this machine. The
server accepts only the hosts `127.0.0.1`, `localhost` and `[::1]` (`allowedHosts`, `web/server/http.ts:18`).

## Expected behaviour

1. **Both local links.** At start, `ui` prints the sign-in link for `127.0.0.1` and for `localhost`, with the same
   token. The text says the two are separate sign-ins in the browser, so a second board can use the other one.
2. **A domain of your own.** A new environment variable, `SDLC_UI_DOMAIN`, takes a host name such as `sdlc.test`
   (no scheme, no port, no path).
   - When it is set, `ui` also prints `http://<domain>:<port>/?t=<token>`.
   - The server accepts that host in its Host and Origin checks (`allowedHosts` / `guard`).
   - An invalid value stops the start with a clear message naming the variable and the value. It is never silently
     ignored.
   - When `SDLC_UI_DOMAIN` is not set, nothing changes.
3. **How to point the domain.** When `SDLC_UI_DOMAIN` is set, one more line tells the user to point that name at
   this machine and port. For example: `Point sdlc.test at this machine (e.g. "127.0.0.1 sdlc.test" in /etc/hosts),
   then open the link above; the board listens on port <port>.`
4. `--no-open` keeps opening nothing. Without it, the browser opens the domain link when `SDLC_UI_DOMAIN` is set,
   and the `127.0.0.1` link otherwise.

## Must not change

- The server still listens on `127.0.0.1` only (`web/server/index.ts:672`). A domain is reached through the hosts
  file or a local proxy. Setting `SDLC_UI_DOMAIN` never opens the port to the network.
- The token, how it is checked, and the cookie stay as they are. Each host name gets its own cookie because the
  browser scopes cookies by host.

## Tests

- Through the real CLI or server start (`test/helpers.ts`):
  - The output holds both local links with one token.
  - With `SDLC_UI_DOMAIN=sdlc.test`, it also holds the domain link and the "point your domain" line.
  - An invalid value (`http://x`, `a b`, `x:80`) stops with the message.
- `allowedHosts`/`guard`:
  - A request with `Host: sdlc.test:<port>` and a matching Origin is accepted when the variable is set.
  - The same request is refused when the variable is not set.

## Docs

- README: the `ui` section and the environment variables table (`SDLC_UI_DOMAIN`).
- CHANGELOG `[Unreleased]`.

## Notes

- This came up when two local boards (4481 and 4483) signed each other out during a run.
- A separate follow-up could name the cookie after the port, so two `127.0.0.1` boards no longer clash. It is not
  part of this item.
