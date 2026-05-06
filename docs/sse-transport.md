# SSE transport, fallback, and local echo — design notes

How terminal output gets from the server to the browser, why it's
shaped that way, and the parts that aren't obvious from reading the
code.

## What we do today

Output from the SSH PTY reaches the browser through two transports
that share one wire format. Input always goes up as short POSTs to
`/api/input`.

### Primary: Server-Sent Events (`GET /api/stream`)

`server.py:_stream` opens a long-lived response with
`Content-Type: text/event-stream`. Each chunk of PTY output is wrapped
in a named SSE event:

```
event: data
data: {"data": "<base64>", "alive": true, "auth_failed": false}

```

— same JSON shape as a single `/api/output` long-poll response. When
the session ends we send one final `event: end` carrying `alive:false`
and the auth flag, then close. Comment heartbeats (`: keepalive\n\n`)
go out every 15 s if no real data has flowed, so middleboxes don't
idle the connection.

The very first byte we send is a comment line (`: ok\n\n`). That's
deliberate: it lets the frontend distinguish "channel is open and
flushing" from "buffering proxy is holding the entire response".

### Fallback: long-poll (`GET /api/output`)

The pre-existing 10-second long-poll. Same JSON payload; no
multi-message framing. The frontend uses this when SSE doesn't reach
it, and never re-tries SSE for that pane (no flapping).

### How the frontend chooses

`websh.js:startOutput` does the dispatch:

1. If `EventSource` isn't a thing (very old browser), go straight to
   long-poll.
2. Open `EventSource('/api/stream?...')`. Start a 5-second timer.
3. As soon as we see *anything* (an event, an error, `open`), we know
   the channel is reactive. Cancel the timer.
4. If the timer fires with no events, an upstream is buffering us.
   Close the EventSource, set `p.sseDisabled = true`, fall back.
5. If `onerror` fires *before* any event, treat as "this transport
   doesn't work here" and fall back. Once SSE has worked at least
   once, transient errors are left to EventSource's own auto-retry
   plus our wall-clock budget (below).

### Wall-clock reconnect budget

Both transports share `nextRetryDelay(p)`. The first time a request
fails, we stamp `p.firstFailureAt = Date.now()`. While
`Date.now() - p.firstFailureAt < RECONNECT_BUDGET_MS` (60 s), retries
are silent on backoff `[1, 2, 5, 10, 15]` seconds. After 60 s of
unbroken failure we surface the red "connection lost" banner and stop.

This replaces the old "5 retries cap" — a 30-second Wi-Fi blip on a
phone now lands in the silent-retry window instead of producing a
banner the user has to dismiss.

### Local echo prediction (Mosh-style lite)

`websh.js:predictKey` is wired into `term.onData`. For a single
printable ASCII character typed in the **normal** xterm buffer (not
alt-screen), we:

1. Append the char to `p.echoQueue`.
2. Render it immediately at the cursor with dim SGR
   (`\x1b[2m` … `\x1b[22m`).
3. Schedule a 1-second TTL timer that wipes any unconfirmed
   predictions.

When server output lands, `consumeEcho(p, chunk)` reconciles. Three
cases:

- **No common prefix.** Server didn't echo what we predicted (vim,
  autocomplete, command running). Backspace over the dim chars,
  overwrite with spaces, then write the server bytes on a clean slate.
- **Full prediction confirmed.** Backspace over the dim chars, write
  the same chars at normal intensity, then the rest of the chunk. The
  user sees the dim chars promote to solid the moment the server
  catches up.
- **Partial match.** Confirm the matched prefix at normal intensity,
  erase the unconfirmed tail, then continue with the remaining server
  bytes.

Predictions are wiped on:

- Resize (cursor coordinates may shift).
- Any non-printable / control / multi-byte input (Enter, Backspace,
  arrows, paste, IME composition).
- Pane close.
- The 1-second TTL.

## Lost-byte handling on disconnect

`SSHSession.read()` is destructive: it returns the contents of
`output_buf` and clears it under `buf_lock`. That means once a reader
has drained the buffer, the bytes only exist in that reader's local
variable. If the reader can't deliver them — the client closed the
socket, the PHP proxy aborted, the network blipped — those bytes are
gone unless we put them back.

Two protections, either of which is sufficient on its own:

1. **Peek for FIN before `read()`.** `Handler._client_gone()` does a
   non-blocking `recv(1, MSG_PEEK)` on the request socket each loop
   iteration. If the peer has half-closed (`recv == b""`), we bail
   *without* draining the buffer. The next reader (long-poll fallback
   or a fresh `/api/stream`) sees the unchanged buffer and delivers
   normally. Linux/macOS uses `MSG_DONTWAIT`; platforms without it
   fall back to `setblocking(False)` around the peek.

2. **`Session.unread()` after a write failure.** If `read()` already
   drained the buffer and the subsequent `wfile.write` / `wfile.flush`
   raises `BrokenPipeError`, we push the bytes back to the front of
   `output_buf`. Order is preserved (the unread bytes are older than
   anything `_reader_loop` has appended in the meantime). The next
   reader picks them up.

