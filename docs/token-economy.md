# Token economy / Экономия токенов

The daemon now reduces unnecessary model work without shortening pending user tasks. These controls affect the bridge, not the provider's hidden context or subscription accounting.

## What runs without a model

Existing status, stop, limits, acknowledgements and session-management shortcuts remain local. `ты жив?` is now a status shortcut too. Reply to a specific **bot message** with `повтори`, `повтори ответ`, `пришли ещё раз`, `repeat` or `send again` to copy that message (including a document) within the same chat/topic. Copying a message does not copy an entire multi-message report. Ambiguous requests and failed copies are handed to the model; the daemon never guesses a report or recipient.

Scheduled polling should use a deterministic external script and `/event --no-deliver` for ordinary state changes; wake the model only for actionable failures. Existing note reminders do not wake a session. The daemon does not automatically classify arbitrary natural-language reminders as safe code tasks.

## Batching and duplicate updates

`TEXT_BATCH_MS=700` holds ordinary text from one paired sender in one chat/topic for a fixed 700 ms window. Later messages do not keep extending the deadline. The queue is saved in SQLite and recovered after daemon restart. Different users and topics stay separate. Replies, answers to questions, slash commands, attachments and forwarded-message handling bypass this window. `TEXT_BATCH_MS=0` disables it; maximum 3000 ms.

Stop cancels that sender's queued text before stopping the running turn. A revoked sender's queued text is not dispatched. A routing failure retains the batch for retry. Recovery is **at least once**: a crash after routing succeeds but before removing the queue can replay the batch. This is not a transactional exactly-once guarantee across the CLI/socket boundary.

Successfully handled Telegram update IDs are retained for seven days, scoped by bot ID. A replayed update does not execute a second time; failed handlers remain retryable. The existing ten-second identical-text shortcut is separate from update deduplication.

## Resume context

`RESUME_LAST_N` remains 10. `RESUME_CONTEXT_CHARS=4000` adds a budget for complete history entries (each preview is still at most 400 characters). `0` omits automatic history previews; complete stored history stays available through tools. The budget does not truncate pending tasks or saved memory.

For an explicit known resumed conversation, previously delivered message IDs and unchanged memory are omitted. Receipts are separated by engine, folder and conversation. Before the first conversation hook, receipts are staged and attached to the ID reported by the CLI. If identity is uncertain (including an unconfirmed `--continue`), the daemon sends context rather than guessing. An ordinary MCP reconnect already suppresses a second resume block. Message receipts represent bridge dispatch, not a semantic guarantee that the model processed every character before a crash.

## Tool output

`HISTORY_RESULT_CHARS=6000` bounds get_history/search_messages output and adds a truncation notice. Use narrower queries or get_message for a complete specific message. `0` disables this output cap. File contents and arbitrary shell logs are not silently truncated by the bridge. Shared model instructions now request targeted reads, file-backed large logs, concise summaries and reuse of completed checks.

## Explicit cost/quality choice

Owner-only `/economy` displays today's UTC counters. `/economy fast`, `/economy balanced`, `/economy thorough` set low/medium/high effort for the current project's **next session launch**. They do not restart a session or change its current model. An optional supported model alias/ID explicitly selects a model, for example `/economy fast haiku` for a Claude project. The existing session card remains the UI for engine/model choice.

There is no hidden per-message model switch or automatic downgrade of difficult tasks. For a separate short read-only query use the existing `/once [claude|codex] ...`; its engine/model choice follows the project settings.

## Measurement and limits

`/economy` counts bridge delivery requests, input characters, tool calls/result characters, omitted history/memory characters, merged deliveries, copied/skipped local actions and duplicate updates. Counters are not token estimates, guaranteed saved turns, or money. `/usage` continues to read actual input/cache/output usage from the CLI transcripts. Compare equal workloads with the same engine/model/effort, logging retries and checking result quality.

Provider prompt caching is managed by the CLI/provider; the bridge keeps its common instructions static and does not inject a fresh policy per turn. API cache discounts do not establish subscription-limit savings. No fixed percentage saving is promised.

## Кратко по-русски

- Служебные команды обрабатывает демон; точный ответ на сообщение бота «пришли ещё раз» копирует его без модели.
- Обычные сообщения одного автора объединяются за 700 мс. Очередь переживает перезапуск; команда «стоп» отменяет ещё не отправленный пакет автора.
- Подтверждённое продолжение разговора не получает ту же историю и память повторно; при неизвестном ID контекст сохраняется полностью в рамках бюджета.
- История/поиск ограничены 6000 символами, автоматическая история — бюджетом 4000 символов. Полные сообщения доступны отдельно; задачи из очереди не обрезаются.
- `/economy fast|balanced|thorough [модель]` — явный выбор для следующего запуска. Без аргументов — измерения за текущие сутки UTC. Реальные токены и кеш смотрите в `/usage`.
- Новые настройки применяются после перезапуска демона. Изменённые инструкции модели и effort — после нового запуска сессии. Это два разных перезапуска.
