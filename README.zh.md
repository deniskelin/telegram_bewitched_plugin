# telegram-bewitched

🌍 [English](README.md) · [Русский](README.ru.md) · [Español](README.es.md) · 中文 · [Français](README.fr.md) · [Deutsch](README.de.md)

**在 Telegram 中操控 Claude Code。** 您给机器人发消息——回复您的是运行在您自己服务器上、能访问您项目的 Claude Code。每个项目在群组中有自己的话题，每个人有自己的会话。可以实时看到 Claude 在做什么，用按钮批准权限，发送语音消息，并在 `/usage` 中查看额度与消耗。

从技术上讲，它是 Claude Code 的*频道*（channels）插件——频道让外部来源把消息推送到正在运行的会话中。它是[官方 telegram 插件](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)的分支，提供共享守护进程、论坛超级群组中的项目话题、实时进度、回答按钮，以及重启后依然保留的历史记录。

需求文档：[docs/TZ.md](docs/TZ.md)（俄文）。阶段 0–9 已完成，包括语音（自 1.2.0 起）。需求之外还有：`/menu` 控制面板、订阅额度与消耗、带图表的报告、提醒、在 Telegram 中控制 tmux 窗口和 git、邀请与移除成员、六种语言的界面。更新内容见 [CHANGELOG.md](CHANGELOG.md)。

## 工作原理

```
Telegram：私聊、群组话题
        │ Bot API（一个机器人）
        ▼
bewitched 守护进程（每台服务器一个）：轮询、路由、队列、历史（SQLite）、
                                      控制面板、提醒、额度、语音
        │ unix socket                       ▲ Claude Code 钩子：进度、「完成」
        ▼                                   │
tmux 中的 Claude Code 会话：👤 每人一个（~/user/<id>）· 📂 每个项目一个（对应其话题）
```

- 消息会交给负责该聊天的会话：私聊交给发送者自己的会话，话题交给该项目的会话。如果会话未运行，守护进程会在 tmux 中启动它，并在其连接后送达消息。
- 会话通过插件的工具（`reply`、`ask_user` 等）回复；工作期间守护进程会显示进度。
- 会话以开发频道标志启动，因此每次启动需要确认一次——机器人会提供「✅ 确认启动」按钮。

## 与官方插件的区别

