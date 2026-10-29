# Telegram — acceso y entrega

🌍 [English](ACCESS.md) · [Русский](ACCESS.ru.md) · Español · [中文](ACCESS.zh.md) · [Français](ACCESS.fr.md) · [Deutsch](ACCESS.de.md)

Un bot de Telegram es accesible para todos: cualquiera que encuentre su nombre puede escribirle por privado y, sin un filtro, esos mensajes irían directamente a tu sesión. El modelo de acceso descrito aquí decide quién pasa.

Por defecto, un mensaje privado de un remitente desconocido inicia el **emparejamiento**: el bot responde con un código de 6 caracteres y descarta el mensaje. Ejecutas `/telegram-bewitched:access pair <código>` en tu sesión de Claude Code para aprobarlo. A partir de ahí, sus mensajes pasan.

Todo el estado vive en `~/.claude/channels/telegram-bewitched/access.json`. Los comandos de la skill `/telegram-bewitched:access` editan este archivo; el servidor lo relee con cada mensaje entrante, así que los cambios se aplican sin reiniciar. `TELEGRAM_ACCESS_MODE=static` fija la configuración tal como estaba al arrancar (el emparejamiento no está disponible en ese modo, porque necesita escribir en tiempo de ejecución).

## De un vistazo

| | |
| --- | --- |
| Política por defecto | `pairing` |
| ID del remitente | ID numérico del usuario (p. ej. `412587349`) |
| Clave del grupo | ID del supergrupo (negativo, prefijo `-100…`) |
| Particularidad de `ackReaction` | Solo una lista fija de emoji; los demás no hacen nada sin avisar |
| Archivo de configuración | `~/.claude/channels/telegram-bewitched/access.json` |

## Invitar desde el bot

El propietario (la primera entrada de `allowFrom`) también puede añadir personas sin códigos: `/invite` en el privado con el bot o «👥 Invitar» en `/sessions`. El selector de contactos de Telegram devuelve el ID de la persona; tras confirmar, el bot la añade a `allowFrom`, prepara `USERS_DIR/<id>` e inicia su sesión, crea un enlace de un solo uso al grupo de temas (requiere el permiso del bot «Invitar usuarios») y envía al propietario un mensaje para reenviar. Sus derechos dependen de su rol (ver abajo). En modo `static` solo funciona tras reiniciar (el archivo se escribe, la instantánea no).

Eliminar funciona igual: «🚫 Eliminar usuario» en la ficha de su sesión en `/sessions`, o `/users`. Tras una confirmación que enumera lo que se borra, el bot lo quita de `allowFrom` (y de las listas de grupos), cierra su ventana de tmux, borra `USERS_DIR/<id>` y sus transcripciones de Claude Code y olvida su historial privado, cola, memoria, recordatorios y ajustes; opcionalmente lo expulsa del grupo de temas (ban + unban).

## Roles

Los usuarios emparejados tienen roles. 👑 **propietario** —la primera entrada de `allowFrom`— puede hacerlo todo. 👤 **participante** (por defecto) escribe a las sesiones, responde a los botones de `ask_user` y detiene un turno con ⏹. 👁 **observador** solo lee: sus mensajes y pulsaciones se ignoran. Aprobar permisos (las solicitudes van solo al privado del propietario), el panel, el archivo, los ajustes e invitar o eliminar personas son del propietario. El propietario cambia los roles en `/users`; se guardan en `access.json` como `"roles": { "<id>": "member" | "viewer" }`. Las sesiones ven el rol del autor (`user_role`) y no dejan que alguien que no es el propietario anule sus instrucciones.

## Políticas de mensajes privados

`dmPolicy` decide qué hacer con los privados de remitentes que no están en la allowlist.

| Política | Comportamiento |
| --- | --- |
| `pairing` (por defecto) | Responder con un código de emparejamiento y descartar el mensaje. Aprobar con `/telegram-bewitched:access pair <código>`. |
| `allowlist` | Descartar en silencio, sin respuesta. Útil si el nombre del bot es fácil de adivinar y las respuestas con código atraerían spam. |
| `disabled` | Descartar todo, incluidos usuarios y grupos permitidos. |

```
/telegram-bewitched:access policy allowlist
```

## IDs de usuario

Telegram identifica a los usuarios por **ID numéricos** como `412587349`. Los nombres de usuario son opcionales y cambian; los ID numéricos son permanentes. La allowlist guarda ID numéricos.

