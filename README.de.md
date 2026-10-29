# telegram-bewitched

🌍 [English](README.md) · [Русский](README.ru.md) · [Español](README.es.md) · [中文](README.zh.md) · [Français](README.fr.md) · Deutsch

**Claude Code aus Telegram steuern.** Sie schreiben einem Bot – es antwortet Claude Code, das auf Ihrem eigenen Server läuft und Zugriff auf Ihre Projekte hat. Jedes Projekt hat sein eigenes Thema in einer Gruppe, jede Person ihre eigene Sitzung. Sie sehen, was Claude gerade tut, bestätigen Berechtigungen per Knopf, schicken Sprachnachrichten und behalten Limits und Verbrauch in `/usage` im Blick.

Technisch ist es ein *Kanal*-Plugin für Claude Code (Channels lassen eine externe Quelle Nachrichten in eine laufende Sitzung schicken) – ein Fork des [offiziellen telegram-Plugins](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) mit gemeinsamem Daemon, Projektthemen in einer Forum-Supergruppe, Live-Fortschritt, Antwortknöpfen und einem Verlauf, der Neustarts übersteht.

Pflichtenheft: [docs/TZ.md](docs/TZ.md) (auf Russisch). Die Etappen 0–9 sind umgesetzt, einschließlich Sprache (seit 1.2.0). Über das Pflichtenheft hinaus: das Steuerpult `/menu`, Abo-Limits und Verbrauch, Berichte mit Diagrammen, Erinnerungen, Steuerung des tmux-Fensters und von Git aus Telegram, Einladen und Entfernen von Personen, eine Oberfläche in sechs Sprachen. Was sich geändert hat: [CHANGELOG.md](CHANGELOG.md).

## So funktioniert es

```
Telegram: Privatchats, Gruppenthemen
        │ Bot API (ein Bot)
        ▼
bewitched-Daemon (einer pro Server): Abfrage, Routing, Warteschlange, Verlauf (SQLite),
                                     Steuerpult, Erinnerungen, Limits, Sprache
        │ Unix-Socket                       ▲ Claude-Code-Hooks: Fortschritt, „fertig“
        ▼                                   │
Claude-Code-Sitzungen in tmux: 👤 eine pro Person (~/user/<id>) · 📂 eine pro Projekt (sein Thema)
```

- Eine Nachricht geht an die Sitzung, die ihren Chat bedient: im Privatchat an die Sitzung des Absenders, im Thema an die Sitzung des Projekts. Läuft die Sitzung nicht, startet der Daemon sie in tmux und stellt die Nachricht zu, sobald sie verbunden ist.
- Die Sitzung antwortet mit den Werkzeugen des Plugins (`reply`, `ask_user`, …); während sie arbeitet, zeigt der Daemon den Fortschritt.
- Sitzungen starten mit dem Flag für Entwicklungskanäle, daher wird jeder Start einmal bestätigt – der Bot bietet einen Knopf „✅ Start bestätigen“.

## Unterschiede zum offiziellen Plugin

