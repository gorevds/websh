# Desktop notifications

websh can flash the page title, change the favicon to a red dot, and
fire a system desktop notification when a long-running command
finishes — so you can switch to another tab/app and come back when
the work is done.

The mechanism is intentionally simple and shell-driven: the terminal
emits a BEL byte (`\x07`) at every shell prompt, and websh treats
that BEL as "command finished" *if* the pane has bell-notify enabled
*and* you are not currently looking at the tab.

## Setup

1. **In websh**, click the bell button (🔔) on the pane's toolbar.
   The browser will ask for notification permission — grant it. The
   bell button highlights to show notifications are armed.
2. **On the remote shell**, configure your prompt to emit a BEL after
   each command:

   ```bash
   # bash — append to ~/.bashrc
   PROMPT_COMMAND='printf "\a"; '"$PROMPT_COMMAND"
   ```

   ```bash
   # zsh — append to ~/.zshrc
   precmd() { printf '\a' }
   ```

   ```bash
   # fish — append to ~/.config/fish/config.fish
   function fish_prompt
     printf '\a'  # add at the top of your existing fish_prompt
     # ...your normal prompt...
   end
   ```

3. Start a long command. Switch to another tab.  When the command
   finishes and the next prompt prints, the tab title flips to
   `● done — websh`, the favicon turns red, and (with permission)
   you get a system notification.

All three signals auto-reset when the tab regains focus.

## How it works

xterm.js fires an `onBell` event whenever the terminal receives a
BEL byte. websh's per-pane handler checks two conditions:

- The pane has bell-notify enabled (`notifyOnBell` flag, toggled by
  the toolbar button).
- The page is not visible *and not focused* (`document.hidden` or
  `!document.hasFocus()`). Beeping the window the user is staring at
  is rude — so the alert silently no-ops when you're already looking.

When both hold, three things happen:

- `document.title` is rewritten to `● <pane-label> done — websh` —
  this shows up in the browser's taskbar / tab strip even from
  another window.
- The favicon `<link>` is swapped for a red-dot SVG data URI.
- A `Notification` is constructed via the standard Web Notifications
  API. The `tag` field is set to `websh-<pane-id>` so successive
  fires from the same pane collapse into one.

A `visibilitychange` and a `focus` listener detect your return and
reset all three.

## When the tab is closed

websh's built-in notifications fire **only while the websh tab is
open**. For push notifications when the browser is closed, or when
you've disconnected from a persistent (tmux) session and walked
away — drive the notification from the **target** host instead of
from websh.

[ntfy.sh](https://ntfy.sh) is a lightweight HTTP-push service with
free Android and iOS apps. To use:

1. Pick a random hard-to-guess topic name (`my-build-2YxR9q…`).
   Anyone who knows the topic name can read it, so don't make it
   guessable.
2. Subscribe to the topic in the ntfy mobile app on your phone.
3. On the **target** host, add a helper to `~/.bashrc`:

   ```bash
   notify_done() {
     curl -s -d "${*:-finished}" "https://ntfy.sh/my-build-2YxR9q…" \
       > /dev/null 2>&1 || true
   }
   ```

4. Append `; notify_done <label>` to long commands:

   ```bash
   make build; notify_done "build"
   pytest -x; notify_done "tests"
   ```

You'll get a push on your phone whether or not websh is open. To
self-host ntfy.sh instead of using the public instance, see the
[ntfy install docs](https://docs.ntfy.sh/install/).

## Permissions notes

- **Notification permission** is per-origin. Once granted on
  `https://your-host/`, it persists for that origin until the user
  revokes it in browser settings.
- **iOS Safari**: requires the page to be installed as a PWA
  ("Add to Home Screen") for notifications to fire when the tab is
  in the background. websh ships a `manifest.webmanifest` so the
  install gesture is offered.
- **Android Chrome**: works out of the box once permission is
  granted. The notification persists in the notification shade
  until dismissed (the 5-second auto-close in websh is honoured by
  desktops but not Android — that's a platform quirk).
- **Firefox / Safari desktop**: notification appears as a system
  toast and auto-closes after a few seconds.

The title and favicon flash are unconditional fallbacks — they work
without any permission and on any browser.
