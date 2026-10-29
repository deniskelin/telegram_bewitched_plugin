# telegram-bewitched

🌍 [English](README.md) · [Русский](README.ru.md) · Español · [中文](README.zh.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**Controla Claude Code desde Telegram.** Escribes a un bot y te responde Claude Code, que funciona en tu propio servidor con acceso a tus proyectos. Cada proyecto tiene su tema en un grupo y cada persona su propia sesión. Ves qué está haciendo Claude en este momento, apruebas permisos con botones, envías mensajes de voz y vigilas límites y gasto en `/usage`.

Por dentro es un plugin de *canal* de Claude Code (los channels permiten que una fuente externa envíe mensajes a una sesión en marcha): un fork del [plugin oficial telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) con un demonio compartido, temas por proyecto en un supergrupo con foros, progreso en vivo, botones de respuesta e historial que sobrevive a los reinicios.

Especificación: [docs/TZ.md](docs/TZ.md) (en ruso). Están hechas las etapas 0–9, voz incluida (desde 1.2.0). Más allá de la especificación: el panel `/menu`, límites de la suscripción y gasto, informes con gráficos, recordatorios, control de la ventana de tmux y de git desde Telegram, invitar y eliminar personas, interfaz en seis idiomas. Qué ha cambiado: [CHANGELOG.md](CHANGELOG.md).

## Cómo funciona

```
Telegram: privados, temas del grupo
        │ Bot API (un bot)
        ▼
demonio bewitched (uno por servidor): sondeo, enrutado, cola, historial (SQLite),
                                      panel, recordatorios, límites, voz
        │ socket unix                       ▲ hooks de Claude Code: progreso, «listo»
        ▼                                   │
sesiones de Claude Code en tmux: 👤 una por persona (~/user/<id>) · 📂 una por proyecto (su tema)
```

- Un mensaje va a la sesión que atiende su chat: un privado, a la sesión de quien escribe; un tema, a la sesión de ese proyecto. Si la sesión no está en marcha, el demonio la inicia en tmux y entrega el mensaje cuando se conecta.
- La sesión responde con las herramientas del plugin (`reply`, `ask_user`, …); mientras trabaja, el demonio muestra su progreso.
- Las sesiones se inician con el flag de canales de desarrollo, así que cada inicio se confirma una vez: el bot ofrece el botón «✅ Confirmar inicio».

## Diferencias con el plugin oficial

| Función | `telegram` oficial 0.0.7 | `telegram-bewitched` |
|---|---|---|
| Texto, fotos, archivos, mensajes de voz como adjuntos | ✅ | ✅ |
| Emparejamiento, allowlist, grupos con mención | ✅ | ✅ |
| Permisos de herramientas con botones | ✅ por privado | ✅ en el tema del proyecto o por privado (`PERMISSIONS_TO`); «♾ en esta sesión» y «📌 en el proyecto» para siempre |
| Varias sesiones de Claude con un bot | ❌ 409 Conflict, la segunda sesión enmudece | ✅ un demonio de sondeo compartido; las sesiones se registran por un socket |
| `claude -p` / subagentes junto al canal | ❌ lanzan su propio sondeo y rompen el canal | ✅ las sesiones pasivas no tocan los mensajes entrantes |
| Conflicto con otro proceso de sondeo | 409 silencioso | ✅ espera y avisa al propietario por privado |
| Temas | ❌ | ✅ supergrupo con foros, un tema por proyecto, se conecta desde el privado con `/connect_group` |
| Panel de control | ❌ | ✅ resumen fijado en General, `/sessions`, `/topics`, `/send`, `/broadcast`, `/rename`, `/archive`, `/delete`, `/main` |
| Nueva sesión desde Telegram | ❌ | ✅ creas un tema → carpeta del proyecto + Claude en una ventana de tmux; `/new_session` |
| Archivo de sesión y tema | ❌ | ✅ «🗄 Archivar» cierra la sesión y el tema; al reabrir el tema la sesión arranca de nuevo |
| Progreso en vivo | ❌ solo «escribiendo» durante 5 s | ✅ borrador con «razonamiento» en privado (Bot API 10.2), «⏳ Trabajando…» actualizado con acciones en un tema, `/verbose 0\|1\|2` |
| Detener un turno desde Telegram | ❌ | ✅ botón «⏹ Detener» (Escape en tmux) |
| Botones de respuesta | ❌ | ✅ `ask_user`, `reply(buttons)`, selección múltiple, tiempo límite |
| Mensajes enriquecidos (Markdown: tablas, código, listas) | ❌ solo MarkdownV2 con escape manual | ✅ `format: "rich"` (Bot API 10.1) con texto como alternativa |
| Mensaje sin mensaje entrante (fin, error) | ❌ | ✅ `notify`, «✅ Listo» automático tras un turno largo, `bewitched notify`, HTTP `/notify` |
| Historial del chat | ❌ la Bot API no guarda historial | ✅ SQLite + búsqueda de texto completo: `get_history`, `search_messages`, `get_message` |
| Contexto de respuesta, citas, reenvíos | ❌ solo el texto del mensaje | ✅ `reply_to_text`, `quote_text`, `forward_from`, lotes de reenvíos |
| Memoria entre reinicios | ❌ | ✅ `save_memory`, un resumen y el historial reciente al conectar una sesión |
| Mensajes con la sesión apagada | ❌ se pierden | ✅ se guardan y se entregan cuando la sesión arranca |
| Derechos de usuarios | todos los de la allowlist, por privado | ✅ todos los de la allowlist valen lo mismo que el propietario, también en el grupo de temas; los extraños se ignoran |
| Detectar el tmux de la sesión | — | ✅ por el entorno o la terminal del proceso de Claude |
| Mensajes de voz | un adjunto sin texto | ✅ transcripción con faster-whisper local, respuestas con voz (Silero/Piper/nube) — [docs/voice.md](docs/voice.md) |
| Límites y gasto | ❌ | ✅ `/usage`: porcentajes de los límites de la suscripción, coste a precios de API, avisos de umbral y restablecimiento, resumen del día, informes con gráfico |
| Ventana de la sesión y git desde Telegram | ❌ | ✅ «✅ Confirmar inicio», «👁 Pantalla y teclas» (también en vivo, ▶️), 🧹 `/compact`, 🆕 `/clear`, 🧠 modelo, 🕘 conversaciones anteriores, 🌿 estado, commits, PR y diff |
| Eventos externos y CI | ❌ | ✅ `/event` y `bewitched event` → tema y sesión del proyecto; un GitHub Actions fallido con el botón «🛠 Arreglar» |
| Comandos rápidos | ❌ | ✅ `/macro`: tus propios botones con texto para la sesión del chat |
| Recordatorios | ❌ | ✅ `/remind` y la herramienta `remind`, puntuales y diarios |
| Personas | solo código de emparejamiento | ✅ `/invite` desde contactos, `/users`, eliminación con todos sus datos |
| Grupos normales | a través de la sesión principal | ✅ un grupo sin temas = un proyecto: se vincula desde el privado del propietario, su sesión responde en el grupo |
| Idiomas de la interfaz | inglés | ✅ ruso, inglés, español, chino, francés, alemán — `/lang`, por defecto el idioma de Telegram |
| Tests | ❌ | ✅ unitarios y de integración con una Bot API falsa |

## Qué hace

| | |
|---|---|
| **Demonio compartido** | Un proceso sondea Telegram para todas las sesiones. Varias sesiones de Claude Code y `claude -p` funcionan con un bot sin 409 Conflict. |
| **Temas** | Conectas un supergrupo con foros desde el privado (`/connect_group`); cada proyecto tiene su tema. En General están el panel fijado y los comandos de control. |
| **Tipos de sesión** | 👤 una sesión por usuario (su privado y sus mensajes en General), 📂 una sesión por proyecto en su tema. Las sesiones arrancan solas con el primer mensaje; un vigilante avisa de las que se detienen y ofrece un botón para reiniciarlas. |
| **Progreso en vivo** | Mientras Claude trabaja: en privado, un borrador nativo con un bloque de «razonamiento»; en un tema, un mensaje «⏳ Trabajando…» que se actualiza con acciones y un botón **⏹ Detener** (interrumpe el turno vía tmux). |
| **Botones de respuesta** | La herramienta `ask_user` y `reply(buttons)`: opciones con un toque; la respuesta vuelve a la sesión. |
| **Proyectos desde temas** | Creas un tema en el grupo → carpeta `~/projects/<nombre>` y una nueva sesión de Claude en una ventana de tmux ligada a ese tema. O `/new_session <nombre\|ruta>`. El inicio se confirma con el botón «✅ Confirmar inicio». |
| **Archivo** | «🗄 Archivar» en la ficha del proyecto en `/sessions`: la sesión termina y el tema se cierra. Reabres el tema y arranca una sesión nueva. Cerrar el tema en Telegram equivale a archivarlo. |
| **Notificaciones** | `notify` sin mensaje entrante, «✅ Listo» automático tras un turno largo, `bewitched notify` y HTTP `/notify` para scripts y CI. |
| **Panel `/menu`** | Un mensaje con botones para todo: sesiones, temas, estadísticas, personas, recordatorios, ajustes de este chat, ayuda. El menú de comandos de Telegram solo muestra `/menu`, `/sessions`, `/usage`, `/help`. |
| **Control de la sesión** | «✅ Confirmar inicio» en el mensaje de inicio, sin terminal. La ficha en `/sessions`: captura de la ventana de tmux con teclas (▶️: se actualiza sola durante un minuto), 🧹 `/compact`, 🆕 `/clear`, 🧠 cambio de modelo, 🕘 conversaciones anteriores (`/resume` en la misma sesión), ⚡ comandos rápidos, 🌿 git (estado, commits, PR, diff como archivo), «♾ Siempre en la sesión» y «📌 Siempre en el proyecto» para una herramienta, aviso cuando el contexto se llena. |
| **Eventos externos** | `bewitched event --topic <nombre> "texto"` o `POST /event`: un mensaje «📡» en el tema del proyecto y para su sesión. Cada 5 minutos el bot mira la última ejecución de GitHub Actions de la rama de cada sesión de proyecto: si falla, «❌ El CI falló» con «🛠 Arreglar»; si vuelve a verde, «✅». |
| **Voz** | Los mensajes de voz y los videomensajes se transcriben localmente; a un mensaje de voz se responde con voz. La voz rusa lee en ruso números, horas, fechas y palabras latinas. Voz y velocidad se ajustan por chat. |
| **Estadísticas** | `/usage`: porcentajes de los límites con hora de restablecimiento y barra, gasto por modelo y sesión; avisos al 80/95 % y en el momento del restablecimiento (🔔/🔕); «🌙 Resumen del día»; `/reports`: día, semana, mes con gráfico; el coste de la sesión en su ficha; `/server`: carga de la máquina, registro del demonio y reinicio con un botón; 👥 cuánto gastó cada uno de la ventana de 5 horas, con aviso si alguien supera `USER_SHARE_ALERT`. 🌙 Horas de silencio: sin sonido por la noche. |
| **Recordatorios** | `/remind 2h revisa el CI`, «tomorrow 9:00», «every day 9:00»; a su hora el texto llega al chat y a su sesión; si la sesión no está en marcha, se inicia. |
| **Personas** | `/invite`: eliges un contacto; el bot da acceso, inicia su sesión y da un enlace al grupo; `/users` y 🚫: eliminar a una persona con su sesión, carpeta, transcripciones e historial. A quien se añada con `/telegram-bewitched:access` el demonio lo detecta solo. |
| **Grupos como proyectos** | Un grupo normal (sin temas) permitido en access se convierte en proyecto: el propietario recibe una ficha por privado — proyecto nuevo, carpeta existente o «no es proyecto». Su sesión responde en el grupo; se controla desde el privado del propietario. |
| **Idiomas** | La interfaz del bot en 6 idiomas: ru, en, es, zh, fr, de. El idioma de un chat: `/lang` o las banderas en «/menu → ⚙️»; por defecto en privado, el idioma de Telegram del usuario; si no, `BOT_LANGUAGE`. El menú de comandos de Telegram sigue el idioma de la app. |
| **Historial y memoria** | SQLite con búsqueda de texto completo, contexto de respuesta/cita/reenvío en cada mensaje, `get_history`, `search_messages`, memoria del chat `save_memory`, resumen al conectar una sesión, entrega de los mensajes que llegaron con la sesión apagada. |

## Requisitos

- [Bun](https://bun.sh) ≥ 1.2.
- Claude Code con channels y el hook `MessageDisplay`.
- tmux: para iniciar sesiones solas, el botón «⏹ Detener», «👁 Pantalla y teclas» y los comandos en la ventana de la sesión (sin tmux, «Detener» solo avisa al modelo).
- Opcional: `gh` (PR en «🌿 Git», vigilancia del CI), ffmpeg y Python 3 (voz, se instala con `bewitched voice install`).

## Instalación

1. Crea un bot con [@BotFather](https://t.me/BotFather) (`/newbot`) y copia el token.
2. En Claude Code:

```
/plugin marketplace add deniskelin/telegram_bewitched_plugin
/plugin install telegram-bewitched@bewitched
/telegram-bewitched:configure <token>
```

   Si antes tenías el plugin oficial, `.env` y `access.json` se copian de `~/.claude/channels/telegram/` automáticamente en el primer arranque.
3. Inicia una sesión con el canal (ver «Ejecución»), escribe al bot por privado —te responderá con un código de 6 caracteres— y ejecuta `/telegram-bewitched:access pair <código>` en Claude Code. El primer usuario emparejado se convierte en el propietario. Más en [ACCESS.md](ACCESS.es.md).

**El plugin oficial y el fork no deben sondear el mismo token a la vez.** Desactiva el oficial (`/plugin disable telegram@claude-plugins-official`) o ejecuta Claude sin su `--channels`. Si el demonio ve el plugin oficial funcionando con el mismo token, espera en lugar de pelear por el sondeo.

## Ejecución

Durante la research preview los canales de terceros se cargan con un flag de desarrollo (aparece una confirmación que hay que aceptar):

```
tmux new -s claude
claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched
```

La primera sesión arranca el demonio. Sigue funcionando cuando las sesiones se cierran, para que el panel y `/notify` respondan siempre.

Los comandos de la CLI se ejecutan desde la carpeta del plugin: tras instalar desde el marketplace es `~/.claude/plugins/cache/bewitched/telegram-bewitched/<versión>/` (o un clon del repositorio).

```
cd ~/.claude/plugins/cache/bewitched/telegram-bewitched/<versión>
bun bin/bewitched.ts daemon status|stop|restart|logs
bun bin/bewitched.ts daemon install-cron     # @reboot en crontab
bun bin/bewitched.ts voice install           # voz, ver docs/voice.md
bun bin/bewitched.ts notify --topic myproj "falló la compilación"
bun bin/bewitched.ts event --topic myproj --source ci "falló el despliegue: …"   # al tema y la sesión del proyecto
```

## Actualización

```
claude plugin marketplace update bewitched
claude plugin update telegram-bewitched@bewitched
```

Después reinicia las sesiones de Claude Code (el cliente y los hooks se toman de la nueva versión) y el demonio, con el comando desde la carpeta de la versión **nueva**: `bun bin/bewitched.ts daemon restart`. El botón «♻️ Reiniciar el demonio» de `/server` reinicia la versión que ya está en marcha. Si usaste `install-cron`, repítelo desde la carpeta nueva: la entrada se sustituye.

## Temas en un supergrupo

1. En el privado con el bot: `/connect_group`.
2. «➕ Añadir el bot a un grupo» → elige un grupo con «Temas» activados → confirma los permisos de administrador (gestionar temas, fijar, eliminar).
3. Confirma la conexión en el privado.

Todos los de la allowlist del bot pueden escribir a las sesiones y controlarlas (botones, panel, archivo, permisos): todos los usuarios emparejados tienen los mismos derechos completos. El resto de miembros del grupo se ignora. Los borradores nativos de Telegram solo funcionan en privado, así que en los temas el progreso se muestra como un mensaje que se actualiza.

`/sessions` es un menú en un solo mensaje, como el de BotFather: la lista de sesiones con un botón cada una; un botón abre la ficha de la sesión con acciones (⏹ Detener, 👑 Hacer principal, 🗄 Archivar, 💬 Abrir tema) y los ajustes de su chat (🔕0/🔔1/📢2 y «✅ listo»); «« A la lista» vuelve atrás. `/topics` es el mismo tipo de menú para los temas: el estado de cada uno (sesión, 💤 sin sesión, cola), una pantalla del tema con 💬 Abrir, 📋 ficha de la sesión, 🚀 Iniciar sesión, 🗄 Archivar / ↩️ Restaurar, 🗑 Eliminar; el archivo en su propia página. «👁 Pantalla y teclas» (en la ficha y en los mensajes de inicio) envía la vista actual de la ventana de tmux con los botones 1/2/3, Enter, Esc, ↑/↓, Tab: basta para responder a cualquier pregunta sin `tmux attach`. «🌿 Git» muestra el estado, los últimos commits y el PR de la rama (con `gh`); «📄 diff como archivo» envía `git diff HEAD`. Bajo una solicitud de permiso están «♾ Siempre <herramienta> en esta sesión» (hasta que la sesión se reconecte; se quita en la ficha) y «📌 Siempre <herramienta> en el proyecto» (el bot guarda la regla por carpeta del proyecto; se quita en la ficha). Los botones 🧹 `/compact`, 🆕 `/clear` y 🧠 Modelo escriben el comando en la ventana de la sesión (solo entre turnos). La ficha muestra: tipo (👑 principal o de proyecto), estado, `#id` y pid, carpeta de trabajo, rama, tema, dónde está en tmux (sesión, ventana, panel) con un `tmux attach -t <sesión>:<ventana>` listo, si «⏹ Detener» está disponible, el modo de permisos, modelo y tamaño del contexto, el turno actual y la última acción, el comando `claude --resume <id>`, el nombre de `/rename`, si 📱 Remote Control está activo con enlace a la sesión en claude.ai (por el evento `remote_session_change` del transcript; antes del primero, por el flag `--remote-control`/`--rc` o `remoteControlAtStartup`) y el tiempo desde el inicio y desde la última actividad. Las sesiones iniciadas sin el flag de canales aparecen en un bloque aparte «👻 Sin canal» con el comando para reiniciarlas: no reciben mensajes y antes eran invisibles.

Todo lo siguiente también está en botones en **`/menu`** (el menú de comandos de Telegram solo tiene `/menu`, `/sessions`, `/usage`, `/help`). Comandos del panel (privado o General): `/sessions`, `/topics`, `/permissions` (solicitudes de permiso pendientes de todas las sesiones), `/send <tema> <texto>`, `/broadcast <texto>`, `/rename <tema> | <nombre>`, `/archive <tema>`, `/delete <tema>`, `/new_session <nombre|ruta>`. En cualquier chat: `/verbose [0|1|2]` (🔕0 solo la respuesta, 🔔1 + acciones, 📢2 + texto del modelo; sin argumento muestra el nivel actual), `/notify_done [off|long|always]`, `/lang ru|en|es|zh|fr|de|auto`, `/remember`, `/forget`, `/voice off|mirror|always`, `/transcript on|off`, `/macro add <botón> | <texto>` y `/macro del <n>` (comandos rápidos del chat), `/remind <cuándo> <texto>` (30m, 1h30m, «in 2 hours», 18:30, «tomorrow 9:00», «every day 9:00»; también en ruso; a su hora el texto llega al chat y a la sesión del chat, y si la sesión no está en marcha, se inicia), `/reminders`. El nivel se ve en las fichas de sesión (línea 📣), se cambia ahí con botones y en el encabezado «⏳ Trabajando… · 🔔1». En privado: `/server` (CPU, memoria, discos, procesos de Claude Code y de voz; «📜 Registros del demonio», «♻️ Reiniciar el demonio»), `/users` (todos con acceso; 🚫 elimina un usuario: acceso, sesión y ventana de tmux, carpeta, transcripciones e historial privado, tras confirmar), `/invite` (invitar a un usuario: elegir contacto → confirmar → el bot le da acceso, inicia su sesión y envía una invitación para reenviar), `/usage`, `/digest`, `/reports` (informes del día, la semana y el mes con gráfico de gasto por horas/días/semanas y estadísticas; cada uno se activa con un botón y llega al terminar el periodo), `/main [id|reset]`, `/group`, `/disconnect_group`, `/status`.

`/usage` (solo el propietario): el plan de la suscripción de `~/.claude/.credentials.json`, los porcentajes de los límites (5 horas, semana) con hora de restablecimiento y el gasto de tokens de 5 horas, un día y 7 días en todos los transcripts a precios de API, por modelo y sesión. Los porcentajes vienen del endpoint **no documentado** de Anthropic `api/oauth/usage` (el mismo que llama `/usage` en Claude Code) con el token OAuth de la suscripción. Puede dejar de funcionar con cualquier actualización; entonces `/usage` mostrará solo datos locales. `USAGE_LIMITS=off` desactiva la consulta. Las secciones «Quién gasta», «Por modelo» y «Por sesión» muestran el periodo elegido con botones: 5 horas, día, semana o mes (para 5 horas y semana, «quién gasta» es la parte de la ventana de la suscripción; si no, la parte del gasto).

## Grupos normales como proyectos

Un grupo sin temas puede ser un proyecto propio: un chat familiar sobre una web, un chat de equipo sobre un servicio.

1. Añade el bot al grupo y permítelo en la terminal: `/telegram-bewitched:access group add <id>` (el bot te indica el id al añadirlo; hasta entonces no habla allí). Por defecto el bot solo responde cuando se le menciona; `--no-mention` lo desactiva (también hay que desactivar el privacy mode en @BotFather; ver [ACCESS.md](ACCESS.es.md)).
2. Con el primer mensaje del grupo el propietario recibe una ficha por privado: «📁 Nuevo» (`~/projects/<nombre del grupo>`), «📂 Elegir proyecto» (una carpeta existente) o «🚫 No es proyecto» (responde la sesión principal, como antes). Lo escrito en el grupo espera en cola mientras tanto.
3. La sesión del proyecto se inicia en tmux (se confirma con «✅ Confirmar inicio» en tu privado), responde directamente en el grupo y muestra ahí su progreso. No tiene tema.

Todo lo demás, desde el privado del propietario: la ficha de la sesión en `/sessions` (con «👥 Desvincular el grupo»), la lista en «/menu → 👥 Grupos». Las solicitudes de permiso de la sesión de un grupo van solo al propietario. Recordatorios, `/macro`, `/event` y avisos de CI funcionan en el grupo igual que en un tema.

## Tipos de sesión

El bot está pensado para un círculo pequeño de personas cercanas (una familia, por ejemplo) en la allowlist. Cada uno tiene su sesión de Claude; los proyectos viven en los temas del grupo.

| | Carpeta | Qué recibe |
|---|---|---|
| 👤 **Sesión de usuario** | `~/user/<user_id>` (`USERS_DIR`) | El privado de ese usuario y sus mensajes en General; responde ahí |
| 📂 **Sesión de proyecto** | carpeta del proyecto | Su tema |
| 👑 **Principal** | `MAIN_DIR` (por defecto `~`) | Solo con `USER_SESSIONS=off` (los privados de todos y General, como en 1.0) o como reserva para `TOPIC_NO_SESSION=main` |

El propio demonio hace el trabajo de servicio, sin Claude: comandos del panel, cerrar y abrir temas, iniciar sesiones, el vigilante.

- **La sesión de usuario arranca sola.** El primer mensaje del usuario → el demonio crea `~/user/<id>`, inicia Claude en una ventana nueva de tmux (`TMUX_SESSION`, con `--continue` si ya hubo conversaciones); el mensaje espera en cola y llega cuando la sesión se conecta.
- **Tema de proyecto sin sesión** (`TOPIC_NO_SESSION=launch`): un mensaje inicia la sesión del proyecto. Si no se puede iniciar, el bot publica el comando para iniciarla a mano y cierra el tema hasta que la sesión se conecte.
- **Vigilante.** Una sesión se fue sola (no por archivo ni por inactividad) → un minuto después el bot escribe en su chat «⚠️ La sesión … se ha detenido», con comandos para reiniciarla y un botón «🚀 Iniciar». Un tema de proyecto se cierra hasta que la sesión se reconecte.
- **Cierre de sesiones inactivas:** `USER_IDLE_MIN` y `PROJECT_IDLE_MIN`, por defecto `0` (nunca). Una sesión inactiva no gasta tokens, solo memoria.

### Qué hay que hacer a mano

1. **Confirmar cada inicio de sesión.** Mientras los canales de Claude Code estén en research preview, iniciar con `--dangerously-load-development-channels` muestra una pantalla de advertencia. El bot no la acepta por su cuenta: el mensaje de inicio tiene el botón «✅ Confirmar inicio»; al pulsarlo, el bot responde una a una las preguntas de inicio (confianza en la carpeta «Yes, I trust this folder» para una carpeta nueva e «I am using this for local development»), espera a que la sesión se conecte y sustituye la pantalla por «✅ Sesión conectada». Cualquier otra pregunta queda para ti: «👁 Pantalla y teclas» (con «✖️ Cerrar») o `tmux attach -t claude:<ventana>`. Hace falta en el primer mensaje de un usuario nuevo, tras reiniciar el servidor, tras una caída de la sesión y tras cada cierre por inactividad (si está activado).
2. **Tener tmux en el servidor.** Sin él las sesiones no arrancan solas: el bot enviará un comando para iniciarlas a mano.
3. **Reiniciar las sesiones detenidas**: con «🚀 Iniciar» del aviso del vigilante (y confirmar de nuevo) o con el comando que trae.

### Inconvenientes

- Cada inicio se confirma con un toque (ver arriba); hasta que alguien lo pulse, el usuario espera respuesta.
- Cada sesión es un proceso aparte de Claude Code: ~350–450 MB de memoria, y todas gastan los límites de una misma cuenta.
- El aislamiento es solo de contexto y memoria: todas las sesiones corren con un mismo usuario del sistema, ven toda la máquina, los archivos de las demás y el `~/.claude` compartido. Para una familia es una decisión consciente, no una frontera de seguridad.
- Todos en el grupo ven las respuestas en General; la sesión de un usuario puede citar ahí algo de su privado si el propio usuario lo pide.
- El aviso del vigilante también llega tras un `/exit` intencionado en la terminal: desde fuera no se distingue de una caída.
- `--continue` continúa la última conversación de la carpeta, incluida una iniciada en ella a mano.

`USER_SESSIONS=off` recupera el comportamiento de 1.0: los privados de todos y General van a la sesión principal en `MAIN_DIR`; `/main <id>`, `/main reset` y «👑 Hacer principal» en la ficha de `/sessions` la reasignan.

## Ajustes (`~/.claude/channels/telegram-bewitched/.env`)

| Variable | Por defecto | |
|---|---|---|
| `TOPIC_MODE` | `project` | `project`: un tema por proyecto, `session`: por sesión, `off` |
| `PERMISSIONS_TO` | `topic` | A dónde van las solicitudes de permiso: `topic`, `dm`, `both` |
| `STOP_MODE` | `interrupt` | `interrupt` (Escape en tmux), `notify`, `off` |
| `PROGRESS_FINAL` | `delete` | Qué hacer con el mensaje de progreso tras la respuesta: `delete`, `keep` |
| `NOTIFY_LONG_SEC` | `60` | Umbral de «turno largo» para el aviso automático |
| `DAEMON_IDLE_EXIT_MIN` | `0` | Detener el demonio tras N minutos sin sesiones (0: nunca) |
| `BEWITCHED_HTTP_PORT` | `8797` | HTTP local (hooks, `/notify`, `/event`), solo 127.0.0.1, token en `http.token` |
| `HISTORY_MAX_DAYS` | `90` | Cuánto se guarda el historial |
| `PASSIVE_TOOLS` | `false` | Permitir herramientas en sesiones sin canal (`claude -p`) |
| `TOPIC_PROJECTS` | `auto` | Un tema creado por el propietario → proyecto y sesión: `auto`, `ask` (botón), `off` |
| `PROJECTS_DIR` | `~/projects` | Dónde se crean las carpetas de proyectos |
| `USER_SESSIONS` | `on` | Una sesión por cada usuario de la allowlist; `off`: como en 1.0 (todo a la principal) |
| `USERS_DIR` | `~/user` | Dónde están las carpetas de las sesiones de usuario (`<USERS_DIR>/<user_id>`) |
| `USER_IDLE_MIN` | `0` | Cerrar la sesión de usuario tras N minutos inactiva (0: nunca) |
| `PROJECT_IDLE_MIN` | `0` | Cerrar la sesión de proyecto tras N minutos inactiva (0: nunca) |
| `TOPIC_NO_SESSION` | `launch` | Tema de proyecto sin sesión: `launch`: iniciarla, `main`: responde la principal, `queue`: solo cola |
| `WATCHDOG_GRACE_SEC` | `60` | Cuántos segundos tras detenerse una sesión se avisa |
| `MAIN_DIR` | `~` | Carpeta de la sesión principal (con `USER_SESSIONS=off`: privados y General) |
| `CONTEXT_WINDOW` | `1000000` | Tamaño de la ventana de contexto para el porcentaje de llenado en las fichas |
| `CONTEXT_WARN_PCT` | `80` | Con este llenado del contexto, ofrecer `/compact` en el chat de la sesión (0: nunca) |
| `DIGEST_AT` | `21:00` | A qué hora enviar al propietario el «🌙 Resumen del día» (gasto, commits, límites); `off`: nunca. A petición: `/digest` |
| `LIMIT_ALERTS` | `80,95` | Umbrales de aviso de los límites de la suscripción en %; `off`: sin avisos. Una ventana que cruzó un umbral recibe «✅ Los tokens se renovaron» justo al restablecerse; en `/usage` se puede pedir lo mismo con 🔔 para cualquier ventana |
| `LIMIT_CHECK_MIN` | `10` | Cada cuánto comprobar los límites (minutos, 0: nunca) |
| `USAGE_LIMITS` | `on` | `/usage`: pedir los porcentajes al endpoint no documentado de Anthropic (`off`: solo datos locales) |
| `USER_SHARE_ALERT` | `40` | Avisar al propietario cuando otro usuario ocupe este porcentaje de la ventana de 5 horas (una vez por ventana; 0: nunca). Funciona junto con `LIMIT_ALERTS` |
| `CI_WATCH_MIN` | `5` | Cada cuánto mirar la última ejecución de GitHub Actions de las ramas de las sesiones de proyecto (con `gh`; 0: nunca) |
| `QUIET_HOURS` | `off` | Horas de silencio, p. ej. `23:00-08:00`: todo lo que envía el bot llega sin sonido. Los botones de «/menu → ⚙️» prevalecen sobre `.env` |
| `BOT_LANGUAGE` | `ru` | Idioma de la interfaz por defecto (`ru`, `en`, `es`, `zh`, `fr`, `de`) cuando ni el chat ni el propietario eligieron uno y no se conoce el idioma de Telegram del usuario |
| `TMUX_SESSION` | `claude` | La sesión de tmux para las ventanas nuevas |
| `STT_PROVIDER` / `TTS_PROVIDER` | `off` | Voz: transcripción de mensajes entrantes y respuestas con voz; ver [docs/voice.md](docs/voice.md), instalación con `bewitched voice install` |
| `CLAUDE_LAUNCH_CMD` | `claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched` | El comando para una sesión nueva. El bot añade `-n claude-<telegram id>` (sesión de usuario) o `-n claude-topic-<tema>` (proyecto); la ventana de tmux recibe el mismo nombre |

El acceso (emparejamiento, allowlist, grupos) funciona como en el plugin oficial: ver [ACCESS.md](ACCESS.es.md) y `/telegram-bewitched:access`.

## Desarrollo

```
bun install
bun test          # tests unitarios + de integración con una Bot API falsa
bunx tsc --noEmit
```

Traducciones: las cadenas de la interfaz se escriben en ruso como `t('…', { variables })`; los diccionarios están en `src/i18n/<idioma>.ts`; `bun scripts/i18n-keys.ts missing es` lista las cadenas sin traducir y un test comprueba que todos los diccionarios estén completos.

Estructura: `server.ts`: un cliente MCP ligero por sesión; `src/daemon/`: el demonio (sondeo, enrutado, temas, streaming, botones, herramientas, HTTP, menús y pantallas, estadísticas, informes, recordatorios); `src/i18n/`: idiomas de la interfaz; `src/voice/` y `voice/*.py`: reconocimiento y síntesis de voz; `hooks/`: hooks de Claude Code → demonio; `bin/bewitched.ts`: la CLI. Sincronización con upstream: [UPSTREAM.md](UPSTREAM.md).
