# Upstream

Форк сделан из `anthropics/claude-plugins-official`, каталог `external_plugins/telegram`, версия 0.0.7, коммит `e3f1dca` («v0.0.7 reliability rollup»). История каталога перенесена через `git subtree split`.

Код официального `server.ts` разнесён по модулям:

| Было в `server.ts` | Стало |
|---|---|
| access.json, gate, pairing, `assertSendable` | `src/access.ts` |
| chunk, safeName | `src/format.ts` |
| polling, PID guard, 409 retry | `src/daemon/daemon.ts` (`startPolling`) + `src/daemon/main.ts` (lock) |
| handlers сообщений, permission relay, команды | `src/daemon/inbound.ts` |
| инструменты reply/react/edit/download | `src/daemon/tools.ts` |
| MCP-сервер, instructions | `server.ts` + `src/client/` |

Подтянуть изменения upstream:

```
git clone https://github.com/anthropics/claude-plugins-official /tmp/cpo
cd /tmp/cpo && git log --oneline e3f1dca..HEAD -- external_plugins/telegram
git diff e3f1dca HEAD -- external_plugins/telegram
```

Изменения переносятся вручную в соответствующие модули по таблице выше, затем обновляется коммит в этом файле.
