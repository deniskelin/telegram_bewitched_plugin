# Telegram — 访问与投递

🌍 [English](ACCESS.md) · [Русский](ACCESS.ru.md) · [Español](ACCESS.es.md) · 中文 · [Français](ACCESS.fr.md) · [Deutsch](ACCESS.de.md)

Telegram 机器人对所有人公开：任何知道其用户名的人都能私聊它，如果没有过滤，这些消息会直接进入您的会话。这里描述的访问模型决定谁能通过。

默认情况下，陌生发送者的私聊会触发**配对**：机器人回复一个 6 位代码并丢弃该消息。您在 Claude Code 会话中运行 `/telegram-bewitched:access pair <代码>` 来批准对方。批准后，其消息即可通过。

所有状态都保存在 `~/.claude/channels/telegram-bewitched/access.json` 中。`/telegram-bewitched:access` 技能的命令会编辑这个文件；服务器在每条传入消息时重新读取它，因此修改无需重启即可生效。设置 `TELEGRAM_ACCESS_MODE=static` 会把配置固定为启动时磁盘上的内容（静态模式下无法配对，因为配对需要在运行时写入）。

## 概览

| | |
| --- | --- |
| 默认策略 | `pairing` |
| 发送者 ID | 数字用户 ID（例如 `412587349`） |
| 群组键 | 超级群组 ID（负数，前缀 `-100…`） |
| `ackReaction` 的限制 | 只能用固定白名单中的表情；其他表情会被静默忽略 |
| 配置文件 | `~/.claude/channels/telegram-bewitched/access.json` |

## 从机器人邀请

所有者（`allowFrom` 中的第一个）也可以不用配对码添加成员：在与机器人的私聊中使用 `/invite`，或在 `/sessions` 中点「👥 邀请」。Telegram 的联系人选择器会返回对方的用户 ID；确认后机器人将其加入 `allowFrom`，准备 `USERS_DIR/<id>` 并启动其会话，创建话题群组的一次性链接（需要机器人有「邀请用户」权限），并给所有者发送一条可转发的消息。`allowFrom` 中的所有人拥有相同的完整权限。在 `static` 模式下需重启后才生效（文件会写入，但快照不会更新）。

移除也一样：在 `/sessions` 中该用户的会话卡片上点「🚫 删除用户」，或使用 `/users`。在列出将删除内容的确认之后，机器人会把对方从 `allowFrom`（及群组列表）中移除，关闭其 tmux 窗口，删除 `USERS_DIR/<id>` 及其 Claude Code 对话记录，并清除其私聊历史、队列、记忆、提醒和设置；还可选择将其移出话题群组（先封禁再解封）。

## 私聊策略

`dmPolicy` 决定如何处理不在 allowlist 中的发送者的私聊。

| 策略 | 行为 |
| --- | --- |
| `pairing`（默认） | 回复配对码并丢弃消息。用 `/telegram-bewitched:access pair <代码>` 批准。 |
| `allowlist` | 静默丢弃，不回复。适合机器人用户名容易被猜到、配对回复可能招来垃圾消息的情况。 |
| `disabled` | 丢弃一切，包括已允许的用户和群组。 |

```
/telegram-bewitched:access policy allowlist
```

## 用户 ID

Telegram 用 `412587349` 这样的**数字 ID** 标识用户。用户名是可选的且可以更改；数字 ID 是永久的。allowlist 中保存的是数字 ID。

