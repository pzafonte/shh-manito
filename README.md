# 쉿! 마니또 (Shh Manito)

A small web app for playing 마니또, the Korean secret-friend game. Friends each draw a name
in secret, look after that person for a week with fixed cute cards, and reveal on the last
day. The design goal is that nobody learns who drew whom before then, including the person
running the server.

The app never touches money. A card can carry a promise of a few sats, and people pay what
they promised from their own wallets after reveal day.

**Status:** nothing here has had an independent review. See [What is unverified](#what-is-unverified).

## Running it

This machine has no system Node, so put the toolchain on your path first:

```sh
export PATH="/Users/pzafonte/boss_challenge/seoul-sats/.toolchain/node/bin:$PATH"
pnpm install
```

Build and run it as it would be deployed, at <http://127.0.0.1:3100>:

```sh
pnpm build
pnpm start
```

Or run it for development, with the app at <http://127.0.0.1:3000>:

```sh
pnpm dev
```

WebCrypto needs a secure context, so a real deployment needs HTTPS. `localhost` and
`127.0.0.1` work without it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3100` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `DATABASE_PATH` | `data/shh-manito.sqlite` | Where the log lives |
| `HTTPS` | unset | Set to `true` behind TLS, to send HSTS and upgrade requests |
| `TRUST_PROXY_HOPS` | `0` | Proxies to trust for the client address used in rate limiting |

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test       # protocol, server and copy
pnpm test:e2e   # four phones in Chromium at phone size
```

To capture the screenshots used for the walkthrough review:

```sh
WALKTHROUGH_DIR=/some/path pnpm exec playwright test tests/e2e/walkthrough.spec.ts
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | Crypto, event formats, the state fold, the automatic draw and the player client. WebCrypto only, so it runs in browsers and Node. Most of the risk lives here |
| `apps/server` | Fastify and SQLite. An append-only log it cannot read |
| `apps/web` | React. All words are in `src/copy.ts` |
| `tests/e2e` | Playwright |
| `docs/protocol.md` | The specification, and every attack tried against it |
| `docs/threat-model.md` | What is and is not protected |

## Things worth knowing

- **Reading parcels must stay silent.** Nothing a phone privately learns may change what it
  does on the network. If it did, a server could find any giver by holding back one slip and
  watching who reacts. This is invariant I2 in `docs/protocol.md`, and it is the easiest
  thing to break by accident.
- **Technical words stay on one screen.** Main screens use only game words. Tests enforce this
  in both languages.
- **The Korean needs native review.** It was written to read naturally, but no native speaker
  has checked it.
- **Fonts are subsets.** `apps/web/scripts/fetch-fonts.ts` downloads only the glyphs fixed text
  uses. Rerun it when headings change. Nothing is fetched at runtime, and any other glyph falls
  back to the system font.
- **KakaoTalk.** Whether its in-app browser keeps the URL fragment is undocumented, and so is
  whether `kakaotalk://web/openExternal` works everywhere. The app relies on neither. It detects
  the in-app browser, offers the escape as a convenience, shows the manual steps, and always lets
  people paste a link.

## What is unverified

- Real phones. Tests run in desktop Chromium with phone emulation, never Safari or WebKit.
- KakaoTalk's in-app browser, including storage and the URL fragment.
- Real Lightning wallets.
- The Korean, which has had no native review.
- Real people playing without help.
- The cryptography, which has had no independent review.
