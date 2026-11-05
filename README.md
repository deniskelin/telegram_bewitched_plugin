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
| Control panel | ❌ | ✅ pinned summary in General by section (owner, users, projects) with the agent, model and effort, three detail levels with 🔹/🔸/🔶 buttons (with `JOURNAL_CHAT_ID` — in the journal's «📌 Status» topic, with the limits and bars as in `/usage`), `/sessions`, `/topics`, `/send`, `/broadcast`, `/rename`, `/archive`, `/delete` |
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
| Ordinary groups | through its only session | ✅ a group without topics = a project: bound from the owner's DM, its session answers in the group |
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
| **Two engines** | A session runs on **Claude Code** or **Codex CLI**, chosen per project in 🧠 and switched with one tap. On a switch the work is handed over (`.telegram/handoff.md`: recent turns and git state), so the other engine goes on where the first stopped. Codex's permission requests come as the same «✅ Allow / ❌ Deny» cards, its usage is in `/usage` and the daily summary, and when Claude runs out of tokens «🔀 Continue on Codex until the reset» moves the work over and back. See [Engines](#engines-claude-code-and-codex). |
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
- Optional: `gh` (PRs in «🌿 Git», CI watch), ffmpeg and Python 3 (voice, installed with `bewitched voice install`), [Codex CLI](https://github.com/openai/codex) (the second engine; found in `~/.local/bin/codex`, `CODEX_BIN` or `PATH`).

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

`/sessions` shows the owner and seven other sessions per page, sorted by attention, with saved filters, status and agent icons; names are shortened safely. Models and reasoning settings are inside each session card; a button opens the session card: ⏹ Stop (during a turn), 👁 Screen, 🌿 Git, 💬 Open topic and three groups — «🤖 Agent» (/compact, /clear, model, past conversations, quick commands), «🔔 Notifications» (🔕0/🔔1/📢2 and «✅ done» for its chat), «⚙️ Manage» (🗄 Archive, unbind group, remove user, permission rules); each group has «« Back», «« To the list» goes back. Projects are named after their topic or group. `/topics` is the same kind of menu for topics: the state of each (session, 💤 no session, queue), a topic screen with 💬 Open, 📋 session card, 🚀 Start session, 🗄 Archive / ↩️ Restore, 🗑 Delete; the archive on its own page. «👁 Screen and keys» (on the card and in launch messages) sends the current view of the tmux window with 1/2/3, Enter, Esc, ↑/↓, Tab buttons — enough to deal with a prompt without `tmux attach`. «🌿 Git» shows the status, latest commits and the branch's PR (via `gh`); «📄 diff as a file» sends `git diff HEAD`. Under a permission request there are «♾ Always <tool> in this session» (until the session reconnects; reset on the card) and «📌 Always <tool> in the project» (kept by the bot per project folder; removed on the card). The 🧹 `/compact`, 🆕 `/clear` and 🧠 Model buttons type the command into the session window (only between turns). 🧠 also sets the 🎚 reasoning effort: low, medium, high, very high and max for Claude Code (right away, with `/effort`), low…very high for Codex (from the next launch, `model_reasoning_effort`). The level is kept per project and shown next to the model on the card, in «🔢 Turn cost», `/usage` and the daily digest: «opus-5-5 · high». The card shows: type (👤 personal or 📂 project), status, `#id` and pid, working folder, branch, topic, where it is in tmux (session, window, pane) with a ready `tmux attach -t <session>:<window>`, whether «⏹ Stop» is available, permission mode, model and context size, the current turn and last action, the `claude --resume <id>` command, the `/rename` name, whether 📱 Remote Control is on with a link to the session on claude.ai (from the `remote_session_change` event in the transcript; before the first such event — from the `--remote-control`/`--rc` flag or `remoteControlAtStartup`), and the time since start and last activity. Sessions started without the channels flag are listed in a separate «👻 No channel» block with a ready restart command: they get no messages and used to be invisible.

Everything below is also available as buttons in **`/menu`** (Telegram's command menu has only `/menu`, `/sessions`, `/usage`, `/help`). Control commands (DM or General): `/sessions`, `/topics`, `/permissions` (waiting permission requests across sessions), `/send <topic> <text>`, `/broadcast <text>`, `/rename <topic> | <name>`, `/archive <topic>`, `/delete <topic>`, `/new_session <name|path>`. In any chat: `/verbose [0|1|2]` (🔕0 answer only, 🔔1 + actions, 📢2 + model text; without an argument shows the current level), `/notify_done [off|long|always]`, `/lang ru|en|es|zh|fr|de|auto`, `/remember`, `/forget`, `/voice off|mirror|always`, `/transcript on|off`, `/macro add <button> | <text>` and `/macro del <n>` (the chat's quick commands), `/remind <when> <text>` (30m, 1h30m, «in 2 hours», 18:30, «tomorrow 9:00», «every day 9:00»; Russian forms work too; when due, the text arrives in the chat and to the chat's session, and a session that isn't running is started), `/reminders`. Repeating: «every 2h …». In a project topic: `/prompt [text|off]` (the topic's prompt mode: normal, 🔍 review — read only: no file edits and no shell, 💬 conversation — no shell or edits, or your own text; applies from the next start), `/once [claude|codex] <question>` (one read-only turn in the topic's folder without a session), `/review` (the other engine reviews the session's uncommitted changes; also «🔍 Review» on the session card). `/server` → «⬆️ Update CLI» runs `claude update` / `codex update`. The level is shown on session cards (the 📣 line), changed there with buttons and in the «⏳ Working… · 🔔1» header. In DM: `/server` (CPU, memory, disks, Claude Code and voice processes; «📜 Daemon logs», «♻️ Restart the daemon»), `/users` (everyone with access; 🚫 removes a user: access, session and tmux window, folder, transcripts and DM history — after a confirmation), `/invite` (invite a user: pick a contact → confirm → the bot grants access, starts their session and sends an invitation to forward), `/usage`, `/digest`, `/reports` (reports for a day, week and month with a spending chart by hour/day/week and statistics; each is switched on with a button and arrives when the period ends), `/group`, `/disconnect_group`, `/status`.

`/usage` (owner only) opens a compact Claude/Codex summary with Details and Close report. All breakdowns use the same selected rolling or calendar range. API equivalents are estimates; unpriced models and stale quotas stay explicit. Shares mean observed tokens. Claude quota uses the undocumented OAuth `api/oauth/usage` endpoint and can become unavailable; `USAGE_LIMITS=off` disables it. Codex quota comes from rollouts. [Periods, prices and limitations](docs/usage-pages.md).

## Several topic groups

The first group connected with `/connect_group` is the main one: General, the pinned panel and people's sessions. Connect more with the same `/connect_group` — they become extra topic groups (for example work and personal projects). In `/topics` → «🗂 Topic groups» each extra group gets folders (checked from `PROJECTS_DIR`): a project inside one gets its topic there, everything else goes to the main group; topics created in an extra group are its projects right away. `/topics` switches between groups with a row of buttons; «🔌 Disconnect» drops an extra group.

## Ordinary groups as projects

A group without topics can be a project of its own — a family chat about a site, a team chat about a service.

1. Add the bot to the group and allow it in the terminal: `/telegram-bewitched:access group add <id>` (the bot tells you the id when added; until then it stays silent there). By default the bot answers only when mentioned — `--no-mention` turns that off (and needs privacy mode disabled at @BotFather — see [ACCESS.md](ACCESS.md)).
2. On the group's first message the owner gets a card in DM: «📁 New project» (`~/projects/<group id>`), «📂 Choose a project» (an existing folder) or «🚫 Not a project» (each message goes to its author's own session). What the group wrote waits in a queue meanwhile.
3. The project's session starts in tmux (confirmed with «✅ Confirm launch» in your DM), answers right in the group and shows its progress there. It gets no topic.

Everything else is from the owner's DM: the session card in `/sessions` (with «👥 Unbind the group»), the list in «/menu → 👥 Groups». Permission requests of a group's session go only to the owner. Reminders, `/macro`, `/event` and CI notices work in the group as in a topic.

## Session types

The bot is meant for a small circle of your own people (a family, say) in the allowlist. Everyone has their own Claude session; projects live in the group's topics.

| | Folder | What it gets |
|---|---|---|
| 👤 **User session** | `~/user/<user_id>` (`USERS_DIR`) | This user's DM and their messages in General; answers there |
| 📂 **Project session** | the project folder | Its topic |

The daemon itself does the housekeeping, without Claude: control commands, closing and opening topics, starting sessions, the watchdog.

- **A user session starts by itself.** A user's first message → the daemon creates `~/user/<id>`, starts Claude in its own tmux session `claude-user-<id>` ( with `--continue` if there were conversations already); the message waits in the queue and arrives after the session connects.
- **A project topic without a session** (`TOPIC_NO_SESSION=launch`): a message starts the project session. If the start fails, the bot posts a command for a manual start and closes the topic until the session connects.
- **Watchdog.** A session went away by itself (not archive, not timeout) → a minute later the owner gets «⚠️ Session … has stopped» in DM, with restart commands and a «🚀 Start» button. The project topic gets the notice without commands or buttons and is closed until the session reconnects; a member whose own session stopped gets a «🙋 Ask for a restart» button, which forwards the request to the owner.
- **💤 Suspending idle sessions** (`/menu → 💤`): a row per kind — users' own sessions, the owner's own session, project sessions — «never · 12 h · a day · 3 days · a week». Nobody is told in the chats: the journal («🖥 Sessions», the botlog) gets one line. The next message wakes the session up by itself, with its conversation, the startup screen confirmed automatically; the journal gets «🔄 waking up» and «✅ back at work». Only a wake-up that fails is told in the chat. Defaults: the owner's own session a week, others from `USER_IDLE_MIN` / `PROJECT_IDLE_MIN` (`0` — never). An idle session spends no tokens, only memory.

### What you do by hand

1. **Nothing to confirm at a start.** Startup questions of a new session (folder trust «Yes, I trust this folder», «I am using this for local development», Codex's «Hooks need review») are answered by the daemon itself: it checks the windows of unfinished launches every 20 s. The chat gets «🚀 Starting…» and then the result; the tmux window and command go to the journal. Any other question on the screen is sent to the chat with keys — «👁 Screen and keys» (with «✖️ Close») or `tmux attach -t <session>:<window>`.
2. **Keep tmux on the server.** Without it sessions don't start automatically — the bot sends a command for a manual start.
3. **Restart stopped sessions** — with «🚀 Start» from the watchdog notice or with the command from it.

### Drawbacks

- Every session is a separate Claude Code process: ~350–450 MB of memory, and they all spend the limits of one account.
- Isolation is only by context and memory: all sessions run as one system user, see the whole machine, each other's files and the shared `~/.claude`. For a family that is a deliberate choice, not a security boundary.
- Everyone in the group sees answers in General; a user's session may quote something from their DM there if the user asks.
- `--continue` continues the latest conversation in the folder, including one started there by hand.


## Engines: Claude Code and Codex

A session runs on one of two agent CLIs. Claude Code talks to the daemon over the channel; Codex CLI is started with the daemon's own profile (`$CODEX_HOME/bewitched.config.toml`: the same MCP server, the same hooks, the channel instructions) and gets messages through `codex queue` or one bracketed paste into its window.

- **Choosing.** 🧠 on the session card: the engine row and its models. The choice is remembered for the project; every start (a topic, 🚀, a user's DM, a wake-up) uses it. «♻️ Switch to Codex now» closes the session and starts it on the other engine — no terminal needed. tmux windows are named by engine: `claude-project-<folder>`, `codex-user-<id>`.
- **Handoff.** Each engine keeps its own conversations, so a switch hands the work over: the daemon reads the outgoing conversation (Claude's transcript or Codex's rollout: what the user wrote, what was answered), adds the branch, uncommitted changes and recent commits, writes `<folder>/.telegram/handoff.md` and gives the new engine a first message pointing to it. The new engine starts a fresh conversation with that; no model is used for the handoff.
- **One project memory.** Codex reads the project's `CLAUDE.md` when there is no `AGENTS.md` (`project_doc_fallback_filenames`); the handoff names whichever of them the project has.
- **Permissions.** Codex asks in its own window («Would you like to run the following command?»). The daemon reads the request off the screen right after the tool hook and sends a card: «✅ Allow», «❌ Deny», «♾ Don't ask again this session». A tap selects that option in Codex's window — only if the same request is still open.
- **Usage.** `/usage` has a section per subscription; Codex is counted from its rollouts (`~/.codex/sessions`): its 5-hour and weekly windows, tokens, «who spends» in tokens, models and sessions. Its windows cross the same `LIMIT_ALERTS` thresholds. A Codex turn's footer shows its tokens and cache share (known models also show an API-equivalent estimate, not a subscription charge).
- **Out of Claude tokens.** The pause notice has «🔀 Continue on Codex until the reset»: the session switches to Codex with the handoff and the saved messages go to it. When Claude's limit is back, the chat gets «↩️ Back to Claude» / «Stay on Codex».
- **Session commands.** `/compact` works on both; `/clear` is typed as `/new` for Codex; 🕘 conversations lists Codex's own and continues the chosen one by restarting the session with it (`codex resume <id>`).

## Settings (`~/.claude/channels/telegram-bewitched/.env`)

| Variable | Default | |
|---|---|---|
| `TOPIC_MODE` | `project` | `project` — a topic per project, `session` — per session, `off` |
| `PERMISSIONS_TO` | `topic` | Where permission requests go: `topic`, `dm`, `both` |
| `STOP_MODE` | `interrupt` | `interrupt` (Escape in tmux), `notify`, `off` |
| `PROGRESS_FINAL` | `delete` | What happens to the progress message after the answer: `delete`, `keep` |
| `RICH_SCREENS` | `on` | Bot screens (`/menu`, `/sessions`, `/usage`…) as Telegram rich messages — heading, divider, sections; `off` — plain HTML |
| `BUTTON_ICONS` | `on` | Custom emoji icons on buttons (the UI Icons pack). Telegram allows them while the bot's owner has Premium (or the bot has a Fragment username); a refused message is resent with plain emoji and icons stay off until restart. `off` — plain emoji always |
| `NOTIFY_LONG_SEC` | `60` | The «long turn» threshold for the automatic notice |
| `DAEMON_IDLE_EXIT_MIN` | `0` | Stop the daemon after N minutes without sessions (0 — never) |
| `BEWITCHED_HTTP_PORT` | `8797` | Local HTTP (hooks, `/notify`, `/event`), 127.0.0.1 only, token in `http.token` |
| `HISTORY_MAX_DAYS` | `90` | How long history is kept |
| `PASSIVE_TOOLS` | `false` | Allow tools in sessions without the channel (`claude -p`) |
| `TOPIC_PROJECTS` | `auto` | A topic created by the owner → a project and a session: `auto`, `ask` (button), `off` |
| `PROJECTS_DIR` | `~/projects` | Where project folders are created |
| `USERS_DIR` | `~/user` | Where user session folders live (`<USERS_DIR>/<user_id>`) |
| `USER_IDLE_MIN` | `0` | Close a user session after N idle minutes (0 — never) |
| `PROJECT_IDLE_MIN` | `0` | Close a project session after N idle minutes (0 — never) |
| `OWNER_IDLE_MIN` | `10080` | Close the owner's own session after N idle minutes (a week; 0 — never). `/menu → 💤` overrides all three |
| `TOPIC_NO_SESSION` | `launch` | A project topic without a session: `launch` — start it, `queue` — only queue |
| `WATCHDOG_GRACE_SEC` | `60` | How many seconds after a session stops to report it |
| `CODEX_SANDBOX` | `auto` | Codex's sandbox: `auto` — `workspace-write` (the projects and users folders writable, network on), or none where the sandbox cannot start (an old kernel without user namespaces), since otherwise Codex asks before every command; or `read-only` / `workspace-write` / `danger-full-access` |
| `CODEX_APPROVAL` | `on-request` | When Codex asks for approval: `on-request` — only when the model needs more than the sandbox allows; `untrusted`, `never` |
| `TURN_STUCK_SEC` | `120` | Warn when a delivered message gets no sign of life (no hook, no transcript write) for N seconds; 0 — off |
| `CONTEXT_WINDOW` | `1000000` | Context window size for the fill percentage on session cards |
| `CONTEXT_WARN_PCT` | `80` | Offer `/compact` in the session's chat at this context fill (0 — never) |
| `DIGEST_AT` | `on` | Daily reports are on by default at local midnight for the completed day; off disables them until /reports enables them. Time strings are ignored. /digest shows today on demand. |
| `LIMIT_ALERTS` | `80,95` | Subscription limit notice thresholds in percent; `off` — no notices. A window that crossed a threshold gets «✅ Tokens are back» exactly at the reset; in `/usage` the same can be ordered with 🔔 for any window |
| `LIMIT_WARMUP` | `off` | `on`: a minute after the 5-hour window resets, send a tiny `claude -p` request (haiku) so the next window starts right away instead of when work resumes. Also the ⚡ button in `/usage` |
| `LIMIT_CHECK_MIN` | `10` | How often to check limits (minutes, 0 — never) |
| `USAGE_LIMITS` | `on` | `/usage`: ask the undocumented Anthropic endpoint for limit percentages (`off` — local data only) |
| `USER_SHARE_ALERT` | `40` | Tell the owner when another user took this many percent of the 5-hour window (once per window; 0 — never). Works together with `LIMIT_ALERTS` |
| `CI_WATCH_MIN` | `5` | How often to check the latest GitHub Actions run of project sessions' branches (via `gh`; 0 — never) |
| `QUIET_HOURS` | `off` | Quiet hours, e.g. `23:00-08:00`: everything the bot sends arrives silently. The buttons in «/menu → ⚙️» override `.env` |
| `SKIP_ACKS` | `on` | «ok», «👍», «thanks» right after an answer that asked nothing get a 👌 instead of waking the session; `off` — send them on. Also handled without the model: «stop» during a turn (⏹), «status», «limits», a double send within 10 s, Claude Code commands (`/clear`, `/compact`, `/model`, `/cost`, others — «⌨️ Type in the window»); counted in `/usage`. «🔢 Turn cost» after every turn — a chat setting in `/menu → ⚙️` (off by default) |
| `BOT_LANGUAGE` | `ru` | The default interface language (`ru`, `en`, `es`, `zh`, `fr`, `de`) when neither the chat nor the owner chose one and the user's Telegram language is unknown |
| `TMUX_SESSION` | `claude` | The fallback tmux session for launches without a name of their own (user and project sessions get their own) |
| `JOURNAL_CHAT_ID` | — | A group (id, e.g. `-100…`) for the bot's notices instead of your DM, each kind in its own topic: 📌 Status (one pinned message, kept up to date: all sessions and the limits as in `/usage` — no commands needed), 🛡 Access (bot added to/removed from groups, messages from non-users), 🖥 Sessions, 📊 Limits, 📰 Reports, ⚙️ Daemon. What waits for you — permissions, launches to confirm, users' requests, reminders you asked for — stays in your DM. The group needs topics, and the bot needs to be an admin who can manage them. Switching topics on gives the group a new id — the bot follows it by itself. |
| `STT_PROVIDER` / `TTS_PROVIDER` | `off` | Voice: transcribing incoming messages and spoken replies — see [docs/voice.md](docs/voice.md), install with `bewitched voice install` |
| `CLAUDE_LAUNCH_CMD` | `claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched` | The command for a new session. The bot adds `-n claude-user-<telegram id>` (user session) or `-n claude-project-<group id>-<topic id>` (project, like its folder); each gets its own tmux session and window of that name, so `tmux ls` shows what is what |

Access (pairing, allowlist, groups) works as in the official plugin, see [ACCESS.md](ACCESS.md) and `/telegram-bewitched:access`.

## Development

```
bun install
bun test          # unit + integration tests with a fake Bot API
bunx tsc --noEmit
```

Translations: interface strings are written in Russian as `t('…', { vars })`; dictionaries are in `src/i18n/<lang>.ts`; `bun scripts/i18n-keys.ts missing en` lists untranslated strings, and a test checks that every dictionary is complete.

Layout: `server.ts` — a thin MCP client per session; `src/daemon/` — the daemon (polling, routing, topics, streaming, buttons, tools, HTTP, menus and screens, statistics, reports, reminders); `src/i18n/` — interface languages; `src/voice/` and `voice/*.py` — speech recognition and synthesis; `hooks/` — Claude Code hooks → daemon; `bin/bewitched.ts` — the CLI. Syncing with upstream — [UPSTREAM.md](UPSTREAM.md).

## Token economy

[Configuration, batching, context budgets and measurement](docs/token-economy.md). Owner command: `/economy [fast|balanced|thorough] [model]`.

## Reliable UX

[Delivery tracking, verified Stop, session navigation and result cards](docs/reliable-ux.md).

## Settings and task entry

Settings in `/menu` are grouped by purpose:

- **Chat settings**: language, voice/transcript, reply detail and progress. Apply to subsequent messages immediately. Brief replies do not reduce the work or required verification.
- **Advanced**: streaming, completion notifications, cost display and bot-wide quiet hours.
- **Agent settings**: project model and reasoning effort. Claude Code applies changes between turns without restarting; Codex needs a restart. Switching engines requires a restart.

**New task** or `/task` offers Explain, Fix, Check and Review. A choice applies once to the next message or file, survives daemon restarts and expires after 30 minutes. It is isolated by sender, chat and topic; local status queries do not consume it. `/task cancel` clears the choice.

File receipts show the destination session. A bare file without a selected action or active task waits for an action button, without a model call for clarification. Files with an existing task need no mandatory questionnaire. Task intent does not change permissions, sandboxing or the persistent agent mode.

See [settings and tasks](docs/settings-and-tasks.md) for access rules and limitations.

### Whole-task usage

Result cards include a collapsed report of input, cached input, output, available reasoning tokens, stages, tools, summed duration and engine/model breakdowns. A stable task ID joins follow-ups, retries, handoffs and reviews. A ready result keeps its task open; **Continue task** and **Close task** control its lifecycle. Select **New task** for unrelated work. Late CLI usage updates the card; replaying a result invokes no model. Prices are API estimates, not subscription charges. [Accounting rules and limitations](docs/task-usage.md).

### Lifecycle architecture

Session/task transitions are isolated in a core without Telegram, SQLite or process dependencies. Stop operations use correlation tokens; task records and current-task pointers commit atomically. [Architecture and extension rules](docs/architecture.md).

### Compact result reports

Result cards start with two lines and just **Details** / **Close report**. Details reveals the report and all other actions; **Collapse** folds it again. Closing the report retains the task and original answer. Delayed usage updates and restarts preserve the chosen view.

### Usage report pages

The control panel now prioritizes attention and links to compact reports. Sessions have saved filters and pages. Usage reports share Claude/Codex accounting, explicit rolling/calendar ranges, API-equivalent estimates, on-demand charts and CSV/JSON exports. Scheduled reports retry after failed delivery. Unknown or expired quota data stays unknown. [Behavior and limitations](docs/usage-pages.md).
