# telegram-bewitched

🌍 English · [Русский](README.ru.md) · [Español](README.es.md) · [中文](README.zh.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**Control Claude Code from Telegram.** You write to a bot — Claude Code running on your own server answers, with access to your projects. Each project gets its own topic in a group, each person their own session. You see what Claude is doing right now, approve permissions with buttons, send voice messages, and keep an eye on limits and spending in `/usage`.

Under the hood it is a Claude Code *channel* plugin (channels let an outside source push messages into a running session) — a fork of the [official telegram plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) with a shared daemon, project topics in a forum supergroup, live progress, answer buttons and history that survives restarts.

Spec: [docs/TZ.md](docs/TZ.md) (in Russian). Stages 0–9 are done, including voice (since 1.2.0). Beyond the spec: the `/menu` control panel, subscription limits and spending, reports with charts, reminders, tmux window and git control from Telegram, inviting and removing people, an interface in six languages. What changed — [CHANGELOG.md](CHANGELOG.md).

## How it works

```
Telegram: DMs, group topics
        │ Bot API (one bot)
        ▼
bewitched daemon (one per server): polling, routing, queue, history (SQLite),
                                   control panel, reminders, limits, voice
        │ unix socket                       ▲ Claude Code hooks: progress, «done»
        ▼                                   │
Claude Code sessions in tmux: 👤 one per person (~/user/<id>) · 📂 one per project (its topic)
```

- A message goes to the session that serves its chat: a DM — the sender's own session, a topic — that project's session. If the session isn't running, the daemon starts it in tmux and delivers the message once it connects.
- The session answers with the plugin's tools (`reply`, `ask_user`, …); the daemon shows its progress while it works.
- Sessions start with the development channels flag, so each start is confirmed once — the bot offers a «✅ Confirm launch» button.

## Compared with the official plugin

| Feature | Official `telegram` 0.0.7 | `telegram-bewitched` |
|---|---|---|
| Text, photos, files, voice messages as attachments | ✅ | ✅ |
| Pairing, allowlist, groups with mentions | ✅ | ✅ |
| Tool permissions with buttons | ✅ in DM | ✅ in the project topic or DM (`PERMISSIONS_TO`); «♾ in this session» and «📌 in the project» for good |
| Several Claude sessions on one bot | ❌ 409 Conflict, the second session goes silent | ✅ a shared polling daemon, sessions register over a socket |
| `claude -p` / subagents next to the channel | ❌ start their own poller and break the channel | ✅ passive sessions don't touch incoming messages |
| Conflict with another poller | silent 409 | ✅ waits and tells the owner in DM |
| Topics | ❌ | ✅ forum supergroup, a topic per project, connected from DM with `/connect_group` |
| Control panel | ❌ | ✅ pinned summary in General, `/sessions`, `/topics`, `/send`, `/broadcast`, `/rename`, `/archive`, `/delete`, `/main` |
| New session from Telegram | ❌ | ✅ create a topic → a project folder + Claude in a tmux window; `/new_session` |
| Session and topic archive | ❌ | ✅ «🗄 Archive» closes the session and the topic; reopening the topic starts the session again |
| Live progress | ❌ only «typing» for 5 s | ✅ a draft with «thinking» in DM (Bot API 10.2), an updating «⏳ Working…» with actions in a topic, `/verbose 0\|1\|2` |
| Stop a turn from Telegram | ❌ | ✅ the «⏹ Stop» button (Escape in tmux) |
| Answer buttons | ❌ | ✅ `ask_user`, `reply(buttons)`, multiple choice, timeout |
| Rich messages (Markdown: tables, code, lists) | ❌ only MarkdownV2 with manual escaping | ✅ `format: "rich"` (Bot API 10.1) with a fallback to text |
| A message with no incoming one (done, error) | ❌ | ✅ `notify`, automatic «✅ Done» after a long turn, `bewitched notify`, HTTP `/notify` |
| Chat history | ❌ the Bot API keeps no history | ✅ SQLite + full-text search: `get_history`, `search_messages`, `get_message` |
| Reply context, quotes, forwards | ❌ only the message text | ✅ `reply_to_text`, `quote_text`, `forward_from`, batches of forwards |
| Memory across restarts | ❌ | ✅ `save_memory`, a summary and recent history when a session connects |
| Messages while the session is off | ❌ lost | ✅ stored and delivered when the session starts |
| User rights | everyone in the allowlist, in DM | ✅ roles: 👑 owner (everything), 👤 member (writes, answers, ⏹), 👁 viewer (reads only); permissions and the panel are the owner's; strangers are ignored |
| Finding the session's tmux | — | ✅ from the environment or the Claude process's terminal |
| Voice messages | an attachment without text | ✅ transcribed by local faster-whisper, spoken replies (Silero/Piper/cloud) — [docs/voice.md](docs/voice.md) |
| Limits and spending | ❌ | ✅ `/usage`: subscription limit percentages, cost at API prices, threshold and reset notices, daily summary, reports with a chart |
| Session window and git from Telegram | ❌ | ✅ «✅ Confirm launch», «👁 Screen and keys» (also live, ▶️), 🧹 `/compact`, 🆕 `/clear`, 🧠 model, 🕘 past conversations, 🌿 status, commits, PR and diff |
| External events and CI | ❌ | ✅ `/event` and `bewitched event` → the project's topic and session; a failed GitHub Actions run with a «🛠 Fix it» button |
| Quick commands | ❌ | ✅ `/macro`: your own buttons with text for the chat's session |
| Reminders | ❌ | ✅ `/remind` and the `remind` tool, one-off and daily |
| People | pairing code only | ✅ `/invite` from contacts, `/users`, removal with all their data |
| Ordinary groups | through the main session | ✅ a group without topics = a project: bound from the owner's DM, its session answers in the group |
| Interface languages | English | ✅ Russian, English, Spanish, Chinese, French, German — `/lang`, defaults to the Telegram language |
| Tests | ❌ | ✅ unit and integration tests with a fake Bot API |

## What it does

| | |
|---|---|
| **Shared daemon** | One process polls Telegram for all sessions. Several Claude Code sessions and `claude -p` work with one bot without 409 Conflict. |
| **Topics** | Connect a forum supergroup from DM (`/connect_group`); each project gets its own topic. General holds the pinned control panel and control commands. |
| **Session types** | 👤 a session for each user (their DM and their messages in General), 📂 a session per project in its topic. Sessions start by themselves on the first message; a watchdog reports stopped ones and offers a restart button. |
| **Live progress** | The answer appears as it is written (in a DM draft, in groups inside the progress message), switchable per chat in «/menu → ⚙️». While Claude works: in DM — a native draft with a «thinking» block; in a topic — an updating «⏳ Working…» message with actions and a **⏹ Stop** button (interrupts the turn via tmux). |
| **Answer buttons** | The `ask_user` tool and `reply(buttons)`: options by tap, the answer goes back to the session. |
| **Projects from topics** | Create a topic in the group → a `~/projects/<group id>-<topic id>` folder (by ids, so renamed or repeated titles never clash; the group id without its minus) and a new Claude session in a tmux window bound to that topic. Or `/new_session <name\|path>`. The launch is confirmed with the «✅ Confirm launch» button. |
| **Archive** | «🗄 Archive» on the project card in `/sessions`: the session ends, the topic closes. Reopen the topic — a new session starts. Closing the topic in Telegram is the same as archiving. |
| **Notifications** | `notify` with no incoming message, automatic «✅ Done» after a long turn, `bewitched notify` and HTTP `/notify` for scripts and CI. |
| **The `/menu` panel** | One message with buttons for everything: sessions, topics, statistics, people, reminders, this chat's settings, help. Telegram's command menu shows only `/menu`, `/sessions`, `/usage`, `/help`. |
| **Session control** | «✅ Confirm launch» in the launch message — no terminal needed. The card in `/sessions`: a snapshot of the tmux window with keys (▶️ — refreshes itself for a minute), 🧹 `/compact`, 🆕 `/clear`, 🧠 switch model, 🕘 past conversations (`/resume` in the same session), ⚡ quick commands, 🌿 git (status, commits, PR, diff as a file), «♾ Always in the session» and «📌 Always in the project» for a tool, a warning when the context is filling up. |
| **External events** | `bewitched event --topic <name> "text"` or `POST /event` — a «📡» message in the project's topic and to its session. Every 5 minutes the bot looks at the latest GitHub Actions run of each project session's branch: failed — «❌ CI failed» with «🛠 Fix it», green again — «✅». |
| **Voice** | Voice messages and video notes are transcribed locally; a voice message gets a spoken reply. Numbers, times, dates and Latin words are read out in Russian by the Russian voice. Voice and speed are per-chat settings. |
| **Statistics** | `/usage` — limit percentages with reset time and a bar, spending by model and session; notices at 80/95% and at the moment of reset (🔔/🔕); «🌙 Daily summary»; `/reports` — day, week, month with a chart; the session's cost on its card; `/server` — machine load, the daemon log and a restart button; 👥 who used how much of the 5-hour window, with a notice when someone takes more than `USER_SHARE_ALERT`. 🌙 Quiet hours — silent at night. |
| **Out of tokens** | When a turn fails on the subscription limit, an API rate limit or an empty API balance, the bot answers by itself in the chat's language (“⏸ The Claude subscription is out of tokens… I'll answer right after the limit resets at 14:20”), saves new messages and, at the reset, hands them to the session in one batch and asks it to finish the cut-off turn. API rate limits retry after 2, 4, 8… min; an empty balance waits for «▶️ Continue now» (also in `/menu` while paused). Other failures (not logged in, server error, answer too long, request too large) get a plain hint instead of bare English. |
| **Reminders** | `/remind 2h check CI`, «tomorrow 9:00», «every day 9:00»; when due, the text arrives in the chat and to its session; a session that isn't running is started. |
| **People** | `/invite` — pick a contact, the bot grants access, starts their session and gives a group link; `/users` and 🚫 — remove a person with their session, folder, transcripts and history. People added through `/telegram-bewitched:access` are picked up by the daemon automatically. |
| **Groups as projects** | An ordinary group (no topics) allowed in access becomes a project: the owner gets a card in DM — new project, an existing folder or «not a project». Its session answers in the group; control from the owner's DM. |
| **Languages** | The bot interface in 6 languages: ru, en, es, zh, fr, de. A chat's language — `/lang` or the flags in «/menu → ⚙️»; by default in DM — the user's Telegram language, otherwise `BOT_LANGUAGE`. Telegram's command menu follows the app language. |
| **History and memory** | SQLite with full-text search, reply/quote/forward context in every message, `get_history`, `search_messages`, chat memory `save_memory`, a summary when a session connects, delivery of messages that came while the session was off. |

