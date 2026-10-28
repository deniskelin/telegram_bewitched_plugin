# Голос: расшифровка входящих (STT) и ответы голосом (TTS)

Всё работает локально на сервере: аудио и текст никуда не уходят, если вы сами не укажете облачный адрес.

## Установка

```bash
apt-get install ffmpeg            # обязателен для обоих направлений
bun bin/bewitched.ts voice install    # или: voice install stt / voice install tts
bun bin/bewitched.ts daemon restart
```

`voice install` создаёт в `~/.claude/channels/telegram-bewitched/voice`:

| Что | Где | Размер |
|---|---|---|
| faster-whisper (`large-v3-turbo`, int8, CPU) | `stt-venv`, модель в `hf/` | ~1,6 ГБ |
| Silero TTS (`v4_ru`, torch CPU) | `silero-venv`, модель в `torch/` | ~1–2 ГБ |

и дописывает в `.env` недостающие ключи: `STT_PROVIDER=openai-compatible`, `STT_LOCAL=true`, `STT_URL=http://127.0.0.1:8178/v1/audio/transcriptions`, `TTS_PROVIDER=silero`, `TTS_VOICE=xenia`.

Демон сам запускает оба сервиса (`voice/stt_server.py`, `voice/silero_server.py`) как дочерние процессы на `127.0.0.1`: распознавание — при старте демона (модель прогревается заранее), синтез — при первом голосовом ответе; Silero останавливается после `TTS_IDLE_MIN` минут простоя (30). Логи: `voice/logs/stt.log`, `voice/logs/silero.log`.

## Скорость на CPU

Whisper обрабатывает аудио окнами по 30 с, поэтому короткое голосовое стоит почти как 30-секундное. Замер на Xeon E5-2650L v4 (1,7 ГГц, AVX2, 14 потоков), int8, `beam_size=1`:

| Модель | `STT_LANGUAGE=ru` | язык авто |
|---|---|---|
| `small` | 2,5 с | 3,5 с |
| `medium` | 6,0 с | 9,6 с |
| `large-v3-turbo` (по умолчанию) | 8,6 с | 15,4 с |

На слабом CPU можно взять `STT_LOCAL_MODEL=small` — заметно быстрее, качество на чистой речи то же, на шумной хуже. `STT_BEAM=5` чуть точнее и медленнее.

## Расшифровка входящих

Голосовые, аудио и кружки (видео — при `STT_VIDEO=true`) после проверки доступа скачиваются, ffmpeg достаёт дорожку в WAV 16 кГц, текст уходит сессии как `🎤 …` (с подписью, если была) и сохраняется в истории. В `meta`: `voice_transcribed`, `voice_duration`, `voice_language`, `stt_provider`; оригинал доступен через `download_attachment`. Пока идёт расшифровка, на сообщении стоит ✍ (если включены ack-реакции). Ошибка — сообщение приходит как раньше (`(voice message)`) с `stt_error`.

`/transcript on|off` — показывать ли расшифровку в чате ответом на голосовое.

| Ключ | По умолчанию | |
|---|---|---|
| `STT_PROVIDER` | `off` | `openai-compatible` — любой `/v1/audio/transcriptions` |
| `STT_URL` | `http://127.0.0.1:8178/v1/audio/transcriptions` | несколько через запятую — цепочка фолбэков (например, локальный, затем Groq) |
| `STT_API_KEY` | — | ключи по порядку адресов (один — для всех) |
| `STT_MODEL` | `whisper-1` | имя модели для облачных API |
| `STT_LOCAL` / `STT_LOCAL_MODEL` | `false` / `large-v3-turbo` | демон сам держит faster-whisper на порту из первого `STT_URL` |
| `STT_LANGUAGE` | авто | например `ru`. Указывайте: автоопределение — это ещё один проход модели, на CPU почти вдвое дольше |
| `STT_MAX_SEC` | `600` | длиннее не расшифровывается |

Облачные варианты: OpenAI (`https://api.openai.com/v1/audio/transcriptions`, `STT_MODEL=gpt-4o-mini-transcribe`), Groq (`https://api.groq.com/openai/v1/audio/transcriptions`, `STT_MODEL=whisper-large-v3`). **Аудио уходит третьей стороне.**

## Ответы голосом

- `/voice off|mirror|always` (по умолчанию `mirror`; то же кнопками в «/menu → ⚙️ Настройки чата»): `mirror` — голосом отвечается на голосовое, текстом — на текст.
- Инструмент `reply_voice` (`text`, `caption?`, `reply_to?`) и `voice: true` у `reply` — голос по просьбе.
- `VOICE_WITH_TEXT=caption|message|none`: текст подписью к голосовому (если короткий и без кода), отдельным сообщением или не дублировать (текст с кодом всё равно уходит).
- Перед синтезом убираются markdown и ссылки, блоки кода заменяются на «код в сообщении». Для русских голосов (Silero, piper `ru_RU`) числа, дроби, проценты, версии и латиница переписываются словами («1.2.0» → «один точка два точка ноль», «GitHub» → «гитхаб»): иначе Silero их пропускает. Длиннее `VOICE_MAX_CHARS` (1500) — только текстом.
- Ответ кодируется в OGG/Opus 48 кГц и уходит `sendVoice` с длительностью. Кэш по хэшу текста и голоса в `tts-cache/` (`TTS_CACHE_MB`, 200).
- Ошибка синтеза не теряет ответ: уходит текст, в логе предупреждение.

| Ключ | По умолчанию | |
|---|---|---|
| `TTS_PROVIDER` | `off` | `silero` (локальный сервис), `piper` (бинарник), `http` (любой `/v1/audio/speech`) |
| `TTS_FALLBACK` | `off` | второй провайдер при ошибке первого |
| `TTS_VOICE` | `xenia` | Silero: `aidar`, `baya`, `kseniya`, `xenia`, `eugene`; для `http` — голос сервиса |
| `TTS_URL` / `TTS_API_KEY` / `TTS_MODEL` | — / — / `tts-1` | для `http` (например, OpenAI `https://api.openai.com/v1/audio/speech`) — **текст уходит третьей стороне** |
| `TTS_PORT` / `TTS_SAMPLE_RATE` / `TTS_IDLE_MIN` | `8179` / `48000` / `30` | локальный Silero |
| `PIPER_BIN` / `PIPER_MODEL` | `piper` / — | путь к `.onnx` голосу `ru_RU-*` |

Silero распространяется под некоммерческой лицензией: для личного бота подходит, перед коммерческим использованием проверьте условия.
