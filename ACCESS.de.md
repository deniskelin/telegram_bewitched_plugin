# Telegram — Zugriff und Zustellung

🌍 [English](ACCESS.md) · [Русский](ACCESS.ru.md) · [Español](ACCESS.es.md) · [中文](ACCESS.zh.md) · [Français](ACCESS.fr.md) · Deutsch

Ein Telegram-Bot ist für alle erreichbar: Wer seinen Namen findet, kann ihm privat schreiben, und ohne Filter landeten diese Nachrichten direkt in Ihrer Sitzung. Das hier beschriebene Zugriffsmodell entscheidet, wer durchkommt.

Standardmäßig löst eine Privatnachricht eines unbekannten Absenders die **Kopplung** aus: Der Bot antwortet mit einem 6-stelligen Code und verwirft die Nachricht. Sie führen `/telegram-bewitched:access pair <Code>` in Ihrer Claude-Code-Sitzung aus, um die Person freizugeben. Danach kommen ihre Nachrichten durch.

Der gesamte Zustand liegt in `~/.claude/channels/telegram-bewitched/access.json`. Die Befehle der Skill `/telegram-bewitched:access` bearbeiten diese Datei; der Server liest sie bei jeder eingehenden Nachricht neu, Änderungen wirken also ohne Neustart. `TELEGRAM_ACCESS_MODE=static` friert die Konfiguration auf den Stand beim Start ein (Kopplung ist dann nicht möglich, weil sie zur Laufzeit schreiben muss).

## Auf einen Blick

| | |
| --- | --- |
| Standardrichtlinie | `pairing` |
| Absender-ID | Numerische Nutzer-ID (z. B. `412587349`) |
| Gruppenschlüssel | ID der Supergruppe (negativ, Präfix `-100…`) |
| Eigenheit von `ackReaction` | Nur eine feste Emoji-Liste; andere tun stillschweigend nichts |
| Konfigurationsdatei | `~/.claude/channels/telegram-bewitched/access.json` |

## Einladen aus dem Bot

Der Besitzer (der erste Eintrag in `allowFrom`) kann Personen auch ohne Code hinzufügen: `/invite` im Privatchat mit dem Bot oder „👥 Einladen“ in `/sessions`. Die Kontaktauswahl von Telegram liefert die Nutzer-ID; nach einer Bestätigung trägt der Bot sie in `allowFrom` ein, legt `USERS_DIR/<id>` an und startet die Sitzung, erstellt einen Einmal-Link zur Themengruppe (der Bot braucht das Recht „Nutzer einladen“) und schickt dem Besitzer eine Nachricht zum Weiterleiten. Ihre Rechte hängen von der Rolle ab (siehe unten). Im Modus `static` funktioniert das erst nach einem Neustart (die Datei wird geschrieben, der Schnappschuss nicht).

Entfernen funktioniert genauso: „🚫 Nutzer löschen“ auf der Karte seiner Sitzung in `/sessions` oder `/users`. Nach einer Bestätigung, die auflistet, was gelöscht wird, entfernt der Bot die Person aus `allowFrom` (und den Gruppenlisten), schließt ihr tmux-Fenster, löscht `USERS_DIR/<id>` und ihre Claude-Code-Transkripte und vergisst Privatchat-Verlauf, Warteschlange, Gedächtnis, Erinnerungen und Einstellungen; auf Wunsch entfernt er sie auch aus der Themengruppe (Ban + Unban).

## Rollen

Gekoppelte Nutzer haben Rollen. 👑 **Besitzer** – der erste Eintrag in `allowFrom` – darf alles. 👤 **Mitglied** (Standard) schreibt in Sitzungen, beantwortet `ask_user`-Knöpfe und stoppt einen Durchgang mit ⏹. 👁 **Beobachter** liest nur: Nachrichten und Tipps werden ignoriert. Berechtigungen erteilen (Anfragen gehen nur in den Privatchat des Besitzers), Steuerpult, Archiv, Einstellungen sowie Personen einladen und entfernen sind dem Besitzer vorbehalten. Der Besitzer stellt Rollen in `/users` um; sie stehen in `access.json` als `"roles": { "<id>": "member" | "viewer" }`. Sitzungen sehen die Rolle des Autors (`user_role`) und lassen einen Nicht-Besitzer die Anweisungen des Besitzers nicht aushebeln.