| Funktion | Offizielles `telegram` 0.0.7 | `telegram-bewitched` |
|---|---|---|
| Text, Fotos, Dateien, Sprachnachrichten als Anhänge | ✅ | ✅ |
| Kopplung, Allowlist, Gruppen mit Erwähnung | ✅ | ✅ |
| Werkzeug-Berechtigungen per Knopf | ✅ im Privatchat | ✅ im Projektthema oder Privatchat (`PERMISSIONS_TO`); „♾ in dieser Sitzung“ und „📌 im Projekt“ dauerhaft |
| Mehrere Claude-Sitzungen an einem Bot | ❌ 409 Conflict, die zweite Sitzung verstummt | ✅ ein gemeinsamer Abfrage-Daemon, Sitzungen melden sich über einen Socket an |
| `claude -p` / Subagenten neben dem Kanal | ❌ starten eine eigene Abfrage und legen den Kanal lahm | ✅ passive Sitzungen fassen eingehende Nachrichten nicht an |
| Konflikt mit einem anderen Abfrageprozess | stilles 409 | ✅ wartet und meldet sich beim Besitzer im Privatchat |
| Themen | ❌ | ✅ Forum-Supergruppe, ein Thema pro Projekt, Verbindung aus dem Privatchat mit `/connect_group` |
| Steuerpult | ❌ | ✅ angeheftete Übersicht in General, `/sessions`, `/topics`, `/send`, `/broadcast`, `/rename`, `/archive`, `/delete`, `/main` |
| Neue Sitzung aus Telegram | ❌ | ✅ Thema anlegen → Projektordner + Claude in einem tmux-Fenster; `/new_session` |
| Archiv für Sitzung und Thema | ❌ | ✅ „🗄 Archivieren“ beendet die Sitzung und schließt das Thema; erneutes Öffnen startet die Sitzung wieder |
| Live-Fortschritt | ❌ nur „schreibt…“ für 5 s | ✅ Entwurf mit „Überlegungen“ im Privatchat (Bot API 10.2), ein aktualisiertes „⏳ Arbeite…“ mit Aktionen im Thema, `/verbose 0\|1\|2` |
| Einen Durchgang aus Telegram stoppen | ❌ | ✅ Knopf „⏹ Stopp“ (Escape in tmux) |
| Antwortknöpfe | ❌ | ✅ `ask_user`, `reply(buttons)`, Mehrfachauswahl, Zeitlimit |
| Rich-Nachrichten (Markdown: Tabellen, Code, Listen) | ❌ nur MarkdownV2 mit manuellem Escaping | ✅ `format: "rich"` (Bot API 10.1) mit Rückfall auf Text |
| Nachricht ohne eingehende Nachricht (fertig, Fehler) | ❌ | ✅ `notify`, automatisches „✅ Fertig“ nach einem langen Durchgang, `bewitched notify`, HTTP `/notify` |
| Chatverlauf | ❌ die Bot API speichert keinen Verlauf | ✅ SQLite + Volltextsuche: `get_history`, `search_messages`, `get_message` |
| Antwortkontext, Zitate, Weiterleitungen | ❌ nur der Nachrichtentext | ✅ `reply_to_text`, `quote_text`, `forward_from`, gebündelte Weiterleitungen |
| Gedächtnis über Neustarts | ❌ | ✅ `save_memory`, Zusammenfassung und letzter Verlauf beim Verbinden einer Sitzung |
| Nachrichten bei ausgeschalteter Sitzung | ❌ gehen verloren | ✅ werden gespeichert und beim Start der Sitzung zugestellt |
| Nutzerrechte | alle aus der Allowlist, im Privatchat | ✅ Rollen: 👑 Besitzer (alles), 👤 Mitglied (schreibt, antwortet, ⏹), 👁 Beobachter (liest nur); Berechtigungen und Steuerpult beim Besitzer; Fremde werden ignoriert |
| tmux der Sitzung erkennen | — | ✅ über die Umgebung oder das Terminal des Claude-Prozesses |
| Sprachnachrichten | ein Anhang ohne Text | ✅ Transkription mit lokalem faster-whisper, gesprochene Antworten (Silero/Piper/Cloud) — [docs/voice.md](docs/voice.md) |
| Limits und Verbrauch | ❌ | ✅ `/usage`: Prozent der Abo-Limits, Kosten zu API-Preisen, Meldungen zu Schwellen und Zurücksetzung, Tagesbilanz, Berichte mit Diagramm |
| Sitzungsfenster und Git aus Telegram | ❌ | ✅ „✅ Start bestätigen“, „👁 Bildschirm und Tasten“ (auch live, ▶️), 🧹 `/compact`, 🆕 `/clear`, 🧠 Modell, 🕘 frühere Gespräche, 🌿 Status, Commits, PR und Diff |
| Externe Ereignisse und CI | ❌ | ✅ `/event` und `bewitched event` → Thema und Sitzung des Projekts; ein fehlgeschlagener GitHub-Actions-Lauf mit dem Knopf „🛠 Beheben“ |
| Schnellbefehle | ❌ | ✅ `/macro`: eigene Knöpfe mit Text für die Sitzung des Chats |
| Erinnerungen | ❌ | ✅ `/remind` und das Werkzeug `remind`, einmalig und täglich |
| Personen | nur Kopplungscode | ✅ `/invite` aus den Kontakten, `/users`, Entfernen samt aller Daten |
| Normale Gruppen | über die Hauptsitzung | ✅ eine Gruppe ohne Themen = ein Projekt: verknüpft aus dem Privatchat des Besitzers, ihre Sitzung antwortet in der Gruppe |
| Oberflächensprachen | Englisch | ✅ Russisch, Englisch, Spanisch, Chinesisch, Französisch, Deutsch — `/lang`, standardmäßig die Telegram-Sprache |
| Tests | ❌ | ✅ Unit- und Integrationstests mit einer simulierten Bot API |

## Was es kann