配对会自动获取 ID。要手动查找，请对方给 [@userinfobot](https://t.me/userinfobot) 发消息，它会回复其 ID。把对方的任意消息转发给 @userinfobot 也可以。

```
/telegram-bewitched:access allow 412587349
/telegram-bewitched:access remove 412587349
```

## 群组

群组默认关闭，需要逐个启用。

```
/telegram-bewitched:access group add -1001654782309
```

超级群组 ID 是带 `-100` 前缀的负数，例如 `-1001654782309`，在 Telegram 界面中看不到。要查找它，可以临时把 [@RawDataBot](https://t.me/RawDataBot) 加入群组（它会输出包含聊天 ID 的 JSON），或者加入您的机器人：它会把群组 ID 和现成的命令发给所有者；`/telegram-bewitched:access` 也会显示最近消息被丢弃的群组。

默认 `requireMention: true` 时，机器人只在被 @ 提及或被回复时响应。`--no-mention` 处理所有消息，`--allow id1,id2` 限制哪些成员可以触发它。

```
/telegram-bewitched:access group add -1001654782309 --no-mention
/telegram-bewitched:access group add -1001654782309 --allow 412587349,628194073
/telegram-bewitched:access group rm -1001654782309
```

**群组即项目。** 已允许的群组（话题群组除外）可以绑定到项目文件夹。群组发来第一条消息（或机器人被加入群组）时，所有者会在私聊中收到卡片：在 `PROJECTS_DIR` 中新建项目、选择现有文件夹，或「不是项目」（与以前一样由主会话回复）。已绑定群组的消息会交给该项目的会话，并由它在群组中回复；该会话的权限请求只发到所有者私聊。解绑：会话卡片上的「👥 解绑群组」或「/menu → 👥 群组」。绑定不会带来额外权限：谁可以发消息仍由此文件决定。

**Privacy mode。** Telegram 机器人默认开启 privacy mode：Telegram 服务器会在消息到达您的代码之前过滤群组消息，只投递 @ 提及和回复。这与 `requireMention: true` 一致，所以通常察觉不到。使用 `--no-mention` 需要同时关闭 privacy mode：给 [@BotFather](https://t.me/BotFather) 发送 `/setprivacy`，选择您的机器人，点 **Disable**。不做这一步，无论本地如何配置，Telegram 都不会投递这些消息。

## 提及检测

在 `requireMention: true` 的群组中，以下任意一种都会触发机器人：

- 结构化的 `@机器人用户名` 提及；
- 回复机器人的某条消息；
- 匹配 `mentionPatterns` 中的任一正则表达式。

```
/telegram-bewitched:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## 投递

用 `/telegram-bewitched:access set <键> <值>` 配置外发行为。

**`ackReaction`** 在收到消息时对其添加反应。Telegram 只接受**固定白名单**中的反应表情，其他表情会被静默忽略。Bot API 的完整列表：

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram-bewitched:access set ackReaction 👀
/telegram-bewitched:access set ackReaction ""
```

**`replyToMode`** 控制长回复被拆分时的引用方式：`first`（默认）只有第一段作为对传入消息的回复；`all` 每段都是回复；`off` 所有段都单独发送。

**`textChunkLimit`** 设置拆分阈值。Telegram 拒绝超过 4096 个字符的消息。

**`chunkMode`** 选择拆分方式：`length` 严格按阈值切分；`newline` 优先在段落处切分。

## 命令参考

| 命令 | 作用 |
| --- | --- |
| `/telegram-bewitched:access` | 显示当前状态：策略、allowlist、待配对、已启用的群组。 |
| `/telegram-bewitched:access pair a4f91c` | 批准代码 `a4f91c`。把发送者加入 `allowFrom` 并在 Telegram 上发送确认。 |
| `/telegram-bewitched:access deny a4f91c` | 丢弃待处理的代码。不会通知发送者。 |
| `/telegram-bewitched:access allow 412587349` | 直接添加用户 ID。 |
| `/telegram-bewitched:access remove 412587349` | 从 allowlist 中移除。 |
| `/telegram-bewitched:access policy allowlist` | 设置 `dmPolicy`：`pairing`、`allowlist`、`disabled`。 |
| `/telegram-bewitched:access group add -1001654782309` | 启用群组。参数：`--no-mention`（还需关闭 privacy mode）、`--allow id1,id2`。 |
| `/telegram-bewitched:access group rm -1001654782309` | 停用群组。 |
| `/telegram-bewitched:access set ackReaction 👀` | 设置配置项：`ackReaction`、`replyToMode`、`textChunkLimit`、`chunkMode`、`mentionPatterns`。 |

## 配置文件

`~/.claude/channels/telegram-bewitched/access.json`。文件不存在时，等同于列表为空的 `pairing` 策略：第一条私聊会触发配对。

```jsonc
{
  // 如何处理不在 allowFrom 中的发送者的私聊。
  "dmPolicy": "pairing",

  // 允许私聊的数字用户 ID。
  "allowFrom": ["412587349"],

  // 机器人启用的群组。空对象 = 仅私聊。
  "groups": {
    "-1001654782309": {
      // true：只响应 @ 提及和回复。
      // false 还需要通过 BotFather 关闭 privacy mode。
      "requireMention": true,
      // 限制可触发机器人的发送者。空 = 任何成员（受 requireMention 约束）。
      "allowFrom": []
    }
  },

  // 视为提及的正则表达式（不区分大小写）。
  "mentionPatterns": ["^hey claude\\b"],

  // Telegram 固定白名单中的表情。空字符串表示关闭。
  "ackReaction": "👀",

  // 拆分回复时的引用方式：first | all | off
  "replyToMode": "first",

  // 拆分阈值。Telegram 拒绝 > 4096。
  "textChunkLimit": 4096,

  // length = 按阈值切分；newline = 优先按段落切分。
  "chunkMode": "newline"
}
```