El emparejamiento captura el ID automáticamente. Para encontrarlo a mano, pide a la persona que escriba a [@userinfobot](https://t.me/userinfobot), que responde con su ID. También sirve reenviarle cualquier mensaje suyo.

```
/telegram-bewitched:access allow 412587349
/telegram-bewitched:access remove 412587349
```

## Grupos

Los grupos están desactivados por defecto. Hay que permitir cada uno por separado.

```
/telegram-bewitched:access group add -1001654782309
```

Los ID de supergrupo son números negativos con el prefijo `-100`, p. ej. `-1001654782309`. No se muestran en la interfaz de Telegram. Para encontrarlo, añade temporalmente [@RawDataBot](https://t.me/RawDataBot) al grupo (devuelve un JSON con el ID del chat) o añade tu bot: le enviará al propietario el ID del grupo y el comando listo; `/telegram-bewitched:access` también muestra los grupos cuyos mensajes se descartaron hace poco.

Con `requireMention: true` (por defecto) el bot solo responde cuando se le menciona con @ o se responde a uno de sus mensajes. `--no-mention` procesa todos los mensajes; `--allow id1,id2` limita qué miembros pueden activarlo.

```
/telegram-bewitched:access group add -1001654782309 --no-mention
/telegram-bewitched:access group add -1001654782309 --allow 412587349,628194073
/telegram-bewitched:access group rm -1001654782309
```

**Grupos como proyectos.** Un grupo permitido que no sea el grupo de temas puede vincularse a una carpeta de proyecto. Con su primer mensaje (o al añadir el bot) el propietario recibe una ficha por privado: proyecto nuevo en `PROJECTS_DIR`, carpeta existente o «no es proyecto» (responde la sesión principal, como antes). Los mensajes de un grupo vinculado van a la sesión de ese proyecto, que responde en el grupo; las solicitudes de permiso de esa sesión van solo al privado del propietario. Desvincular: «👥 Desvincular el grupo» en la ficha de la sesión o en «/menu → 👥 Grupos». Vincular no da derechos adicionales: quién puede escribir lo sigue decidiendo este archivo.

**Privacy mode.** Por defecto los bots de Telegram tienen el privacy mode activado: el servidor de Telegram filtra los mensajes del grupo antes de que lleguen a tu código y solo entrega las menciones con @ y las respuestas. Coincide con `requireMention: true`, así que normalmente no se nota. Para `--no-mention` hay que desactivarlo: escribe a [@BotFather](https://t.me/BotFather) `/setprivacy`, elige tu bot y pulsa **Disable**. Sin ese paso, Telegram nunca entrega los mensajes, diga lo que diga la configuración local.

## Detección de menciones

En grupos con `requireMention: true`, cualquiera de estas cosas activa el bot:

- una mención estructurada `@nombredelbot`;
- una respuesta a uno de los mensajes del bot;
- una coincidencia con cualquier expresión regular de `mentionPatterns`.

```
/telegram-bewitched:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Entrega

El comportamiento de salida se configura con `/telegram-bewitched:access set <clave> <valor>`.

**`ackReaction`** reacciona a los mensajes entrantes al recibirlos. Telegram solo acepta una **lista fija** de emoji de reacción; cualquier otro se ignora sin avisar. La lista completa de la Bot API:

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram-bewitched:access set ackReaction 👀
/telegram-bewitched:access set ackReaction ""
```

**`replyToMode`** controla el hilo de las respuestas divididas: cuando una respuesta larga se parte, `first` (por defecto) responde al mensaje entrante solo con el primer fragmento; `all`, con todos; `off` envía todos los fragmentos sueltos.

**`textChunkLimit`** fija el umbral de división. Telegram rechaza mensajes de más de 4096 caracteres.

**`chunkMode`** elige la estrategia: `length` corta exactamente en el límite; `newline` prefiere cortar entre párrafos.

## Referencia de comandos

| Comando | Efecto |
| --- | --- |
| `/telegram-bewitched:access` | Mostrar el estado: política, allowlist, emparejamientos pendientes, grupos activos. |
| `/telegram-bewitched:access pair a4f91c` | Aprobar el código `a4f91c`. Añade al remitente a `allowFrom` y envía una confirmación por Telegram. |
| `/telegram-bewitched:access deny a4f91c` | Descartar un código pendiente. No se avisa al remitente. |
| `/telegram-bewitched:access allow 412587349` | Añadir un ID de usuario directamente. |
| `/telegram-bewitched:access remove 412587349` | Quitar de la allowlist. |
| `/telegram-bewitched:access policy allowlist` | Fijar `dmPolicy`: `pairing`, `allowlist`, `disabled`. |
| `/telegram-bewitched:access group add -1001654782309` | Activar un grupo. Flags: `--no-mention` (requiere además desactivar el privacy mode), `--allow id1,id2`. |
| `/telegram-bewitched:access group rm -1001654782309` | Desactivar un grupo. |
| `/telegram-bewitched:access set ackReaction 👀` | Fijar una clave: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |

## Archivo de configuración

`~/.claude/channels/telegram-bewitched/access.json`. Si el archivo no existe, equivale a la política `pairing` con listas vacías: el primer mensaje privado inicia el emparejamiento.

```jsonc
{
  // Qué hacer con los privados de remitentes que no están en allowFrom.
  "dmPolicy": "pairing",

  // ID numéricos de usuarios que pueden escribir por privado.
  "allowFrom": ["412587349"],

  // Grupos donde el bot está activo. Objeto vacío = solo privados.
  "groups": {
    "-1001654782309": {
      // true: responder solo a menciones con @ y respuestas.
      // false requiere además desactivar el privacy mode con BotFather.
      "requireMention": true,
      // Quién puede activar el bot. Vacío = cualquier miembro (según requireMention).
      "allowFrom": []
    }
  },

  // Expresiones regulares (sin distinguir mayúsculas) que cuentan como mención.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji de la lista fija de Telegram. Cadena vacía = desactivado.
  "ackReaction": "👀",

  // Hilos en respuestas divididas: first | all | off
  "replyToMode": "first",

  // Umbral de división. Telegram rechaza > 4096.
  "textChunkLimit": 4096,

  // length = cortar en el límite; newline = preferir párrafos.
  "chunkMode": "newline"
}
```
