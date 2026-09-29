# Working on websh

For anyone changing this code - a person or a coding agent. Short on
purpose: it says where things are and what not to break; the details
live in `docs/`.

## What it is

A browser SSH terminal. `server.py` (Python, stdlib only) runs each SSH
connection as a PTY child and serves the API and the frontend;
`websh.js` + `index.html` (plain JS, xterm.js from a CDN) are the client;
`api.php` is an optional proxy for shared hosting. Output goes to the
browser over SSE with a long-poll fallback, keys come back as POSTs.
Persistent panes wrap the shell in tmux on the target.

## Hard constraints

- **No build step, no dependencies.** The backend runs on the standard
  library (`cryptography` is optional, for the vault). The frontend is
  one script file. Deployment is "copy four files".
- **`server.py` and `websh.js` stay single files.** They are large; use
  the code map (below) instead of splitting them.
- **Python 3.9** must work: no `match`, no `X | Y` annotations, no
  3.10+ stdlib. CI runs 3.9 and 3.12, each with and without
  `cryptography`.
- **The wire protocol is versioned** (`proto` in `/api/ping`,
  `/api/config`; `docs/protocol.md`). Old cached clients keep talking to
  a new server for hours: additions must be ignorable, removals need a
  version bump.

## Finding your way

    scripts/codemap.py            sections of server.py and websh.js, with line numbers
    scripts/codemap.py server     every class, function and method
    scripts/codemap.py client     every top-level function
    scripts/codemap.py tests      every test class and scenario
    scripts/codemap.py kick       anything whose name contains "kick" - code and tests

Read the map, then the part you need. Both files carry long comments
explaining *why* at the point of the code; trust them over guesses, and
keep them true when you change the code under them.

| Topic | Read |
|---|---|
| What must never break, and what guards it | `docs/invariants.md` |
| Output transport, reconnects, stalls, input | `docs/sse-transport.md` |
| HTTP API | `docs/protocol.md` |
| tmux sessions, re-attach, held keys | `docs/persistent-sessions.md` |
| Threat model, deny-list, rate limits, logs | `docs/security.md` |
| Auth-failure detection | `docs/auth-fail-detection.md` |
| Vault | `docs/encryption.md` |
| Env vars and `websh.json` | `docs/configuration.md`, `docs/server-side-connections.md` |
| Installing, systemd, nginx, Docker | `docs/deployment.md` |

## Commands

    python3 server.py                       run locally (PORT=8765 HOST=127.0.0.1 by env, not flags)
    scripts/check.sh                        everything that must be green; exit status is the verdict
    scripts/check.sh --quick                while iterating
    scripts/check.sh --full                 + the CI matrix in docker (3.9, no cryptography)
    python3 -m unittest tests.backend.test_transport.TestStreamEdges     one backend class
    (cd tests/frontend && node test_connect.js | grep -A8 "=== name")    one frontend test's output
    scripts/e2e.sh                          browser scenarios, private instance (tests/e2e/README.md)
    scripts/e2e.sh --repeat 10 away         hunt a race
    scripts/e2e.sh --url https://host/      the scenarios that are safe against a deployment

## How a change is done

1. **Reproduce first.** A failing test, or a failing browser scenario
   for anything that depends on timing or the network. If it cannot be
   reproduced, say so; do not fix a guess.
2. Fix the cause. One logical change per commit.
3. **Prove the test guards the fix**: put the old code back
   (`git stash -- file`), watch the test go red, restore.
4. `scripts/check.sh` - green means `failed: 0` on every run. For
   transport, input, reconnect or session-lifecycle changes also
   `scripts/e2e.sh`.
5. Update the docs the change makes untrue, and `docs/invariants.md`
   when a new "must never happen again" appears.
6. Commit. Deploying is a separate, deliberate step
   (`scripts/deploy.sh`, which deploys `origin/main`, not your tree).

## Rules learned the hard way

- **A green unit suite is not proof for timing.** Four ways of losing
  typed keys passed every unit test and failed one browser run in three.
  Races are proven gone by repetition in a real browser.
- **Report what you measured, not what you expect.** "Deployed" means
  the served file matches the commit; "fixed" means the reproduction
  now passes. If something was not checked, say that.
- **Never restart, kill or reconfigure what you did not start.** Tests
  use a private server instance and a private tmux socket
  (`tmux -L <unique>`). No `tmux kill-server`, no `pkill -f` by pattern
  (it matches your own shell), no restarting a deployment to test.
  Clean up what you started: processes, tmux sessions, firewall rules.
- **Read logs as they are written.** nginx logs a request when it ends,
  so a long stream shows up late; column 10 is the size, not the status.
- **Do not widen a fix into a rewrite.** The comments record why the
  code is the way it is; most "simplifications" reintroduce a bug that
  has a test and an entry in `docs/invariants.md`.
- **Secrets never enter the repository, a commit message or a log.**
  The repository is public. Test credentials come from the environment
  (`tests/e2e/local.env.sh`, not in git).

## Commits

    fix(scope): what the user now sees, as a sentence

    What was wrong and how it showed. What caused it. What the change
    does. How it was verified.

Scopes in use: `input`, `transport`, `stream`, `server`, `auth`, `tmux`,
`vault`, `config`, `upload`, `download`, `file browser`, `docs`,
`test(frontend)`, `test(backend)`. The subject describes behaviour, not
code ("typed text reaches the shell in the order it was typed"). No
co-author or "generated with" trailers.