| | |
|---|---|
| **Gemeinsamer Daemon** | Ein Prozess fragt Telegram für alle Sitzungen ab. Mehrere Claude-Code-Sitzungen und `claude -p` arbeiten mit einem Bot ohne 409 Conflict. |
| **Themen** | Sie verbinden eine Forum-Supergruppe aus dem Privatchat (`/connect_group`); jedes Projekt bekommt sein eigenes Thema. In General liegen das angeheftete Steuerpult und die Steuerbefehle. |
| **Sitzungstypen** | 👤 eine Sitzung pro Nutzer (sein Privatchat und seine Nachrichten in General), 📂 eine Sitzung pro Projekt in dessen Thema. Sitzungen starten bei der ersten Nachricht von selbst; ein Wächter meldet beendete Sitzungen und bietet einen Neustart-Knopf. |
| **Live-Fortschritt** | Die Antwort erscheint, während sie geschrieben wird (im Privatchat als Entwurf, in Gruppen in der Fortschrittsnachricht), pro Chat umschaltbar in „/menu → ⚙️“. Während Claude arbeitet: im Privatchat ein nativer Entwurf mit einem Block „Überlegungen“; im Thema eine aktualisierte Nachricht „⏳ Arbeite…“ mit Aktionen und dem Knopf **⏹ Stopp** (unterbricht den Durchgang über tmux). |
| **Antwortknöpfe** | Das Werkzeug `ask_user` und `reply(buttons)`: Optionen per Tipp, die Antwort geht an die Sitzung zurück. |
| **Projekte aus Themen** | Thema in der Gruppe anlegen → Ordner `~/projects/<Gruppen-ID>-<Themen-ID>` (nach IDs – umbenannte oder doppelte Titel kollidieren nicht; Gruppen-ID ohne Minus) und eine neue Claude-Sitzung in einem tmux-Fenster, an dieses Thema gebunden. Oder `/new_session <Name\|Pfad>`. Der Start wird mit dem Knopf „✅ Start bestätigen“ bestätigt. |
| **Archiv** | „🗄 Archivieren“ auf der Projektkarte in `/sessions`: Die Sitzung endet, das Thema wird geschlossen. Thema wieder öffnen – eine neue Sitzung startet. Das Thema in Telegram zu schließen ist dasselbe wie Archivieren. |
| **Benachrichtigungen** | `notify` ohne eingehende Nachricht, automatisches „✅ Fertig“ nach einem langen Durchgang, `bewitched notify` und HTTP `/notify` für Skripte und CI. |
| **Das Steuerpult `/menu`** | Eine Nachricht mit Knöpfen für alles: Sitzungen, Themen, Statistik, Personen, Erinnerungen, Einstellungen dieses Chats, Hilfe. Das Befehlsmenü von Telegram zeigt nur `/menu`, `/sessions`, `/usage`, `/help`. |
| **Sitzungssteuerung** | „✅ Start bestätigen“ in der Startnachricht – ganz ohne Terminal. Die Karte in `/sessions`: ein Bild des tmux-Fensters mit Tasten (▶️ – aktualisiert sich eine Minute lang selbst), 🧹 `/compact`, 🆕 `/clear`, 🧠 Modellwechsel, 🕘 frühere Gespräche (`/resume` in derselben Sitzung), ⚡ Schnellbefehle, 🌿 Git (Status, Commits, PR, Diff als Datei), „♾ Immer in der Sitzung“ und „📌 Immer im Projekt“ für ein Werkzeug, eine Warnung, wenn sich der Kontext füllt. |
| **Externe Ereignisse** | `bewitched event --topic <Name> "Text"` oder `POST /event` – eine „📡“-Nachricht im Projektthema und an seine Sitzung. Alle 5 Minuten prüft der Bot den letzten GitHub-Actions-Lauf des Branches jeder Projektsitzung: fehlgeschlagen – „❌ CI fehlgeschlagen“ mit „🛠 Beheben“, wieder grün – „✅“. |
| **Sprache** | Sprach- und Videonachrichten werden lokal transkribiert; auf eine Sprachnachricht wird gesprochen geantwortet. Die russische Stimme liest Zahlen, Uhrzeiten, Daten und lateinische Wörter auf Russisch. Stimme und Tempo sind Chat-Einstellungen. |
| **Statistik** | `/usage` – Limit-Prozente mit Zurücksetzungszeit und Balken, Verbrauch nach Modell und Sitzung; Meldungen bei 80/95 % und im Moment der Zurücksetzung (🔔/🔕); „🌙 Tagesbilanz“; `/reports` – Tag, Woche, Monat mit Diagramm; die Kosten der Sitzung auf ihrer Karte; `/server` – Last der Maschine, das Daemon-Log und ein Neustart-Knopf; 👥 wer wie viel vom 5-Stunden-Fenster verbraucht hat, mit Meldung, wenn jemand mehr als `USER_SHARE_ALERT` nimmt. 🌙 Ruhezeiten – nachts ohne Ton. |
| **Keine Tokens** | Scheitert ein Zug am Abo-Limit, am Anfragelimit der API oder an leerem API-Guthaben, antwortet der Bot selbst in der Sprache des Chats („⏸ Das Claude-Abo hat keine Tokens mehr… Ich antworte direkt nach dem Zurücksetzen des Limits um 14:20“), speichert neue Nachrichten und gibt sie beim Zurücksetzen gesammelt an die Sitzung, die den abgebrochenen Zug zu Ende führt. Anfragelimit: neuer Versuch nach 2, 4, 8 … Min.; leeres Guthaben: auf „▶️ Jetzt fortsetzen“ warten (während der Pause auch in `/menu`). Andere Fehler bekommen einen klaren Hinweis statt nur englischem Text. |
| **Erinnerungen** | `/remind 2h prüfe die CI`, „tomorrow 9:00“, „every day 9:00“; zur fälligen Zeit kommt der Text im Chat und bei dessen Sitzung an; eine nicht laufende Sitzung wird gestartet. |
| **Personen** | `/invite` – Kontakt wählen, der Bot gibt Zugriff, startet die Sitzung und liefert einen Gruppenlink; `/users` und 🚫 – eine Person mit Sitzung, Ordner, Transkripten und Verlauf entfernen. Über `/telegram-bewitched:access` hinzugefügte Personen übernimmt der Daemon automatisch. |
| **Gruppen als Projekte** | Eine normale Gruppe (ohne Themen), die in access erlaubt ist, wird ein Projekt: Der Besitzer bekommt eine Karte im Privatchat – neues Projekt, vorhandener Ordner oder „kein Projekt“. Ihre Sitzung antwortet in der Gruppe; gesteuert aus dem Privatchat des Besitzers. |
| **Sprachen** | Die Bot-Oberfläche in 6 Sprachen: ru, en, es, zh, fr, de. Die Sprache eines Chats: `/lang` oder die Flaggen in „/menu → ⚙️“; standardmäßig im Privatchat die Telegram-Sprache des Nutzers, sonst `BOT_LANGUAGE`. Das Befehlsmenü von Telegram folgt der App-Sprache. |
| **Verlauf und Gedächtnis** | SQLite mit Volltextsuche, Antwort-/Zitat-/Weiterleitungskontext in jeder Nachricht, `get_history`, `search_messages`, Chat-Gedächtnis `save_memory`, Zusammenfassung beim Verbinden einer Sitzung, Zustellung der Nachrichten, die bei ausgeschalteter Sitzung kamen. |