| 功能 | 官方 `telegram` 0.0.7 | `telegram-bewitched` |
|---|---|---|
| 文字、图片、文件、语音消息（作为附件） | ✅ | ✅ |
| 配对、allowlist、需要提及的群组 | ✅ | ✅ |
| 用按钮授权工具 | ✅ 私聊中 | ✅ 在项目话题或私聊中（`PERMISSIONS_TO`）；「♾ 本会话中」和「📌 本项目中」永久允许 |
| 一个机器人上运行多个 Claude 会话 | ❌ 409 Conflict，第二个会话「失声」 | ✅ 共享的轮询守护进程，会话通过 socket 注册 |
| 频道旁的 `claude -p` / 子代理 | ❌ 启动自己的轮询并弄崩频道 | ✅ 被动会话不触碰传入消息 |
| 与其他轮询进程冲突 | 静默 409 | ✅ 等待，并私信通知所有者 |
| 话题 | ❌ | ✅ 论坛超级群组，每个项目一个话题，在私聊中用 `/connect_group` 连接 |
| 控制面板 | ❌ | ✅ General 中的置顶摘要，`/sessions`、`/topics`、`/send`、`/broadcast`、`/rename`、`/archive`、`/delete`、`/main` |
| 从 Telegram 新建会话 | ❌ | ✅ 新建话题 → 项目文件夹 + 在 tmux 窗口中运行的 Claude；`/new_session` |
| 会话与话题归档 | ❌ | ✅「🗄 归档」关闭会话和话题；重新打开话题会再次启动会话 |
| 实时进度 | ❌ 仅 5 秒的「正在输入」 | ✅ 私聊中带「思考」的草稿（Bot API 10.2），话题中不断更新的「⏳ 工作中…」及操作，`/verbose 0\|1\|2` |
| 从 Telegram 停止一轮 | ❌ | ✅「⏹ 停止」按钮（向 tmux 发送 Escape） |
| 回答按钮 | ❌ | ✅ `ask_user`、`reply(buttons)`、多选、超时 |
| 富文本消息（Markdown：表格、代码、列表） | ❌ 只有需要手动转义的 MarkdownV2 | ✅ `format: "rich"`（Bot API 10.1），失败时回退为纯文本 |
| 无传入消息时主动发消息（完成、出错） | ❌ | ✅ `notify`、长任务后自动「✅ 完成」、`bewitched notify`、HTTP `/notify` |
| 聊天历史 | ❌ Bot API 不保存历史 | ✅ SQLite + 全文搜索：`get_history`、`search_messages`、`get_message` |
| 回复上下文、引用、转发 | ❌ 只有消息文字 | ✅ `reply_to_text`、`quote_text`、`forward_from`、批量转发 |
| 重启之间的记忆 | ❌ | ✅ `save_memory`，会话连接时提供摘要和最近历史 |
| 会话关闭时收到的消息 | ❌ 丢失 | ✅ 保存，并在会话启动时送达 |
| 用户权限 | allowlist 中的所有人，私聊中 | ✅ allowlist 中的所有人与所有者权限相同，话题群组中也是；陌生人被忽略 |
| 识别会话所在的 tmux | — | ✅ 通过环境变量或 Claude 进程的终端 |
| 语音消息 | 无文字的附件 | ✅ 本地 faster-whisper 转写，语音回复（Silero/Piper/云端）——[docs/voice.md](docs/voice.md) |
| 额度与消耗 | ❌ | ✅ `/usage`：订阅额度百分比、按 API 价格计算的费用、阈值与重置通知、每日总结、带图表的报告 |
| 在 Telegram 中操作会话窗口和 git | ❌ | ✅「✅ 确认启动」、「👁 屏幕与按键」（还可实时刷新 ▶️）、🧹 `/compact`、🆕 `/clear`、🧠 模型、🕘 过往对话、🌿 状态、提交、PR 和 diff |
| 外部事件与 CI | ❌ | ✅ `/event` 和 `bewitched event` → 项目话题与会话；失败的 GitHub Actions 附「🛠 修复」按钮 |
| 快捷命令 | ❌ | ✅ `/macro`：自定义按钮，把文字发给本聊天的会话 |
| 提醒 | ❌ | ✅ `/remind` 和 `remind` 工具，一次性或每天 |
| 成员 | 仅配对码 | ✅ 从通讯录 `/invite`，`/users`，连同全部数据一起移除 |
| 普通群组 | 通过主会话 | ✅ 无话题的群组 = 一个项目：在所有者私聊中绑定，其会话在群组中回复 |
| 界面语言 | 英语 | ✅ 俄语、英语、西班牙语、中文、法语、德语——`/lang`，默认跟随 Telegram 语言 |
| 测试 | ❌ | ✅ 基于模拟 Bot API 的单元测试和集成测试 |

## 功能