Trade-off: when the unread bytes plus fresh PTY output exceed
`OUTPUT_BUF_MAX`, the truncation rule (keep the last
`OUTPUT_BUF_KEEP` bytes) drops the oldest data — possibly the
unread part. We chose this over the alternative ("keep the unread,
drop the new") because the user-visible value of the buffer is
the *current* terminal state, not historical context. Buffer
overflow at the moment of disconnect is rare in practice.

There is still a thin race window: peek says "alive" → `read()`
takes the bytes → client sends FIN → `wfile.write` succeeds into
the TCP send buffer (kernel doesn't reject it) → bytes never
reach the application on the other side because the socket is
closed. Fully closing this window requires an application-level
ACK from the client, which is overkill — the practical result is
~1 µs of exposure on each pass through the loop.

## Disconnect idempotency

SSE delivers the session-end signal as up to three frames:
`{data, alive:false}` (last shell output), `{data:"tail", alive:false}`
(any bytes added between the previous read and the close), and
`event:end{alive:false}`. The browser's `EventSource` may dispatch
all three before our `close()` takes effect — the spec lets the
implementation queue events that arrive over the wire ahead of
close. Each frame would otherwise re-run the disconnect path:
banner, `showReconnectBar`, `saveSessions`, all duplicated.

`handleOutputPayload` enforces idempotency by structure:

```js
if (r.error) { if (!p.sid) return true; ...handle... }
p.connecting = false;
if (r.data) { ...always render... }
if (!p.sid) return true;       // guard for terminal-state branches
if (r.auth_failed) { ...handle..., p.sid = null }
if (r.alive === false) { ...handle..., p.sid = null }
```

The guard sits **after** the `r.data` handler, not before — a
tail-drain frame still has bytes that need to land in the terminal,
even if we already wrote the closed-banner. The terminal-state
branches all null `p.sid` on the first call, so subsequent frames
hit the guard and exit cleanly.

Predictions (`echoQueue`/`echoTimer`) are wiped on every disconnect
path *before* the banner is written, so a pending TTL timer can't
fire `\b`/space/`\b` on top of the freshly-rendered banner. Resize
also wipes them silently — `\b`/space/`\b` after `xterm.js` reflow
isn't actually silent (column-only backspace doesn't cross line
wraps) and would clobber legitimate content on narrowing.

## Known limitations

- **Local echo can desync after exotic escape sequences** that move
  the cursor in ways we don't track. The TTL and "any control char
  wipes" rules cover this in practice — desync clears in ≤1 s and
  doesn't propagate.
- **Long-poll fallback is per-pane, sticky for the session.** Once a
  pane decides SSE doesn't work, it doesn't try again. A user who
  changes networks (e.g. moves off a buffering corp proxy onto LTE)
  has to reload the tab to get SSE back. Acceptable; the alternative
  is flapping detection that can't really tell signal from noise.
- **`api.php` SSE passthrough is best-effort.** Some shared hosts
  force `output_buffering` on at the SAPI level so PHP can't flush.
  In that case the frontend's first-message timer fires, fallback
  kicks in, and the user gets long-poll. They never see this happen.
  The tradeoff is "every host works, some hosts get the lower-latency
  path" rather than "only some hosts work".

## Why these choices

### Why not WebSocket

WebSocket would also give low latency. It loses on:

- Many shared-hosting PHP environments don't support WebSocket — the
  whole reason `api.php` exists is to fit those hosts.
- WebSocket needs a protocol upgrade. Some corporate proxies allow
  HTTPS but block the upgrade; SSE is plain HTTP all the way.
- Adding it means two transports anyway (with the long-poll fallback
  for hosts that don't speak it), and we'd still need the fallback
  detection logic.

SSE wins on "same latency, simpler shape, plain HTTP".

### Why local echo on by default, no opt-out toggle

A toggle implies a meaningful tradeoff. The actual impact on the user:

- On a 0-ms loopback, the dim glyph is overwritten faster than the eye
  can perceive — invisible.
- On any real link, it's a perceptible reduction in input latency.
- On a desynced session (rare, ≤1 s window), the user sees a
  brief duplicate or stale character that self-corrects.

There's no scenario where someone wants to permanently disable it,
so a toggle would be UI noise. If it ever does need to be killed,
`p.echoEnabled = false` in DevTools is the escape hatch.

### Why a 60-second budget instead of N retries

A retry count is a proxy for "how long should I wait before
panicking". With variable backoff, the same retry count can mean
anything from 5 s to 5 minutes of elapsed time. A wall-clock budget
maps directly to "how long do I expect this network blip to last",
which is the actual question.

## What this means for the PR

Net new code paths:

- `server.py:_stream` (~80 lines)
- `websh.js`: `startOutput`, `streamOutput`, `handleOutputPayload`,
  `consumeEcho`, `predictKey`, `nextRetryDelay`, etc.
- `api.php`: `proxy_stream` (CURLOPT_WRITEFUNCTION-based passthrough)

Net unchanged surface:

- Existing `/api/output` continues to behave exactly as before.
- `/api/input`, `/api/connect`, `/api/disconnect`, `/api/resize`,
  `/api/upload*`, `/api/tmux_*`, `/api/ls`, `/api/download`, `/api/ping`,
  `/api/config` — untouched.
- All existing tests still pass. New tests cover `/api/stream`
  validation paths, the peek-FIN semantics
  (`test_client_gone_detects_fin` /
  `_false_with_pending_data`), the unread push-back contract
  (`test_session_unread_prepends`), an integration check that
  bytes survive a mid-stream client close
  (`test_stream_returns_undelivered_bytes_to_buffer`), and a
  frontend regression that drives `handleOutputPayload` directly
  with a three-frame disconnect sequence to confirm both
  tail-byte rendering and single banner emission.

Sessions that the SSE branch interacts with go through the same
`SSHSession.read()` as long-poll does — there's no separate buffer,
no separate reaping path. From the session's point of view, SSE is
"a slightly hungrier reader".