## Richtlinien für Privatnachrichten

`dmPolicy` legt fest, was mit Privatnachrichten von Absendern geschieht, die nicht in der Allowlist stehen.

| Richtlinie | Verhalten |
| --- | --- |
| `pairing` (Standard) | Mit einem Kopplungscode antworten, Nachricht verwerfen. Freigeben mit `/telegram-bewitched:access pair <Code>`. |
| `allowlist` | Stillschweigend verwerfen, keine Antwort. Nützlich, wenn der Botname leicht zu erraten ist und Code-Antworten Spam anziehen würden. |
| `disabled` | Alles verwerfen, auch erlaubte Nutzer und Gruppen. |

```
/telegram-bewitched:access policy allowlist
```

## Nutzer-IDs

Telegram kennzeichnet Nutzer mit **numerischen IDs** wie `412587349`. Nutzernamen sind optional und änderbar; numerische IDs sind dauerhaft. Die Allowlist speichert numerische IDs.

Die Kopplung erfasst die ID automatisch. Um sie von Hand zu finden, bitten Sie die Person, [@userinfobot](https://t.me/userinfobot) zu schreiben – er antwortet mit ihrer ID. Es geht auch, ihm eine beliebige Nachricht der Person weiterzuleiten.

```
/telegram-bewitched:access allow 412587349
/telegram-bewitched:access remove 412587349
```

## Gruppen

Gruppen sind standardmäßig aus. Jede muss einzeln erlaubt werden.

```
/telegram-bewitched:access group add -1001654782309
```

IDs von Supergruppen sind negative Zahlen mit dem Präfix `-100`, z. B. `-1001654782309`. Die Telegram-Oberfläche zeigt sie nicht an. Um eine zu finden, fügen Sie vorübergehend [@RawDataBot](https://t.me/RawDataBot) zur Gruppe hinzu (er gibt ein JSON mit der Chat-ID aus) oder fügen Sie Ihren Bot hinzu: Er schickt dem Besitzer die Gruppen-ID und den fertigen Befehl; `/telegram-bewitched:access` zeigt außerdem Gruppen, deren Nachrichten kürzlich verworfen wurden.

Mit `requireMention: true` (Standard) antwortet der Bot nur, wenn er per @ erwähnt oder auf eine seiner Nachrichten geantwortet wird. `--no-mention` verarbeitet jede Nachricht; `--allow id1,id2` beschränkt, welche Mitglieder ihn ansprechen dürfen.

```
/telegram-bewitched:access group add -1001654782309 --no-mention
/telegram-bewitched:access group add -1001654782309 --allow 412587349,628194073
/telegram-bewitched:access group rm -1001654782309
```

**Gruppen als Projekte.** Eine erlaubte Gruppe, die nicht die Themengruppe ist, kann mit einem Projektordner verknüpft werden. Bei ihrer ersten Nachricht (oder wenn der Bot hinzugefügt wird) bekommt der Besitzer eine Karte im Privatchat: ein neues Projekt in `PROJECTS_DIR`, ein vorhandener Ordner oder „kein Projekt“ (die Hauptsitzung antwortet, wie bisher). Nachrichten einer verknüpften Gruppe gehen an die Sitzung dieses Projekts, die in der Gruppe antwortet; Berechtigungsanfragen dieser Sitzung gehen nur in den Privatchat des Besitzers. Lösen mit „👥 Gruppe lösen“ auf der Sitzungskarte oder in „/menu → 👥 Gruppen“. Die Verknüpfung gewährt keine zusätzlichen Rechte: Wer schreiben darf, entscheidet weiterhin diese Datei.

**Privacy-Modus.** Telegram-Bots haben standardmäßig den Privacy-Modus an: Der Telegram-Server filtert Gruppennachrichten, bevor sie Ihren Code erreichen, und liefert nur @-Erwähnungen und Antworten. Das passt zu `requireMention: true` und fällt daher normalerweise nicht auf. Für `--no-mention` muss der Privacy-Modus aus sein: Schreiben Sie [@BotFather](https://t.me/BotFather) `/setprivacy`, wählen Sie Ihren Bot und dann **Disable**. Ohne diesen Schritt stellt Telegram die Nachrichten nie zu, egal was die lokale Konfiguration sagt.

## Erkennung von Erwähnungen

In Gruppen mit `requireMention: true` löst jedes Folgende den Bot aus:

- eine strukturierte Erwähnung `@botname`;
- eine Antwort auf eine Nachricht des Bots;
- ein Treffer für einen der regulären Ausdrücke in `mentionPatterns`.

```
/telegram-bewitched:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Zustellung

Das ausgehende Verhalten stellen Sie mit `/telegram-bewitched:access set <Schlüssel> <Wert>` ein.

**`ackReaction`** reagiert beim Empfang auf eingehende Nachrichten. Telegram akzeptiert nur eine **feste Liste** von Reaktions-Emoji; alles andere wird stillschweigend ignoriert. Die vollständige Liste der Bot API:

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram-bewitched:access set ackReaction 👀
/telegram-bewitched:access set ackReaction ""
```

**`replyToMode`** steuert, wie geteilte Antworten verkettet werden: Wird eine lange Antwort aufgeteilt, hängt `first` (Standard) nur das erste Stück an die eingehende Nachricht; `all` hängt alle Stücke an; `off` schickt alle Stücke einzeln.

**`textChunkLimit`** legt die Schwelle für das Aufteilen fest. Telegram lehnt Nachrichten über 4096 Zeichen ab.

**`chunkMode`** wählt die Strategie: `length` schneidet genau an der Schwelle; `newline` schneidet bevorzugt zwischen Absätzen.

## Befehlsreferenz

| Befehl | Wirkung |
| --- | --- |
| `/telegram-bewitched:access` | Zustand anzeigen: Richtlinie, Allowlist, offene Kopplungen, aktive Gruppen. |
| `/telegram-bewitched:access pair a4f91c` | Code `a4f91c` freigeben. Trägt den Absender in `allowFrom` ein und schickt eine Bestätigung in Telegram. |
| `/telegram-bewitched:access deny a4f91c` | Einen offenen Code verwerfen. Der Absender wird nicht benachrichtigt. |
| `/telegram-bewitched:access allow 412587349` | Eine Nutzer-ID direkt hinzufügen. |
| `/telegram-bewitched:access remove 412587349` | Aus der Allowlist entfernen. |
| `/telegram-bewitched:access policy allowlist` | `dmPolicy` setzen: `pairing`, `allowlist`, `disabled`. |
| `/telegram-bewitched:access group add -1001654782309` | Eine Gruppe aktivieren. Optionen: `--no-mention` (erfordert zusätzlich, den Privacy-Modus abzuschalten), `--allow id1,id2`. |
| `/telegram-bewitched:access group rm -1001654782309` | Eine Gruppe deaktivieren. |
| `/telegram-bewitched:access set ackReaction 👀` | Einen Schlüssel setzen: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |

## Konfigurationsdatei

`~/.claude/channels/telegram-bewitched/access.json`. Fehlt die Datei, entspricht das der Richtlinie `pairing` mit leeren Listen: Die erste Privatnachricht löst die Kopplung aus.

```jsonc
{
  // Umgang mit Privatnachrichten von Absendern, die nicht in allowFrom stehen.
  "dmPolicy": "pairing",

  // Numerische IDs der Nutzer, die privat schreiben dürfen.
  "allowFrom": ["412587349"],

  // Gruppen, in denen der Bot aktiv ist. Leeres Objekt = nur Privatchats.
  "groups": {
    "-1001654782309": {
      // true: nur auf @-Erwähnungen und Antworten reagieren.
      // false erfordert zusätzlich, den Privacy-Modus über BotFather abzuschalten.
      "requireMention": true,
      // Wer den Bot ansprechen darf. Leer = jedes Mitglied (gemäß requireMention).
      "allowFrom": []
    }
  },

  // Reguläre Ausdrücke (ohne Groß-/Kleinschreibung), die als Erwähnung gelten.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji aus der festen Telegram-Liste. Leere Zeichenkette = aus.
  "ackReaction": "👀",

  // Verkettung geteilter Antworten: first | all | off
  "replyToMode": "first",

  // Schwelle für das Aufteilen. Telegram lehnt > 4096 ab.
  "textChunkLimit": 4096,

  // length = an der Schwelle schneiden; newline = Absätze bevorzugen.
  "chunkMode": "newline"
}
```