| | |
|---|---|
| **共享守护进程** | 一个进程为所有会话轮询 Telegram。多个 Claude Code 会话和 `claude -p` 共用一个机器人，不会出现 409 Conflict。 |
| **话题** | 在私聊中连接论坛超级群组（`/connect_group`），每个项目获得自己的话题。General 中有置顶的控制面板和控制命令。 |
| **会话类型** | 👤 每个用户一个会话（其私聊和其在 General 中的消息），📂 每个项目一个会话（在其话题中）。会话在收到第一条消息时自动启动；看门狗会报告停止的会话并提供重启按钮。 |
| **实时进度** | Claude 工作时：私聊中是带「思考」块的原生草稿；话题中是不断更新的「⏳ 工作中…」消息，附操作列表和 **⏹ 停止** 按钮（通过 tmux 中断本轮）。 |
| **回答按钮** | `ask_user` 工具和 `reply(buttons)`：点按选项，答案返回会话。 |
| **由话题创建项目** | 在群组中新建话题 → 创建 `~/projects/<名称>` 文件夹，并在绑定该话题的 tmux 窗口中启动新的 Claude 会话。或用 `/new_session <名称\|路径>`。启动用「✅ 确认启动」按钮确认。 |
| **归档** | `/sessions` 中项目卡片上的「🗄 归档」：会话结束、话题关闭。重新打开话题——启动新会话。在 Telegram 中关闭话题等同于归档。 |
| **通知** | 无传入消息时的 `notify`、长任务后自动「✅ 完成」、供脚本和 CI 使用的 `bewitched notify` 与 HTTP `/notify`。 |
| **`/menu` 面板** | 一条消息里的按钮涵盖一切：会话、话题、统计、人员、提醒、本聊天设置、帮助。Telegram 命令菜单中只显示 `/menu`、`/sessions`、`/usage`、`/help`。 |
| **会话控制** | 启动消息中的「✅ 确认启动」——无需终端。`/sessions` 中的卡片：带按键的 tmux 窗口快照（▶️——自动刷新一分钟）、🧹 `/compact`、🆕 `/clear`、🧠 切换模型、🕘 过往对话（在同一会话中 `/resume`）、⚡ 快捷命令、🌿 git（状态、提交、PR、以文件发送 diff）、针对某个工具的「♾ 本会话中始终允许」和「📌 本项目中始终允许」、上下文将满时的提醒。 |
| **外部事件** | `bewitched event --topic <名称> "文字"` 或 `POST /event`——在项目话题中发出「📡」消息，并交给其会话。机器人每 5 分钟查看每个项目会话所在分支最近一次 GitHub Actions 运行：失败时发「❌ CI 失败」并附「🛠 修复」，恢复通过时发「✅」。 |
| **语音** | 语音消息和视频消息在本地转写；对语音消息用语音回复。俄语语音会用俄语读出数字、时间、日期和拉丁字母单词。声音和语速按聊天设置。 |
| **统计** | `/usage`——额度百分比及重置时间和进度条，按模型和会话的消耗；在 80/95% 时及重置的那一刻发送通知（🔔/🔕）；「🌙 每日总结」；`/reports`——日、周、月报告并附图表；会话卡片上显示其费用；`/server`——机器负载、守护进程日志和一键重启；👥 每个人在 5 小时窗口中用了多少，有人超过 `USER_SHARE_ALERT` 时发出通知。🌙 免打扰时段——夜间静音。 |
| **提醒** | `/remind 2h 检查 CI`、「tomorrow 9:00」、「every day 9:00」；到时文字会发到聊天并交给其会话；会话未运行时会被启动。 |
| **人员** | `/invite`——选择联系人，机器人授予访问权限、启动其会话并提供群组链接；`/users` 和 🚫——连同会话、文件夹、对话记录和历史一起移除某人。通过 `/telegram-bewitched:access` 添加的人会被守护进程自动接入。 |
| **群组即项目** | 在 access 中允许的普通群组（无话题）可成为项目：所有者在私聊中收到卡片——新项目、现有文件夹或「不是项目」。其会话在群组中回复，从所有者私聊中管理。 |
| **语言** | 机器人界面支持 6 种语言：ru、en、es、zh、fr、de。聊天语言可用 `/lang` 或「/menu → ⚙️」中的旗帜设置；私聊默认使用用户的 Telegram 语言，否则使用 `BOT_LANGUAGE`。Telegram 命令菜单跟随应用语言。 |
| **历史与记忆** | 带全文搜索的 SQLite，每条消息附带回复/引用/转发上下文，`get_history`、`search_messages`，聊天记忆 `save_memory`，会话连接时的摘要，会话关闭期间收到的消息会补发。 |

## 环境要求