## Requirements

- [Bun](https://bun.sh) ≥ 1.2.
- Claude Code with channels and the `MessageDisplay` hook.
- tmux — for starting sessions automatically, the «⏹ Stop» button, «👁 Screen and keys» and commands in the session window (without tmux «Stop» only tells the model about the stop).
- Optional: `gh` (PRs in «🌿 Git», CI watch), ffmpeg and Python 3 (voice, installed with `bewitched voice install`).

## Installation

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. In Claude Code:

```
/plugin marketplace add deniskelin/telegram_bewitched_plugin
/plugin install telegram-bewitched@bewitched
/telegram-bewitched:configure <token>
```

   If the official plugin was installed before, `.env` and `access.json` are copied from `~/.claude/channels/telegram/` automatically on the first start.
3. Start a session with the channel (see «Running»), write to the bot in DM — it answers with a 6-character code — and run `/telegram-bewitched:access pair <code>` in Claude Code. The first paired user becomes the owner. More in [ACCESS.md](ACCESS.md).

**The official plugin and the fork must not poll one token at the same time.** Disable the official one (`/plugin disable telegram@claude-plugins-official`) or run Claude without its `--channels`. If the daemon sees the official plugin running with the same token, it waits instead of fighting over polling.

## Running

During the research preview third-party channels are loaded with a development flag (a confirmation appears; accept it):

```
tmux new -s claude
claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched
```

The first session starts the daemon. It keeps running after sessions close, so the control panel and `/notify` always answer.

CLI commands run from the plugin folder: after a marketplace install that is `~/.claude/plugins/cache/bewitched/telegram-bewitched/<version>/` (or a clone of the repository).

```
cd ~/.claude/plugins/cache/bewitched/telegram-bewitched/<version>
bun bin/bewitched.ts daemon status|stop|restart|logs
bun bin/bewitched.ts daemon install-cron     # @reboot in crontab
bun bin/bewitched.ts voice install           # voice, see docs/voice.md
bun bin/bewitched.ts notify --topic myproj "build failed"
bun bin/bewitched.ts event --topic myproj --source ci "deploy failed: …"   # to the project's topic and session
```

## Updating

```
claude plugin marketplace update bewitched
claude plugin update telegram-bewitched@bewitched
```

Then restart the Claude Code sessions (the client and hooks come from the new version) and the daemon — with the command from the **new** version's folder: `bun bin/bewitched.ts daemon restart`. The «♻️ Restart the daemon» button in `/server` restarts the version that is already running. If you used `install-cron`, run it again from the new folder — the entry is replaced.

## Topics in a supergroup

1. In the bot's DM: `/connect_group`.
2. «➕ Add the bot to a group» → choose a group with «Topics» enabled → confirm the admin rights (manage topics, pin, delete).
3. Confirm the connection in DM.

Rights are by role (FR-4): 👑 the owner — the first paired user — can do everything; 👤 a member writes to sessions, answers buttons and presses ⏹; 👁 a viewer only reads. Approving permissions, the control panel, archive, settings and inviting or removing people are the owner's; roles are switched in `/users`. Other group members are ignored. Telegram's native drafts work only in DMs, so in topics progress is shown as an updating message.

`/sessions` is a menu in one message, like BotFather: the list of sessions with a button each; a button opens the session card with actions (⏹ Stop, 👑 Make main, 🗄 Archive, 💬 Open topic) and its chat's settings (🔕0/🔔1/📢2 and «✅ done»); «« To the list» goes back. `/topics` is the same kind of menu for topics: the state of each (session, 💤 no session, queue), a topic screen with 💬 Open, 📋 session card, 🚀 Start session, 🗄 Archive / ↩️ Restore, 🗑 Delete; the archive on its own page. «👁 Screen and keys» (on the card and in launch messages) sends the current view of the tmux window with 1/2/3, Enter, Esc, ↑/↓, Tab buttons — enough to deal with a prompt without `tmux attach`. «🌿 Git» shows the status, latest commits and the branch's PR (via `gh`); «📄 diff as a file» sends `git diff HEAD`. Under a permission request there are «♾ Always <tool> in this session» (until the session reconnects; reset on the card) and «📌 Always <tool> in the project» (kept by the bot per project folder; removed on the card). The 🧹 `/compact`, 🆕 `/clear` and 🧠 Model buttons type the command into the session window (only between turns). The card shows: type (👑 main or project), status, `#id` and pid, working folder, branch, topic, where it is in tmux (session, window, pane) with a ready `tmux attach -t <session>:<window>`, whether «⏹ Stop» is available, permission mode, model and context size, the current turn and last action, the `claude --resume <id>` command, the `/rename` name, whether 📱 Remote Control is on with a link to the session on claude.ai (from the `remote_session_change` event in the transcript; before the first such event — from the `--remote-control`/`--rc` flag or `remoteControlAtStartup`), and the time since start and last activity. Sessions started without the channels flag are listed in a separate «👻 No channel» block with a ready restart command: they get no messages and used to be invisible.

Everything below is also available as buttons in **`/menu`** (Telegram's command menu has only `/menu`, `/sessions`, `/usage`, `/help`). Control commands (DM or General): `/sessions`, `/topics`, `/permissions` (waiting permission requests across sessions), `/send <topic> <text>`, `/broadcast <text>`, `/rename <topic> | <name>`, `/archive <topic>`, `/delete <topic>`, `/new_session <name|path>`. In any chat: `/verbose [0|1|2]` (🔕0 answer only, 🔔1 + actions, 📢2 + model text; without an argument shows the current level), `/notify_done [off|long|always]`, `/lang ru|en|es|zh|fr|de|auto`, `/remember`, `/forget`, `/voice off|mirror|always`, `/transcript on|off`, `/macro add <button> | <text>` and `/macro del <n>` (the chat's quick commands), `/remind <when> <text>` (30m, 1h30m, «in 2 hours», 18:30, «tomorrow 9:00», «every day 9:00»; Russian forms work too; when due, the text arrives in the chat and to the chat's session, and a session that isn't running is started), `/reminders`. The level is shown on session cards (the 📣 line), changed there with buttons and in the «⏳ Working… · 🔔1» header. In DM: `/server` (CPU, memory, disks, Claude Code and voice processes; «📜 Daemon logs», «♻️ Restart the daemon»), `/users` (everyone with access; 🚫 removes a user: access, session and tmux window, folder, transcripts and DM history — after a confirmation), `/invite` (invite a user: pick a contact → confirm → the bot grants access, starts their session and sends an invitation to forward), `/usage`, `/digest`, `/reports` (reports for a day, week and month with a spending chart by hour/day/week and statistics; each is switched on with a button and arrives when the period ends), `/main [id|reset]`, `/group`, `/disconnect_group`, `/status`.

`/usage` (owner only): the subscription plan from `~/.claude/.credentials.json`, limit percentages (5 hours, week) with reset times, and token spending for 5 hours, a day and 7 days across all transcripts at API prices, by model and session. The percentages come from Anthropic's **undocumented** `api/oauth/usage` endpoint (the one `/usage` in Claude Code calls) with the subscription's OAuth token. It may stop working with any update; then `/usage` shows local data only. `USAGE_LIMITS=off` turns the request off. The «Who spends», «By model» and «By session» sections cover the period chosen with buttons: 5 hours, day, week or month (for 5 hours and a week «who spends» is a share of the subscription window, otherwise a share of spending).

## Several topic groups

The first group connected with `/connect_group` is the main one: General, the pinned panel and people's sessions. Connect more with the same `/connect_group` — they become extra topic groups (for example work and personal projects). In `/topics` → «🗂 Topic groups» each extra group gets folders (checked from `PROJECTS_DIR`): a project inside one gets its topic there, everything else goes to the main group; topics created in an extra group are its projects right away. `/topics` switches between groups with a row of buttons; «🔌 Disconnect» drops an extra group.

## Ordinary groups as projects

A group without topics can be a project of its own — a family chat about a site, a team chat about a service.

1. Add the bot to the group and allow it in the terminal: `/telegram-bewitched:access group add <id>` (the bot tells you the id when added; until then it stays silent there). By default the bot answers only when mentioned — `--no-mention` turns that off (and needs privacy mode disabled at @BotFather — see [ACCESS.md](ACCESS.md)).
2. On the group's first message the owner gets a card in DM: «📁 New project» (`~/projects/<group id>`), «📂 Choose a project» (an existing folder) or «🚫 Not a project» (the main session answers, as before). What the group wrote waits in a queue meanwhile.
3. The project's session starts in tmux (confirmed with «✅ Confirm launch» in your DM), answers right in the group and shows its progress there. It gets no topic.

Everything else is from the owner's DM: the session card in `/sessions` (with «👥 Unbind the group»), the list in «/menu → 👥 Groups». Permission requests of a group's session go only to the owner. Reminders, `/macro`, `/event` and CI notices work in the group as in a topic.

## Session types

The bot is meant for a small circle of your own people (a family, say) in the allowlist. Everyone has their own Claude session; projects live in the group's topics.

| | Folder | What it gets |
|---|---|---|
| 👤 **User session** | `~/user/<user_id>` (`USERS_DIR`) | This user's DM and their messages in General; answers there |
| 📂 **Project session** | the project folder | Its topic |
| 👑 **Main** | `MAIN_DIR` (default `~`) | Only with `USER_SESSIONS=off` (everyone's DMs and General, as in 1.0) or as a fallback for `TOPIC_NO_SESSION=main` |

The daemon itself does the housekeeping, without Claude: control commands, closing and opening topics, starting sessions, the watchdog.

- **A user session starts by itself.** A user's first message → the daemon creates `~/user/<id>`, starts Claude in a new tmux window (`TMUX_SESSION`, with `--continue` if there were conversations already); the message waits in the queue and arrives after the session connects.
- **A project topic without a session** (`TOPIC_NO_SESSION=launch`): a message starts the project session. If the start fails, the bot posts a command for a manual start and closes the topic until the session connects.
- **Watchdog.** A session went away by itself (not archive, not timeout) → a minute later the owner gets «⚠️ Session … has stopped» in DM, with restart commands and a «🚀 Start» button. The project topic gets the notice without commands or buttons and is closed until the session reconnects; a member whose own session stopped gets a «🙋 Ask for a restart» button, which forwards the request to the owner.
- **Closing idle sessions:** `USER_IDLE_MIN` and `PROJECT_IDLE_MIN`, default `0` — never. An idle session spends no tokens, only memory.

### What you do by hand

1. **Confirm each session start.** While Claude Code channels are in research preview, starting with `--dangerously-load-development-channels` shows a warning screen. The bot doesn't accept it on its own: the launch message has a «✅ Confirm launch» button — on a tap the bot answers the startup questions one by one (folder trust «Yes, I trust this folder» for a new folder, and «I am using this for local development»), waits until the session connects and replaces the screen with «✅ Session connected». Any other question is left to you — «👁 Screen and keys» (with «✖️ Close») or `tmux attach -t claude:<window>`. Needed on a new user's first message, after a server reboot, after a session crash and after each idle close (if enabled).
2. **Keep tmux on the server.** Without it sessions don't start automatically — the bot sends a command for a manual start.
3. **Restart stopped sessions** — with «🚀 Start» from the watchdog notice (and confirm again) or with the command from it.

### Drawbacks

- Every start is confirmed with a tap (see above); until someone taps, the user waits for an answer.
- Every session is a separate Claude Code process: ~350–450 MB of memory, and they all spend the limits of one account.
- Isolation is only by context and memory: all sessions run as one system user, see the whole machine, each other's files and the shared `~/.claude`. For a family that is a deliberate choice, not a security boundary.
- Everyone in the group sees answers in General; a user's session may quote something from their DM there if the user asks.
- The watchdog notice also comes after a deliberate `/exit` in the terminal — from outside it can't be told apart from a crash.
- `--continue` continues the latest conversation in the folder, including one started there by hand.

`USER_SESSIONS=off` brings back the 1.0 behaviour: everyone's DMs and General go to the main session in `MAIN_DIR`; `/main <id>`, `/main reset` and «👑 Make main» on the `/sessions` card reassign it.

## Settings (`~/.claude/channels/telegram-bewitched/.env`)

| Variable | Default | |
|---|---|---|
| `TOPIC_MODE` | `project` | `project` — a topic per project, `session` — per session, `off` |
| `PERMISSIONS_TO` | `topic` | Where permission requests go: `topic`, `dm`, `both` |
| `STOP_MODE` | `interrupt` | `interrupt` (Escape in tmux), `notify`, `off` |
| `PROGRESS_FINAL` | `delete` | What happens to the progress message after the answer: `delete`, `keep` |
| `NOTIFY_LONG_SEC` | `60` | The «long turn» threshold for the automatic notice |
| `DAEMON_IDLE_EXIT_MIN` | `0` | Stop the daemon after N minutes without sessions (0 — never) |
| `BEWITCHED_HTTP_PORT` | `8797` | Local HTTP (hooks, `/notify`, `/event`), 127.0.0.1 only, token in `http.token` |
| `HISTORY_MAX_DAYS` | `90` | How long history is kept |
| `PASSIVE_TOOLS` | `false` | Allow tools in sessions without the channel (`claude -p`) |
| `TOPIC_PROJECTS` | `auto` | A topic created by the owner → a project and a session: `auto`, `ask` (button), `off` |
| `PROJECTS_DIR` | `~/projects` | Where project folders are created |
| `USER_SESSIONS` | `on` | A session for each user in the allowlist; `off` — as in 1.0 (everything to the main one) |
| `USERS_DIR` | `~/user` | Where user session folders live (`<USERS_DIR>/<user_id>`) |
| `USER_IDLE_MIN` | `0` | Close a user session after N idle minutes (0 — never) |
| `PROJECT_IDLE_MIN` | `0` | Close a project session after N idle minutes (0 — never) |
| `TOPIC_NO_SESSION` | `launch` | A project topic without a session: `launch` — start it, `main` — the main session answers, `queue` — only queue |
| `WATCHDOG_GRACE_SEC` | `60` | How many seconds after a session stops to report it |
| `MAIN_DIR` | `~` | The main session's folder (with `USER_SESSIONS=off` — DMs and General) |
| `CONTEXT_WINDOW` | `1000000` | Context window size for the fill percentage on session cards |
| `CONTEXT_WARN_PCT` | `80` | Offer `/compact` in the session's chat at this context fill (0 — never) |
| `DIGEST_AT` | `21:00` | When to send the owner the «🌙 Daily summary» (spending, commits, limits); `off` — never. On request — `/digest` |
| `LIMIT_ALERTS` | `80,95` | Subscription limit notice thresholds in percent; `off` — no notices. A window that crossed a threshold gets «✅ Tokens are back» exactly at the reset; in `/usage` the same can be ordered with 🔔 for any window |
| `LIMIT_WARMUP` | `off` | `on`: a minute after the 5-hour window resets, send a tiny `claude -p` request (haiku) so the next window starts right away instead of when work resumes. Also the ⚡ button in `/usage` |
| `LIMIT_CHECK_MIN` | `10` | How often to check limits (minutes, 0 — never) |
| `USAGE_LIMITS` | `on` | `/usage`: ask the undocumented Anthropic endpoint for limit percentages (`off` — local data only) |
| `USER_SHARE_ALERT` | `40` | Tell the owner when another user took this many percent of the 5-hour window (once per window; 0 — never). Works together with `LIMIT_ALERTS` |
| `CI_WATCH_MIN` | `5` | How often to check the latest GitHub Actions run of project sessions' branches (via `gh`; 0 — never) |
| `QUIET_HOURS` | `off` | Quiet hours, e.g. `23:00-08:00`: everything the bot sends arrives silently. The buttons in «/menu → ⚙️» override `.env` |
| `BOT_LANGUAGE` | `ru` | The default interface language (`ru`, `en`, `es`, `zh`, `fr`, `de`) when neither the chat nor the owner chose one and the user's Telegram language is unknown |
| `TMUX_SESSION` | `claude` | The tmux session for new windows |
| `STT_PROVIDER` / `TTS_PROVIDER` | `off` | Voice: transcribing incoming messages and spoken replies — see [docs/voice.md](docs/voice.md), install with `bewitched voice install` |
| `CLAUDE_LAUNCH_CMD` | `claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched` | The command for a new session. The bot adds `-n claude-<telegram id>` (user session) or `-n claude-<group id>-<topic id>` (project, like its folder); the tmux window gets the same name |

Access (pairing, allowlist, groups) works as in the official plugin, see [ACCESS.md](ACCESS.md) and `/telegram-bewitched:access`.

## Development

```
bun install
bun test          # unit + integration tests with a fake Bot API
bunx tsc --noEmit
```

Translations: interface strings are written in Russian as `t('…', { vars })`; dictionaries are in `src/i18n/<lang>.ts`; `bun scripts/i18n-keys.ts missing en` lists untranslated strings, and a test checks that every dictionary is complete.

Layout: `server.ts` — a thin MCP client per session; `src/daemon/` — the daemon (polling, routing, topics, streaming, buttons, tools, HTTP, menus and screens, statistics, reports, reminders); `src/i18n/` — interface languages; `src/voice/` and `voice/*.py` — speech recognition and synthesis; `hooks/` — Claude Code hooks → daemon; `bin/bewitched.ts` — the CLI. Syncing with upstream — [UPSTREAM.md](UPSTREAM.md).