## Voraussetzungen

- [Bun](https://bun.sh) ≥ 1.2.
- Claude Code mit Channels und dem Hook `MessageDisplay`.
- tmux – für den automatischen Start von Sitzungen, den Knopf „⏹ Stopp“, „👁 Bildschirm und Tasten“ und Befehle im Sitzungsfenster (ohne tmux teilt „Stopp“ dem Modell nur den Abbruch mit).
- Optional: `gh` (PR in „🌿 Git“, CI-Überwachung), ffmpeg und Python 3 (Sprache, Installation mit `bewitched voice install`).

## Installation

1. Legen Sie bei [@BotFather](https://t.me/BotFather) einen Bot an (`/newbot`) und kopieren Sie das Token.
2. In Claude Code:

```
/plugin marketplace add deniskelin/telegram_bewitched_plugin
/plugin install telegram-bewitched@bewitched
/telegram-bewitched:configure <Token>
```

   War vorher das offizielle Plugin installiert, werden `.env` und `access.json` beim ersten Start automatisch aus `~/.claude/channels/telegram/` übernommen.
3. Starten Sie eine Sitzung mit dem Kanal (siehe „Start“), schreiben Sie dem Bot privat – er antwortet mit einem 6-stelligen Code – und führen Sie in Claude Code `/telegram-bewitched:access pair <Code>` aus. Der erste gekoppelte Nutzer wird zum Besitzer. Mehr in [ACCESS.md](ACCESS.de.md).

**Das offizielle Plugin und der Fork dürfen nicht gleichzeitig dasselbe Token abfragen.** Deaktivieren Sie das offizielle (`/plugin disable telegram@claude-plugins-official`) oder starten Sie Claude ohne dessen `--channels`. Sieht der Daemon das offizielle Plugin mit demselben Token laufen, wartet er, statt um die Abfrage zu kämpfen.

## Start

Während der Research Preview werden Kanäle von Drittanbietern mit einem Entwicklungs-Flag geladen (es erscheint eine Bestätigung, die angenommen werden muss):

```
tmux new -s claude
claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched
```

Die erste Sitzung startet den Daemon. Er läuft weiter, wenn Sitzungen enden, damit Steuerpult und `/notify` immer antworten.

CLI-Befehle laufen im Plugin-Ordner: Nach einer Installation aus dem Marketplace ist das `~/.claude/plugins/cache/bewitched/telegram-bewitched/<Version>/` (oder ein Klon des Repositorys).

```
cd ~/.claude/plugins/cache/bewitched/telegram-bewitched/<Version>
bun bin/bewitched.ts daemon status|stop|restart|logs
bun bin/bewitched.ts daemon install-cron     # @reboot in der crontab
bun bin/bewitched.ts voice install           # Sprache, siehe docs/voice.md
bun bin/bewitched.ts notify --topic myproj "Build fehlgeschlagen"
bun bin/bewitched.ts event --topic myproj --source ci "Deploy fehlgeschlagen: …"   # an Thema und Sitzung des Projekts
```

## Aktualisierung

```
claude plugin marketplace update bewitched
claude plugin update telegram-bewitched@bewitched
```

Starten Sie danach die Claude-Code-Sitzungen neu (Client und Hooks kommen aus der neuen Version) und den Daemon – mit dem Befehl aus dem Ordner der **neuen** Version: `bun bin/bewitched.ts daemon restart`. Der Knopf „♻️ Daemon neu starten“ in `/server` startet die Version neu, die bereits läuft. Falls Sie `install-cron` genutzt haben, führen Sie es im neuen Ordner erneut aus – der Eintrag wird ersetzt.

## Themen in einer Supergruppe

1. Im Privatchat mit dem Bot: `/connect_group`.
2. „➕ Bot zu einer Gruppe hinzufügen“ → eine Gruppe mit aktivierten „Themen“ wählen → Adminrechte bestätigen (Themen verwalten, anheften, löschen).
3. Die Verbindung im Privatchat bestätigen.

Rechte richten sich nach Rollen (FR-4): 👑 der Besitzer – der erste gekoppelte Nutzer – darf alles; 👤 ein Mitglied schreibt in Sitzungen, beantwortet Knöpfe und drückt ⏹; 👁 ein Beobachter liest nur. Berechtigungen erteilen, Steuerpult, Archiv, Einstellungen sowie Personen einladen oder entfernen sind dem Besitzer vorbehalten; Rollen werden in `/users` umgestellt. Andere Gruppenmitglieder werden ignoriert. Native Entwürfe von Telegram funktionieren nur im Privatchat, daher erscheint der Fortschritt in Themen als aktualisierte Nachricht.

`/sessions` ist ein Menü in einer einzigen Nachricht, wie bei BotFather: die Liste der Sitzungen mit je einem Knopf; ein Knopf öffnet die Sitzungskarte mit Aktionen (⏹ Stopp, 👑 Zur Hauptsitzung machen, 🗄 Archivieren, 💬 Thema öffnen) und den Einstellungen ihres Chats (🔕0/🔔1/📢2 und „✅ fertig“); „« Zur Liste“ führt zurück. `/topics` ist dasselbe Menü für Themen: der Zustand jedes Themas (Sitzung, 💤 keine Sitzung, Warteschlange), eine Themenseite mit 💬 Öffnen, 📋 Sitzungskarte, 🚀 Sitzung starten, 🗄 Archivieren / ↩️ Wiederherstellen, 🗑 Löschen; das Archiv auf einer eigenen Seite. „👁 Bildschirm und Tasten“ (auf der Karte und in Startnachrichten) schickt die aktuelle Ansicht des tmux-Fensters mit den Knöpfen 1/2/3, Enter, Esc, ↑/↓, Tab – genug, um jede Frage im Fenster ohne `tmux attach` zu beantworten. „🌿 Git“ zeigt Status, letzte Commits und den PR des Branches (über `gh`); „📄 Diff als Datei“ schickt `git diff HEAD`. Unter einer Berechtigungsanfrage gibt es „♾ <Werkzeug> in dieser Sitzung immer“ (bis die Sitzung sich neu verbindet; Zurücksetzen auf der Karte) und „📌 <Werkzeug> im Projekt immer“ (der Bot speichert die Regel pro Projektordner; Entfernen auf der Karte). Die Knöpfe 🧹 `/compact`, 🆕 `/clear` und 🧠 Modell tippen den Befehl ins Sitzungsfenster (nur zwischen Durchgängen). Die Karte zeigt: Typ (👑 Haupt- oder Projektsitzung), Status, `#id` und PID, Arbeitsordner, Branch, Thema, Ort in tmux (Sitzung, Fenster, Bereich) mit einem fertigen `tmux attach -t <Sitzung>:<Fenster>`, ob „⏹ Stopp“ verfügbar ist, Berechtigungsmodus, Modell und Kontextgröße, den aktuellen Durchgang und die letzte Aktion, den Befehl `claude --resume <id>`, den Namen aus `/rename`, ob 📱 Remote Control aktiv ist samt Link zur Sitzung auf claude.ai (nach dem Ereignis `remote_session_change` im Transkript; vor dem ersten solchen Ereignis nach dem Flag `--remote-control`/`--rc` oder `remoteControlAtStartup`) sowie die Zeit seit dem Start und seit der letzten Aktivität. Sitzungen, die ohne Kanal-Flag gestartet wurden, stehen in einem eigenen Block „👻 Ohne Kanal“ mit fertigem Neustart-Befehl: Sie erhalten keine Nachrichten und waren früher unsichtbar.

Alles Folgende gibt es auch als Knöpfe in **`/menu`** (das Befehlsmenü von Telegram enthält nur `/menu`, `/sessions`, `/usage`, `/help`). Steuerbefehle (Privatchat oder General): `/sessions`, `/topics`, `/permissions` (wartende Berechtigungsanfragen aller Sitzungen), `/send <Thema> <Text>`, `/broadcast <Text>`, `/rename <Thema> | <Name>`, `/archive <Thema>`, `/delete <Thema>`, `/new_session <Name|Pfad>`. In jedem Chat: `/verbose [0|1|2]` (🔕0 nur Antwort, 🔔1 + Aktionen, 📢2 + Modelltext; ohne Argument wird die aktuelle Stufe gezeigt), `/notify_done [off|long|always]`, `/lang ru|en|es|zh|fr|de|auto`, `/remember`, `/forget`, `/voice off|mirror|always`, `/transcript on|off`, `/macro add <Knopf> | <Text>` und `/macro del <n>` (Schnellbefehle des Chats), `/remind <wann> <Text>` (30m, 1h30m, „in 2 hours“, 18:30, „tomorrow 9:00“, „every day 9:00“; russische Formen gehen auch; zur fälligen Zeit kommt der Text im Chat und bei der Sitzung des Chats an, eine nicht laufende Sitzung wird gestartet), `/reminders`. Die Stufe steht auf den Sitzungskarten (Zeile 📣), lässt sich dort per Knopf ändern und erscheint in der Kopfzeile „⏳ Arbeite… · 🔔1“. Im Privatchat: `/server` (CPU, Speicher, Laufwerke, Claude-Code- und Sprachprozesse; „📜 Daemon-Log“, „♻️ Daemon neu starten“), `/users` (alle mit Zugriff; 🚫 löscht einen Nutzer: Zugriff, Sitzung und tmux-Fenster, Ordner, Transkripte und Privatchat-Verlauf – nach Bestätigung), `/invite` (Nutzer einladen: Kontakt wählen → bestätigen → der Bot gibt Zugriff, startet die Sitzung und schickt eine Einladung zum Weiterleiten), `/usage`, `/digest`, `/reports` (Berichte für Tag, Woche und Monat mit Verbrauchsdiagramm nach Stunden/Tagen/Wochen und Statistik; jeder wird per Knopf aktiviert und kommt am Ende des Zeitraums), `/main [id|reset]`, `/group`, `/disconnect_group`, `/status`.

`/usage` (nur Besitzer): das Abo aus `~/.claude/.credentials.json`, die Limit-Prozente (5 Stunden, Woche) mit Zurücksetzungszeit sowie der Token-Verbrauch über 5 Stunden, einen Tag und 7 Tage aus allen Transkripten zu API-Preisen, nach Modell und Sitzung. Die Prozente stammen vom **nicht dokumentierten** Anthropic-Endpunkt `api/oauth/usage` (den auch `/usage` in Claude Code aufruft) mit dem OAuth-Token des Abos. Er kann mit jedem Update aufhören zu funktionieren; dann zeigt `/usage` nur lokale Daten. `USAGE_LIMITS=off` schaltet die Abfrage ab. Die Abschnitte „Wer verbraucht“, „Nach Modell“ und „Nach Sitzung“ gelten für den per Knopf gewählten Zeitraum: 5 Stunden, Tag, Woche oder Monat (bei 5 Stunden und einer Woche ist „wer verbraucht“ ein Anteil am Abo-Fenster, sonst am Verbrauch).

## Mehrere Themengruppen

Die erste mit `/connect_group` verbundene Gruppe ist die Hauptgruppe: General, das angeheftete Steuerpult und die Sitzungen der Personen. Weitere verbinden Sie mit demselben `/connect_group` – sie werden zusätzliche Themengruppen (etwa Arbeits- und Privatprojekte). In `/topics` → „🗂 Themengruppen“ bekommt jede zusätzliche Gruppe Ordner (aus `PROJECTS_DIR` markiert): Ein Projekt darin bekommt sein Thema dort, alles andere geht in die Hauptgruppe; in einer zusätzlichen Gruppe angelegte Themen sind sofort ihre Projekte. `/topics` wechselt die Gruppe über eine Knopfreihe; „🔌 Trennen“ entfernt eine zusätzliche Gruppe.

## Normale Gruppen als Projekte

Eine Gruppe ohne Themen kann ein eigenes Projekt sein – ein Familienchat zu einer Website, ein Teamchat zu einem Dienst.

1. Fügen Sie den Bot der Gruppe hinzu und erlauben Sie sie im Terminal: `/telegram-bewitched:access group add <id>` (die ID nennt der Bot beim Hinzufügen; bis dahin schweigt er dort). Standardmäßig antwortet der Bot nur, wenn er erwähnt wird – `--no-mention` schaltet das ab (dazu muss der Privacy-Modus bei @BotFather aus sein – siehe [ACCESS.md](ACCESS.de.md)).
2. Bei der ersten Nachricht aus der Gruppe bekommt der Besitzer eine Karte im Privatchat: „📁 Neu“ (`~/projects/<Gruppen-ID>`), „📂 Projekt wählen“ (ein vorhandener Ordner) oder „🚫 Kein Projekt“ (die Hauptsitzung antwortet, wie bisher). Was in der Gruppe geschrieben wurde, wartet so lange in der Warteschlange.
3. Die Projektsitzung startet in tmux (bestätigt mit „✅ Start bestätigen“ in Ihrem Privatchat), antwortet direkt in der Gruppe und zeigt dort ihren Fortschritt. Sie hat kein Thema.

Alles andere aus dem Privatchat des Besitzers: die Sitzungskarte in `/sessions` (mit „👥 Gruppe lösen“), die Liste in „/menu → 👥 Gruppen“. Berechtigungsanfragen der Sitzung einer Gruppe gehen nur an den Besitzer. Erinnerungen, `/macro`, `/event` und CI-Meldungen funktionieren in der Gruppe wie in einem Thema.

## Sitzungstypen

Der Bot ist für einen kleinen Kreis eigener Leute (zum Beispiel eine Familie) in der Allowlist gedacht. Jeder hat seine eigene Claude-Sitzung; Projekte leben in den Themen der Gruppe.

| | Ordner | Was sie erhält |
|---|---|---|
| 👤 **Nutzersitzung** | `~/user/<user_id>` (`USERS_DIR`) | Den Privatchat dieses Nutzers und seine Nachrichten in General; antwortet dort |
| 📂 **Projektsitzung** | der Projektordner | Ihr Thema |
| 👑 **Hauptsitzung** | `MAIN_DIR` (Standard `~`) | Nur bei `USER_SESSIONS=off` (alle Privatchats und General, wie in 1.0) oder als Ersatz für `TOPIC_NO_SESSION=main` |

Die Verwaltungsarbeit erledigt der Daemon selbst, ohne Claude: Steuerbefehle, Schließen und Öffnen von Themen, Starten von Sitzungen, der Wächter.

- **Die Nutzersitzung startet von selbst.** Die erste Nachricht eines Nutzers → der Daemon legt `~/user/<id>` an und startet Claude in einer eigenen tmux-Sitzung `claude-user-<id>` ( mit `--continue`, falls es dort schon Gespräche gab); die Nachricht wartet in der Warteschlange und kommt nach dem Verbinden an.
- **Projektthema ohne Sitzung** (`TOPIC_NO_SESSION=launch`): Eine Nachricht startet die Projektsitzung. Klappt der Start nicht, schickt der Bot einen Befehl für den manuellen Start und schließt das Thema, bis die Sitzung verbunden ist.
- **Wächter.** Eine Sitzung hat sich von selbst beendet (kein Archiv, kein Leerlauf) → nach einer Minute bekommt der Besitzer «⚠️ Sitzung … wurde beendet» per DM, mit Befehlen zum Neustart und der Taste «🚀 Starten». Das Projektthema bekommt nur die Meldung, ohne Befehle und Tasten, und bleibt bis zur Wiederverbindung geschlossen; ein Mitglied, dessen eigene Sitzung endete, bekommt die Taste «🙋 Neustart anfragen», die die Anfrage an den Besitzer weiterleitet.
- **Beenden untätiger Sitzungen:** `USER_IDLE_MIN` und `PROJECT_IDLE_MIN`, Standard `0` – nie. Eine untätige Sitzung verbraucht keine Token, nur Speicher.

### Was Sie von Hand tun

1. **Jeden Sitzungsstart bestätigen.** Solange Claude-Code-Kanäle in der Research Preview sind, zeigt ein Start mit `--dangerously-load-development-channels` einen Warnbildschirm. Der Bot nimmt ihn nicht von sich aus an: Die Startnachricht hat einen Knopf „✅ Start bestätigen“ – beim Tippen beantwortet der Bot die Startfragen nacheinander (Ordnervertrauen „Yes, I trust this folder“ bei einem neuen Ordner und „I am using this for local development“), wartet, bis die Sitzung verbunden ist, und ersetzt den Bildschirm durch „✅ Sitzung verbunden“. Jede andere Frage bleibt bei Ihnen – „👁 Bildschirm und Tasten“ (mit „✖️ Schließen“) oder `tmux attach -t claude:<Fenster>`. Nötig bei der ersten Nachricht eines neuen Nutzers, nach einem Server-Neustart, nach einem Absturz der Sitzung und nach jedem Beenden wegen Leerlaufs (falls aktiviert).
2. **tmux auf dem Server bereithalten.** Ohne tmux starten Sitzungen nicht automatisch – der Bot schickt einen Befehl für den manuellen Start.
3. **Beendete Sitzungen neu starten** – mit „🚀 Starten“ aus der Wächter-Meldung (und erneut bestätigen) oder mit dem Befehl daraus.

### Nachteile

- Jeder Start wird per Tipp bestätigt (siehe oben); bis jemand tippt, wartet der Nutzer auf eine Antwort.
- Jede Sitzung ist ein eigener Claude-Code-Prozess: ~350–450 MB Speicher, und alle verbrauchen die Limits desselben Kontos.
- Getrennt wird nur nach Kontext und Gedächtnis: Alle Sitzungen laufen unter einem Systemnutzer, sehen die ganze Maschine, die Dateien der anderen und das gemeinsame `~/.claude`. Für eine Familie ist das eine bewusste Entscheidung, keine Sicherheitsgrenze.
- Antworten in General sieht die ganze Gruppe; die Sitzung eines Nutzers kann dort etwas aus seinem Privatchat zitieren, wenn er selbst darum bittet.
- Die Wächter-Meldung kommt auch nach einem absichtlichen `/exit` im Terminal – von außen ist das nicht von einem Absturz zu unterscheiden.
- `--continue` setzt das letzte Gespräch im Ordner fort, auch ein dort von Hand gestartetes.

`USER_SESSIONS=off` stellt das Verhalten von 1.0 wieder her: Alle Privatchats und General gehen an die Hauptsitzung in `MAIN_DIR`; `/main <id>`, `/main reset` und „👑 Zur Hauptsitzung machen“ auf der `/sessions`-Karte ordnen sie neu zu.

## Einstellungen (`~/.claude/channels/telegram-bewitched/.env`)

| Variable | Standard | |
|---|---|---|
| `TOPIC_MODE` | `project` | `project` – ein Thema pro Projekt, `session` – pro Sitzung, `off` |
| `PERMISSIONS_TO` | `topic` | Wohin Berechtigungsanfragen gehen: `topic`, `dm`, `both` |
| `STOP_MODE` | `interrupt` | `interrupt` (Escape in tmux), `notify`, `off` |
| `PROGRESS_FINAL` | `delete` | Was nach der Antwort mit der Fortschrittsnachricht geschieht: `delete`, `keep` |
| `NOTIFY_LONG_SEC` | `60` | Schwelle für einen „langen Durchgang“ bei der automatischen Meldung |
| `DAEMON_IDLE_EXIT_MIN` | `0` | Daemon nach N Minuten ohne Sitzungen beenden (0 – nie) |
| `BEWITCHED_HTTP_PORT` | `8797` | Lokales HTTP (Hooks, `/notify`, `/event`), nur 127.0.0.1, Token in `http.token` |
| `HISTORY_MAX_DAYS` | `90` | Aufbewahrungsdauer des Verlaufs |
| `PASSIVE_TOOLS` | `false` | Werkzeuge in Sitzungen ohne Kanal (`claude -p`) erlauben |
| `TOPIC_PROJECTS` | `auto` | Vom Besitzer angelegtes Thema → Projekt und Sitzung: `auto`, `ask` (Knopf), `off` |
| `PROJECTS_DIR` | `~/projects` | Wo Projektordner angelegt werden |
| `USER_SESSIONS` | `on` | Eine Sitzung für jeden Nutzer der Allowlist; `off` – wie in 1.0 (alles an die Hauptsitzung) |
| `USERS_DIR` | `~/user` | Wo die Ordner der Nutzersitzungen liegen (`<USERS_DIR>/<user_id>`) |
| `USER_IDLE_MIN` | `0` | Nutzersitzung nach N Minuten Leerlauf beenden (0 – nie) |
| `PROJECT_IDLE_MIN` | `0` | Projektsitzung nach N Minuten Leerlauf beenden (0 – nie) |
| `TOPIC_NO_SESSION` | `launch` | Projektthema ohne Sitzung: `launch` – starten, `main` – die Hauptsitzung antwortet, `queue` – nur Warteschlange |
| `WATCHDOG_GRACE_SEC` | `60` | Wie viele Sekunden nach dem Ende einer Sitzung sie gemeldet wird |
| `MAIN_DIR` | `~` | Ordner der Hauptsitzung (bei `USER_SESSIONS=off` – Privatchats und General) |
| `CONTEXT_WINDOW` | `1000000` | Größe des Kontextfensters für die Füllanzeige auf den Sitzungskarten |
| `CONTEXT_WARN_PCT` | `80` | Bei dieser Kontextfüllung `/compact` im Chat der Sitzung anbieten (0 – nie) |
| `DIGEST_AT` | `21:00` | Wann der Besitzer die „🌙 Tagesbilanz“ (Verbrauch, Commits, Limits) erhält; `off` – nie. Auf Anfrage: `/digest` |
| `LIMIT_ALERTS` | `80,95` | Meldeschwellen der Abo-Limits in Prozent; `off` – keine Meldungen. Ein Fenster, das eine Schwelle überschritten hat, erhält genau bei der Zurücksetzung „✅ Token wieder da“; in `/usage` lässt sich dasselbe mit 🔔 für jedes Fenster bestellen |
| `LIMIT_WARMUP` | `off` | `on`: eine Minute nach der Zurücksetzung des 5-Stunden-Fensters eine winzige `claude -p`-Anfrage (haiku) schicken, damit das nächste Fenster sofort beginnt. Auch der ⚡-Knopf in `/usage` |
| `LIMIT_CHECK_MIN` | `10` | Wie oft die Limits geprüft werden (Minuten, 0 – nie) |
| `USAGE_LIMITS` | `on` | `/usage`: Limit-Prozente beim nicht dokumentierten Anthropic-Endpunkt abfragen (`off` – nur lokale Daten) |
| `USER_SHARE_ALERT` | `40` | Den Besitzer benachrichtigen, wenn ein anderer Nutzer so viel Prozent des 5-Stunden-Fensters belegt hat (einmal pro Fenster; 0 – nie). Wirkt zusammen mit `LIMIT_ALERTS` |
| `CI_WATCH_MIN` | `5` | Wie oft der letzte GitHub-Actions-Lauf der Branches von Projektsitzungen geprüft wird (über `gh`; 0 – nie) |
| `QUIET_HOURS` | `off` | Ruhezeiten, z. B. `23:00-08:00`: Alles, was der Bot sendet, kommt ohne Ton an. Die Knöpfe in „/menu → ⚙️“ haben Vorrang vor `.env` |
| `BOT_LANGUAGE` | `ru` | Standardsprache der Oberfläche (`ru`, `en`, `es`, `zh`, `fr`, `de`), wenn weder der Chat noch der Besitzer eine gewählt hat und die Telegram-Sprache des Nutzers unbekannt ist |
| `TMUX_SESSION` | `claude` | Die tmux-Sitzung der Hauptsitzung (Nutzer- und Projektsitzungen bekommen eigene) |
| `STT_PROVIDER` / `TTS_PROVIDER` | `off` | Sprache: Transkription eingehender Nachrichten und gesprochene Antworten – siehe [docs/voice.md](docs/voice.md), Installation mit `bewitched voice install` |
| `CLAUDE_LAUNCH_CMD` | `claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched` | Der Befehl für eine neue Sitzung. Der Bot fügt `-n claude-user-<telegram id>` (Nutzersitzung) oder `-n claude-project-<Gruppen-ID>-<Themen-ID>` (Projekt, wie der Ordner) hinzu; eigene tmux-Sitzung und Fenster heißen genauso, `tmux ls` zeigt also, was was ist |

Der Zugriff (Kopplung, Allowlist, Gruppen) funktioniert wie im offiziellen Plugin, siehe [ACCESS.md](ACCESS.de.md) und `/telegram-bewitched:access`.

## Entwicklung

```
bun install
bun test          # Unit- und Integrationstests mit einer simulierten Bot API
bunx tsc --noEmit
```

Übersetzungen: Oberflächentexte werden auf Russisch als `t('…', { Variablen })` geschrieben; die Wörterbücher liegen in `src/i18n/<Sprache>.ts`; `bun scripts/i18n-keys.ts missing de` listet unübersetzte Texte auf, und ein Test prüft, dass alle Wörterbücher vollständig sind.

Aufbau: `server.ts` – ein schlanker MCP-Client pro Sitzung; `src/daemon/` – der Daemon (Abfrage, Routing, Themen, Streaming, Knöpfe, Werkzeuge, HTTP, Menüs und Bildschirme, Statistik, Berichte, Erinnerungen); `src/i18n/` – Oberflächensprachen; `src/voice/` und `voice/*.py` – Spracherkennung und -synthese; `hooks/` – Claude-Code-Hooks → Daemon; `bin/bewitched.ts` – die CLI. Abgleich mit Upstream: [UPSTREAM.md](UPSTREAM.md).