- [Bun](https://bun.sh) ≥ 1.2。
- 支持 channels 和 `MessageDisplay` 钩子的 Claude Code。
- tmux——用于自动启动会话、「⏹ 停止」按钮、「👁 屏幕与按键」以及在会话窗口中输入命令（没有 tmux 时，「停止」只会通知模型）。
- 可选：`gh`（「🌿 Git」中的 PR、CI 监控），ffmpeg 和 Python 3（语音，用 `bewitched voice install` 安装）。

## 安装

1. 在 [@BotFather](https://t.me/BotFather) 创建机器人（`/newbot`）并复制令牌。
2. 在 Claude Code 中：

```
/plugin marketplace add deniskelin/telegram_bewitched_plugin
/plugin install telegram-bewitched@bewitched
/telegram-bewitched:configure <令牌>
```

   如果之前装过官方插件，首次启动时会自动从 `~/.claude/channels/telegram/` 复制 `.env` 和 `access.json`。
3. 启动带频道的会话（见「运行」），在私聊中给机器人发消息——它会回复一个 6 位代码——然后在 Claude Code 中运行 `/telegram-bewitched:access pair <代码>`。第一个配对的用户成为所有者。详见 [ACCESS.md](ACCESS.md)（英文）。

**官方插件和本分支不能同时轮询同一个令牌。** 请禁用官方插件（`/plugin disable telegram@claude-plugins-official`），或运行 Claude 时不带它的 `--channels`。如果守护进程发现官方插件正在用同一个令牌运行，它会等待，而不是争抢轮询。

## 运行

在 research preview 期间，第三方频道通过开发标志加载（会出现确认界面，需要接受）：

```
tmux new -s claude
claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched
```

第一个会话会启动守护进程。会话关闭后它仍继续运行，因此控制面板和 `/notify` 始终可用。

命令行命令需在插件文件夹中运行：从市场安装后，该文件夹是 `~/.claude/plugins/cache/bewitched/telegram-bewitched/<版本>/`（或仓库的克隆）。

```
cd ~/.claude/plugins/cache/bewitched/telegram-bewitched/<版本>
bun bin/bewitched.ts daemon status|stop|restart|logs
bun bin/bewitched.ts daemon install-cron     # 在 crontab 中添加 @reboot
bun bin/bewitched.ts voice install           # 语音，见 docs/voice.md
bun bin/bewitched.ts notify --topic myproj "构建失败"
bun bin/bewitched.ts event --topic myproj --source ci "部署失败：…"   # 发到项目话题和会话
```

## 更新

```
claude plugin marketplace update bewitched
claude plugin update telegram-bewitched@bewitched
```

然后重启 Claude Code 会话（客户端和钩子来自新版本），并在**新**版本的文件夹中重启守护进程：`bun bin/bewitched.ts daemon restart`。`/server` 中的「♻️ 重启守护进程」按钮重启的是当前正在运行的版本。如果用过 `install-cron`，请在新文件夹中再运行一次——旧记录会被替换。

## 超级群组中的话题

1. 在与机器人的私聊中：`/connect_group`。
2.「➕ 把机器人加入群组」→ 选择已启用「话题」的群组 → 确认管理员权限（管理话题、置顶、删除）。
3. 在私聊中确认连接。

机器人 allowlist 中的所有人都可以给会话发消息并管理它们（按钮、面板、归档、权限）——所有已配对用户拥有相同的完整权限。群组其他成员会被忽略。Telegram 的原生草稿只在私聊中可用，因此在话题中进度以不断更新的消息显示。

`/sessions` 是像 BotFather 那样的单消息菜单：会话列表，每个会话一个按钮；按钮打开会话卡片，包含操作（⏹ 停止、👑 设为主会话、🗄 归档、💬 打开话题）和其聊天的设置（🔕0/🔔1/📢2 和「✅ 完成」）；「« 返回列表」返回。`/topics` 是同样的话题菜单：每个话题的状态（会话、💤 无会话、队列），话题页面有 💬 打开、📋 会话卡片、🚀 启动会话、🗄 归档 / ↩️ 恢复、🗑 删除；归档单独一页。「👁 屏幕与按键」（在卡片和启动消息中）发送 tmux 窗口的当前画面，附 1/2/3、Enter、Esc、↑/↓、Tab 按钮——无需 `tmux attach` 就能回答窗口中的任何问题。「🌿 Git」显示状态、最近提交和分支的 PR（通过 `gh`）；「📄 以文件发送 diff」发送 `git diff HEAD`。权限请求下方有「♾ 本会话中始终允许 <工具>」（直到会话重新连接；可在卡片中重置）和「📌 本项目中始终允许 <工具>」（机器人按项目文件夹保存规则；可在卡片中移除）。🧹 `/compact`、🆕 `/clear` 和 🧠 模型按钮会在会话窗口中输入命令（仅在两轮之间）。卡片显示：类型（👑 主会话或项目会话）、状态、`#id` 和 pid、工作目录、分支、话题、在 tmux 中的位置（会话、窗口、窗格）及现成的 `tmux attach -t <会话>:<窗口>`、能否「⏹ 停止」、权限模式、模型和上下文大小、当前一轮和最后一个操作、`claude --resume <id>` 命令、`/rename` 名称、📱 Remote Control 是否开启及 claude.ai 上的会话链接（根据对话记录中的 `remote_session_change` 事件；在第一次该事件之前，根据 `--remote-control`/`--rc` 标志或 `remoteControlAtStartup`），以及启动以来和最后一次活动以来的时间。未带频道标志启动的会话单独列在「👻 无频道」中，并附重启命令：它们收不到消息，以前也看不到。

以下所有功能在 **`/menu`** 中都有按钮（Telegram 命令菜单只有 `/menu`、`/sessions`、`/usage`、`/help`）。控制命令（私聊或 General）：`/sessions`、`/topics`、`/permissions`（所有会话中待处理的权限请求）、`/send <话题> <内容>`、`/broadcast <内容>`、`/rename <话题> | <名称>`、`/archive <话题>`、`/delete <话题>`、`/new_session <名称|路径>`。任何聊天中：`/verbose [0|1|2]`（🔕0 仅回答，🔔1 + 操作，📢2 + 模型文字；不带参数时显示当前级别）、`/notify_done [off|long|always]`、`/lang ru|en|es|zh|fr|de|auto`、`/remember`、`/forget`、`/voice off|mirror|always`、`/transcript on|off`、`/macro add <按钮> | <文字>` 和 `/macro del <n>`（本聊天的快捷命令）、`/remind <时间> <内容>`（30m、1h30m、«in 2 hours»、18:30、«tomorrow 9:00»、«every day 9:00»；也支持俄语写法；到时文字会发到聊天并交给该聊天的会话，会话未运行时会被启动）、`/reminders`。详细级别显示在会话卡片中（📣 行），可在那里用按钮修改，也显示在「⏳ 工作中… · 🔔1」标题中。私聊中：`/server`（CPU、内存、磁盘、Claude Code 和语音进程；「📜 守护进程日志」、「♻️ 重启守护进程」）、`/users`（所有有权限的人；🚫 删除用户：访问权限、会话和 tmux 窗口、文件夹、对话记录和私聊历史——需确认）、`/invite`（邀请用户：选择联系人 → 确认 → 机器人授予访问权限、启动其会话并发送一条可转发的邀请）、`/usage`、`/digest`、`/reports`（日、周、月报告，附按小时/天/周的消耗图表和统计；每种报告可用按钮单独开启，在周期结束时发送）、`/main [id|reset]`、`/group`、`/disconnect_group`、`/status`。

`/usage`（仅所有者）：来自 `~/.claude/.credentials.json` 的订阅计划、额度百分比（5 小时、一周）及重置时间，以及按 API 价格计算的所有对话记录中 5 小时、一天和 7 天的 token 消耗，按模型和会话细分。百分比来自 Anthropic **未公开文档**的端点 `api/oauth/usage`（Claude Code 中的 `/usage` 调用的就是它），使用订阅的 OAuth 令牌。它可能在任何一次更新后失效，届时 `/usage` 只显示本地数据。`USAGE_LIMITS=off` 关闭该请求。「谁在消耗」「按模型」「按会话」三部分按按钮选择的周期显示：5 小时、一天、一周或一个月（5 小时和一周时「谁在消耗」显示占订阅窗口的比例，否则显示占消耗的比例）。

## 普通群组作为项目

没有话题的群组也可以是一个独立项目——比如关于某个网站的家庭群，关于某个服务的工作群。

1. 把机器人加入群组，并在终端中允许它：`/telegram-bewitched:access group add <id>`（加入时机器人会把 id 告诉您；在此之前它在群里保持沉默）。默认机器人只在被提及时回复——`--no-mention` 可关闭此限制（还需在 @BotFather 关闭 privacy mode，见 [ACCESS.md](ACCESS.md)）。
2. 群组发来第一条消息时，所有者会在私聊中收到卡片：「📁 新建」（`~/projects/<群组名>`）、「📂 选择项目」（现有文件夹）或「🚫 不是项目」（与以前一样由主会话回复）。在此期间群组中的消息在队列中等待。
3. 项目会话在 tmux 中启动（在您私聊中点「✅ 确认启动」确认），直接在群组中回复并在那里显示进度。它没有话题。

其他一切都在所有者私聊中完成：`/sessions` 中的会话卡片（带「👥 解绑群组」）、「/menu → 👥 群组」中的列表。群组会话的权限请求只发给所有者。提醒、`/macro`、`/event` 和 CI 通知在群组中与在话题中一样可用。

## 会话类型

机器人面向 allowlist 中的一小群自己人（比如家人）。每人有自己的 Claude 会话；项目放在群组的话题中。

| | 文件夹 | 接收内容 |
|---|---|---|
| 👤 **用户会话** | `~/user/<user_id>`（`USERS_DIR`） | 该用户的私聊及其在 General 中的消息；也在那里回复 |
| 📂 **项目会话** | 项目文件夹 | 自己的话题 |
| 👑 **主会话** | `MAIN_DIR`（默认 `~`） | 仅当 `USER_SESSIONS=off`（所有人的私聊和 General，与 1.0 相同）或作为 `TOPIC_NO_SESSION=main` 的备用 |

日常事务由守护进程自己完成，不需要 Claude：控制命令、关闭和打开话题、启动会话、看门狗。

- **用户会话自动启动。** 用户的第一条消息 → 守护进程创建 `~/user/<id>`，在新的 tmux 窗口（`TMUX_SESSION`，如果之前已有对话则带 `--continue`）中启动 Claude；消息在队列中等待，会话连接后送达。
- **没有会话的项目话题**（`TOPIC_NO_SESSION=launch`）：消息会启动项目会话。如果启动失败，机器人会发出手动启动的命令，并在会话连接前关闭话题。
- **看门狗。** 会话自行退出（不是归档也不是超时）→ 一分钟后机器人在其聊天中发「⚠️ 会话 … 已停止」，附重启命令和「🚀 启动」按钮。项目话题会在会话重新连接前关闭。
- **关闭空闲会话：** `USER_IDLE_MIN` 和 `PROJECT_IDLE_MIN`，默认 `0`——从不关闭。空闲会话不消耗 token，只占内存。

### 需要手动完成的事

1. **确认每次会话启动。** 在 Claude Code 频道处于 research preview 期间，用 `--dangerously-load-development-channels` 启动会显示警告界面。机器人不会自行接受：启动消息中有「✅ 确认启动」按钮——点按后机器人会依次回答启动问题（新文件夹的信任确认「Yes, I trust this folder」以及「I am using this for local development」），等待会话连接，然后把屏幕替换为「✅ 会话已连接」。其他任何问题都留给您处理——「👁 屏幕与按键」（附「✖️ 关闭」）或 `tmux attach -t claude:<窗口>`。新用户发第一条消息时、服务器重启后、会话崩溃后以及每次空闲关闭后（如已启用）都需要确认。
2. **在服务器上保留 tmux。** 没有它，会话无法自动启动——机器人会发来手动启动的命令。
3. **重启已停止的会话**——用看门狗通知中的「🚀 启动」按钮（并再次确认），或使用通知中的命令。

### 不足之处

- 每次启动都需要点按确认（见上文）；在有人点按之前，用户需要等待回复。
- 每个会话都是一个独立的 Claude Code 进程：约 350–450 MB 内存，且都消耗同一账号的额度。
- 隔离仅限于上下文和记忆：所有会话以同一个系统用户运行，能看到整台机器、彼此的文件以及共享的 `~/.claude`。对家庭而言这是有意的选择，而不是安全边界。
- 群组中所有人都能看到 General 中的回答；如果用户本人要求，其会话可能在那里引用其私聊中的内容。
- 在终端中有意执行 `/exit` 后也会收到看门狗通知——从外部无法与崩溃区分。
- `--continue` 会继续该文件夹中最近的对话，包括在其中手动启动的对话。

`USER_SESSIONS=off` 恢复 1.0 的行为：所有人的私聊和 General 都交给 `MAIN_DIR` 中的主会话；`/main <id>`、`/main reset` 和 `/sessions` 卡片中的「👑 设为主会话」可以重新指定它。

## 设置（`~/.claude/channels/telegram-bewitched/.env`）

| 变量 | 默认值 | |
|---|---|---|
| `TOPIC_MODE` | `project` | `project`——每个项目一个话题，`session`——每个会话一个，`off` |
| `PERMISSIONS_TO` | `topic` | 权限请求发往何处：`topic`、`dm`、`both` |
| `STOP_MODE` | `interrupt` | `interrupt`（向 tmux 发送 Escape）、`notify`、`off` |
| `PROGRESS_FINAL` | `delete` | 回答后如何处理进度消息：`delete`、`keep` |
| `NOTIFY_LONG_SEC` | `60` | 自动通知的「长任务」阈值 |
| `DAEMON_IDLE_EXIT_MIN` | `0` | 无会话 N 分钟后停止守护进程（0——从不） |
| `BEWITCHED_HTTP_PORT` | `8797` | 本地 HTTP（钩子、`/notify`、`/event`），仅 127.0.0.1，令牌在 `http.token` |
| `HISTORY_MAX_DAYS` | `90` | 历史保存期限 |
| `PASSIVE_TOOLS` | `false` | 允许无频道会话（`claude -p`）使用工具 |
| `TOPIC_PROJECTS` | `auto` | 所有者创建的话题 → 项目和会话：`auto`、`ask`（按钮）、`off` |
| `PROJECTS_DIR` | `~/projects` | 项目文件夹的创建位置 |
| `USER_SESSIONS` | `on` | allowlist 中每个用户一个会话；`off`——与 1.0 相同（全部交给主会话） |
| `USERS_DIR` | `~/user` | 用户会话文件夹所在位置（`<USERS_DIR>/<user_id>`） |
| `USER_IDLE_MIN` | `0` | 用户会话空闲 N 分钟后关闭（0——从不） |
| `PROJECT_IDLE_MIN` | `0` | 项目会话空闲 N 分钟后关闭（0——从不） |
| `TOPIC_NO_SESSION` | `launch` | 没有会话的项目话题：`launch`——启动会话，`main`——由主会话回答，`queue`——只排队 |
| `WATCHDOG_GRACE_SEC` | `60` | 会话停止后多少秒发出通知 |
| `MAIN_DIR` | `~` | 主会话的文件夹（`USER_SESSIONS=off` 时负责私聊和 General） |
| `CONTEXT_WINDOW` | `1000000` | 会话卡片中计算上下文占用百分比的窗口大小 |
| `CONTEXT_WARN_PCT` | `80` | 上下文占用达到此值时，在会话聊天中建议 `/compact`（0——从不） |
| `DIGEST_AT` | `21:00` | 何时给所有者发送「🌙 每日总结」（消耗、提交、额度）；`off`——不发送。按需：`/digest` |
| `LIMIT_ALERTS` | `80,95` | 订阅额度通知阈值（百分比）；`off`——不通知。越过阈值的窗口会在重置的那一刻收到「✅ token 已恢复」；在 `/usage` 中也可以用 🔔 为任意窗口订阅 |
| `LIMIT_CHECK_MIN` | `10` | 检查额度的频率（分钟，0——从不） |
| `USAGE_LIMITS` | `on` | `/usage`：向 Anthropic 未公开文档的端点请求额度百分比（`off`——只用本地数据） |
| `USER_SHARE_ALERT` | `40` | 当其他用户占用 5 小时窗口达到此百分比时通知所有者（每个窗口一次；0——从不）。与 `LIMIT_ALERTS` 一起生效 |
| `CI_WATCH_MIN` | `5` | 查看项目会话分支最近一次 GitHub Actions 运行的频率（通过 `gh`；0——从不） |
| `QUIET_HOURS` | `off` | 免打扰时段，例如 `23:00-08:00`：机器人发送的一切都静音送达。「/menu → ⚙️」中的按钮优先于 `.env` |
| `BOT_LANGUAGE` | `ru` | 默认界面语言（`ru`、`en`、`es`、`zh`、`fr`、`de`），在聊天和所有者都未选择、且不知道用户 Telegram 语言时使用 |
| `TMUX_SESSION` | `claude` | 新窗口所在的 tmux 会话 |
| `STT_PROVIDER` / `TTS_PROVIDER` | `off` | 语音：转写传入消息和语音回复——见 [docs/voice.md](docs/voice.md)，用 `bewitched voice install` 安装 |
| `CLAUDE_LAUNCH_CMD` | `claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched` | 启动新会话的命令。机器人会追加 `-n claude-<telegram id>`（用户会话）或 `-n claude-topic-<话题>`（项目）；tmux 窗口使用相同名称 |

访问控制（配对、allowlist、群组）与官方插件相同，见 [ACCESS.md](ACCESS.md)（英文）和 `/telegram-bewitched:access`。

## 开发

```
bun install
bun test          # 基于模拟 Bot API 的单元测试 + 集成测试
bunx tsc --noEmit
```

翻译：界面字符串以俄语写成 `t('…', { 变量 })`；词典位于 `src/i18n/<语言>.ts`；`bun scripts/i18n-keys.ts missing zh` 列出未翻译的字符串，测试会检查所有词典是否完整。

结构：`server.ts`——每个会话一个轻量 MCP 客户端；`src/daemon/`——守护进程（轮询、路由、话题、流式输出、按钮、工具、HTTP、菜单与界面、统计、报告、提醒）；`src/i18n/`——界面语言；`src/voice/` 和 `voice/*.py`——语音识别与合成；`hooks/`——Claude Code 钩子 → 守护进程；`bin/bewitched.ts`——命令行工具。与上游同步——[UPSTREAM.md](UPSTREAM.md)。
