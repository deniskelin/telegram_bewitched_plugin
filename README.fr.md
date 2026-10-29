# telegram-bewitched

🌍 [English](README.md) · [Русский](README.ru.md) · [Español](README.es.md) · [中文](README.zh.md) · Français · [Deutsch](README.de.md)

**Pilotez Claude Code depuis Telegram.** Vous écrivez à un bot — c'est Claude Code, qui tourne sur votre propre serveur avec accès à vos projets, qui répond. Chaque projet a son sujet dans un groupe, chaque personne sa propre session. Vous voyez ce que Claude fait en ce moment, approuvez les autorisations par boutons, envoyez des messages vocaux et suivez limites et dépenses dans `/usage`.

Techniquement, c'est un plugin de *canal* Claude Code (les channels permettent à une source externe d'envoyer des messages dans une session en cours) — un fork du [plugin officiel telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) avec un démon partagé, des sujets par projet dans un supergroupe à forums, une progression en direct, des boutons de réponse et un historique qui survit aux redémarrages.

Cahier des charges : [docs/TZ.md](docs/TZ.md) (en russe). Les étapes 0–9 sont réalisées, voix comprise (depuis 1.2.0). Au-delà du cahier des charges : le panneau `/menu`, les limites de l'abonnement et les dépenses, des rapports avec graphiques, des rappels, le pilotage de la fenêtre tmux et de git depuis Telegram, l'invitation et la suppression de personnes, une interface en six langues. Ce qui a changé : [CHANGELOG.md](CHANGELOG.md).

## Comment ça marche

```
Telegram : messages privés, sujets du groupe
        │ Bot API (un seul bot)
        ▼
démon bewitched (un par serveur) : interrogation, routage, file, historique (SQLite),
                                   panneau, rappels, limites, voix
        │ socket unix                       ▲ hooks Claude Code : progression, « terminé »
        ▼                                   │
sessions Claude Code dans tmux : 👤 une par personne (~/user/<id>) · 📂 une par projet (son sujet)
```

- Un message va à la session qui sert son chat : en privé, la session de l'expéditeur ; dans un sujet, la session du projet. Si la session ne tourne pas, le démon la lance dans tmux et livre le message dès sa connexion.
- La session répond avec les outils du plugin (`reply`, `ask_user`, …) ; pendant qu'elle travaille, le démon affiche sa progression.
- Les sessions démarrent avec le flag des canaux de développement, chaque lancement se confirme donc une fois — le bot propose un bouton « ✅ Confirmer le lancement ».

## Différences avec le plugin officiel

| Fonction | `telegram` officiel 0.0.7 | `telegram-bewitched` |
|---|---|---|
| Texte, photos, fichiers, vocaux en pièces jointes | ✅ | ✅ |
| Appairage, allowlist, groupes avec mention | ✅ | ✅ |
| Autorisations des outils par boutons | ✅ en privé | ✅ dans le sujet du projet ou en privé (`PERMISSIONS_TO`) ; « ♾ dans cette session » et « 📌 dans le projet » pour de bon |
| Plusieurs sessions Claude sur un bot | ❌ 409 Conflict, la deuxième session devient muette | ✅ un démon d'interrogation partagé ; les sessions s'enregistrent par socket |
| `claude -p` / sous-agents à côté du canal | ❌ lancent leur propre interrogation et cassent le canal | ✅ les sessions passives ne touchent pas aux messages entrants |
| Conflit avec un autre processus d'interrogation | 409 silencieux | ✅ attend et prévient le propriétaire en privé |
| Sujets | ❌ | ✅ supergroupe à forums, un sujet par projet, connexion depuis le privé avec `/connect_group` |
| Panneau de contrôle | ❌ | ✅ résumé épinglé dans General (avec `JOURNAL_CHAT_ID` — dans le sujet « 📌 État » du journal, avec les limites et barres comme dans `/usage`), `/sessions`, `/topics`, `/send`, `/broadcast`, `/rename`, `/archive`, `/delete`, `/main` |
| Nouvelle session depuis Telegram | ❌ | ✅ vous créez un sujet → dossier du projet + Claude dans une fenêtre tmux ; `/new_session` |
| Archive de session et de sujet | ❌ | ✅ « 🗄 Archiver » ferme la session et le sujet ; rouvrir le sujet relance la session |
| Progression en direct | ❌ seulement « écrit… » pendant 5 s | ✅ brouillon avec « réflexion » en privé (Bot API 10.2), « ⏳ Je travaille… » mis à jour avec les actions dans un sujet, `/verbose 0\|1\|2` |
| Arrêter un tour depuis Telegram | ❌ | ✅ bouton « ⏹ Arrêter » (Échap dans tmux) |
| Boutons de réponse | ❌ | ✅ `ask_user`, `reply(buttons)`, choix multiple, délai |
| Messages enrichis (Markdown : tableaux, code, listes) | ❌ seulement MarkdownV2 avec échappement manuel | ✅ `format: "rich"` (Bot API 10.1) avec repli sur le texte |
| Message sans message entrant (fin, erreur) | ❌ | ✅ `notify`, « ✅ Terminé » automatique après un long tour, `bewitched notify`, HTTP `/notify` |
| Historique du chat | ❌ la Bot API ne garde pas d'historique | ✅ SQLite + recherche plein texte : `get_history`, `search_messages`, `get_message` |
| Contexte de réponse, citations, transferts | ❌ seulement le texte du message | ✅ `reply_to_text`, `quote_text`, `forward_from`, lots de transferts |
| Mémoire entre redémarrages | ❌ | ✅ `save_memory`, un résumé et l'historique récent à la connexion d'une session |
| Messages quand la session est éteinte | ❌ perdus | ✅ conservés et livrés au démarrage de la session |
| Droits des utilisateurs | tous ceux de l'allowlist, en privé | ✅ rôles : 👑 propriétaire (tout), 👤 membre (écrit, répond, ⏹), 👁 observateur (lit seulement) ; autorisations et panneau au propriétaire ; les inconnus sont ignorés |
| Trouver le tmux de la session | — | ✅ par l'environnement ou le terminal du processus Claude |
| Messages vocaux | une pièce jointe sans texte | ✅ transcription par faster-whisper local, réponses vocales (Silero/Piper/cloud) — [docs/voice.md](docs/voice.md) |
| Limites et dépenses | ❌ | ✅ `/usage` : pourcentages des limites de l'abonnement, coût au tarif de l'API, alertes de seuil et de réinitialisation, bilan du jour, rapports avec graphique |
| Fenêtre de session et git depuis Telegram | ❌ | ✅ « ✅ Confirmer le lancement », « 👁 Écran et touches » (aussi en direct, ▶️), 🧹 `/compact`, 🆕 `/clear`, 🧠 modèle, 🕘 conversations passées, 🌿 état, commits, PR et diff |
| Événements externes et CI | ❌ | ✅ `/event` et `bewitched event` → sujet et session du projet ; un GitHub Actions en échec avec le bouton « 🛠 Réparer » |
| Commandes rapides | ❌ | ✅ `/macro` : vos propres boutons avec un texte pour la session du chat |
| Rappels | ❌ | ✅ `/remind` et l'outil `remind`, ponctuels ou quotidiens |
| Personnes | code d'appairage seulement | ✅ `/invite` depuis les contacts, `/users`, suppression avec toutes leurs données |
| Groupes ordinaires | via la session principale | ✅ un groupe sans sujets = un projet : lié depuis le privé du propriétaire, sa session répond dans le groupe |
| Langues de l'interface | anglais | ✅ russe, anglais, espagnol, chinois, français, allemand — `/lang`, par défaut la langue de Telegram |
| Tests | ❌ | ✅ tests unitaires et d'intégration avec une fausse Bot API |

## Ce qu'il fait

| | |
|---|---|
| **Démon partagé** | Un seul processus interroge Telegram pour toutes les sessions. Plusieurs sessions Claude Code et `claude -p` fonctionnent avec un bot sans 409 Conflict. |
| **Sujets** | Vous connectez un supergroupe à forums depuis le privé (`/connect_group`) ; chaque projet a son sujet. General contient le panneau épinglé et les commandes de contrôle. |
| **Types de session** | 👤 une session par utilisateur (ses messages privés et ses messages dans General), 📂 une session par projet dans son sujet. Les sessions démarrent seules au premier message ; un gardien signale celles qui s'arrêtent et propose un bouton de relance. |
| **Progression en direct** | La réponse s'affiche à mesure qu'elle s'écrit (en privé en brouillon, dans les groupes dans le message de progression), réglable par chat dans « /menu → ⚙️ ». Pendant que Claude travaille : en privé, un brouillon natif avec un bloc « réflexion » ; dans un sujet, un message « ⏳ Je travaille… » mis à jour avec les actions et un bouton **⏹ Arrêter** (interrompt le tour via tmux). |
| **Boutons de réponse** | L'outil `ask_user` et `reply(buttons)` : des options d'un toucher, la réponse revient à la session. |
| **Projets depuis des sujets** | Vous créez un sujet dans le groupe → un dossier `~/projects/<id du groupe>-<id du sujet>` (par id : titres renommés ou identiques sans conflit ; l'id du groupe sans le signe moins) et une nouvelle session Claude dans une fenêtre tmux liée à ce sujet. Ou `/new_session <nom\|chemin>`. Le lancement se confirme avec le bouton « ✅ Confirmer le lancement ». |
| **Archive** | « 🗄 Archiver » sur la fiche du projet dans `/sessions` : la session se termine, le sujet se ferme. Rouvrez le sujet : une nouvelle session démarre. Fermer le sujet dans Telegram équivaut à l'archiver. |
| **Notifications** | `notify` sans message entrant, « ✅ Terminé » automatique après un long tour, `bewitched notify` et HTTP `/notify` pour les scripts et la CI. |
| **Le panneau `/menu`** | Un seul message avec des boutons pour tout : sessions, sujets, statistiques, personnes, rappels, réglages de ce chat, aide. Le menu des commandes de Telegram n'affiche que `/menu`, `/sessions`, `/usage`, `/help`. |
| **Pilotage de la session** | « ✅ Confirmer le lancement » dans le message de lancement — sans terminal. La fiche dans `/sessions` : une capture de la fenêtre tmux avec des touches (▶️ — se rafraîchit seule pendant une minute), 🧹 `/compact`, 🆕 `/clear`, 🧠 changement de modèle, 🕘 conversations passées (`/resume` dans la même session), ⚡ commandes rapides, 🌿 git (état, commits, PR, diff en fichier), « ♾ Toujours dans la session » et « 📌 Toujours dans le projet » pour un outil, une alerte quand le contexte se remplit. |
| **Événements externes** | `bewitched event --topic <nom> "texte"` ou `POST /event` — un message « 📡 » dans le sujet du projet et pour sa session. Toutes les 5 minutes, le bot regarde la dernière exécution GitHub Actions de la branche de chaque session de projet : en échec — « ❌ La CI a échoué » avec « 🛠 Réparer » ; de nouveau verte — « ✅ ». |
| **Voix** | Les vocaux et les messages vidéo sont transcrits localement ; un vocal reçoit une réponse vocale. La voix russe lit en russe les nombres, heures, dates et mots latins. Voix et vitesse se règlent par chat. |
| **Statistiques** | `/usage` — pourcentages des limites avec heure de réinitialisation et barre, dépenses par modèle et par session ; alertes à 80/95 % et au moment de la réinitialisation (🔔/🔕) ; « 🌙 Bilan du jour » ; `/reports` — jour, semaine, mois avec graphique ; le coût de la session sur sa fiche ; `/server` — charge de la machine, journal du démon et redémarrage par bouton ; 👥 qui a consommé combien de la fenêtre de 5 heures, avec une alerte si quelqu'un dépasse `USER_SHARE_ALERT`. 🌙 Heures calmes — sans son la nuit. |
| **Plus de jetons** | Si un tour échoue sur la limite de l'abonnement, la limite de requêtes de l'API ou un solde épuisé, le bot répond lui-même dans la langue du chat (« ⏸ L'abonnement Claude n'a plus de jetons… Je répondrai juste après la réinitialisation de la limite à 14:20 »), enregistre les nouveaux messages et, à la réinitialisation, les remet à la session d'un coup en lui demandant de finir le tour interrompu. Limite de requêtes : nouvel essai après 2, 4, 8… min ; solde épuisé : attendre « ▶️ Continuer maintenant » (aussi dans `/menu` pendant la pause). Les autres échecs reçoivent une indication claire au lieu d'un texte anglais brut. |
| **Rappels** | `/remind 2h vérifie la CI`, « tomorrow 9:00 », « every day 9:00 » ; à l'heure dite, le texte arrive dans le chat et à sa session ; une session qui ne tourne pas est lancée. |
| **Personnes** | `/invite` — choisissez un contact, le bot donne l'accès, lance sa session et fournit un lien vers le groupe ; `/users` et 🚫 — supprimer une personne avec sa session, son dossier, ses transcriptions et son historique. Les personnes ajoutées via `/telegram-bewitched:access` sont prises en charge automatiquement par le démon. |
| **Groupes comme projets** | Un groupe ordinaire (sans sujets) autorisé dans access devient un projet : le propriétaire reçoit une fiche en privé — nouveau projet, dossier existant ou « pas un projet ». Sa session répond dans le groupe ; pilotage depuis le privé du propriétaire. |
| **Langues** | L'interface du bot en 6 langues : ru, en, es, zh, fr, de. La langue d'un chat : `/lang` ou les drapeaux dans « /menu → ⚙️ » ; par défaut en privé, la langue Telegram de l'utilisateur, sinon `BOT_LANGUAGE`. Le menu des commandes de Telegram suit la langue de l'application. |
| **Historique et mémoire** | SQLite avec recherche plein texte, contexte de réponse/citation/transfert dans chaque message, `get_history`, `search_messages`, mémoire du chat `save_memory`, résumé à la connexion d'une session, livraison des messages arrivés pendant que la session était éteinte. |

## Prérequis

- [Bun](https://bun.sh) ≥ 1.2.
- Claude Code avec les channels et le hook `MessageDisplay`.
- tmux — pour lancer les sessions automatiquement, le bouton « ⏹ Arrêter », « 👁 Écran et touches » et les commandes dans la fenêtre de session (sans tmux, « Arrêter » prévient seulement le modèle).
- Facultatif : `gh` (PR dans « 🌿 Git », surveillance de la CI), ffmpeg et Python 3 (voix, installée par `bewitched voice install`).

## Installation

1. Créez un bot avec [@BotFather](https://t.me/BotFather) (`/newbot`) et copiez le jeton.
2. Dans Claude Code :

```
/plugin marketplace add deniskelin/telegram_bewitched_plugin
/plugin install telegram-bewitched@bewitched
/telegram-bewitched:configure <jeton>
```

   Si le plugin officiel était installé, `.env` et `access.json` sont copiés depuis `~/.claude/channels/telegram/` automatiquement au premier démarrage.
3. Lancez une session avec le canal (voir « Lancement »), écrivez au bot en privé — il répond par un code à 6 caractères — puis exécutez `/telegram-bewitched:access pair <code>` dans Claude Code. Le premier utilisateur appairé devient le propriétaire. Plus de détails dans [ACCESS.md](ACCESS.fr.md).

**Le plugin officiel et le fork ne doivent pas interroger le même jeton en même temps.** Désactivez l'officiel (`/plugin disable telegram@claude-plugins-official`) ou lancez Claude sans son `--channels`. Si le démon voit le plugin officiel tourner avec le même jeton, il attend au lieu de se battre pour l'interrogation.

## Lancement

Pendant la research preview, les canaux tiers se chargent avec un flag de développement (une confirmation apparaît, il faut l'accepter) :

```
tmux new -s claude
claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched
```

La première session lance le démon. Il continue de tourner après la fermeture des sessions, pour que le panneau et `/notify` répondent toujours.

Les commandes de la CLI se lancent depuis le dossier du plugin : après une installation par le marketplace, c'est `~/.claude/plugins/cache/bewitched/telegram-bewitched/<version>/` (ou un clone du dépôt).

```
cd ~/.claude/plugins/cache/bewitched/telegram-bewitched/<version>
bun bin/bewitched.ts daemon status|stop|restart|logs
bun bin/bewitched.ts daemon install-cron     # @reboot dans la crontab
bun bin/bewitched.ts voice install           # voix, voir docs/voice.md
bun bin/bewitched.ts notify --topic myproj "la compilation a échoué"
bun bin/bewitched.ts event --topic myproj --source ci "le déploiement a échoué : …"   # vers le sujet et la session du projet
```

## Mise à jour

```
claude plugin marketplace update bewitched
claude plugin update telegram-bewitched@bewitched
```

Ensuite, redémarrez les sessions Claude Code (le client et les hooks viennent de la nouvelle version) et le démon — avec la commande depuis le dossier de la **nouvelle** version : `bun bin/bewitched.ts daemon restart`. Le bouton « ♻️ Redémarrer le démon » de `/server` redémarre la version déjà en cours. Si vous avez utilisé `install-cron`, relancez-le depuis le nouveau dossier — l'entrée est remplacée.

## Sujets dans un supergroupe

1. En privé avec le bot : `/connect_group`.
2. « ➕ Ajouter le bot à un groupe » → choisissez un groupe avec les « Sujets » activés → confirmez les droits d'administrateur (gérer les sujets, épingler, supprimer).
3. Confirmez la connexion en privé.

Les droits dépendent du rôle (FR-4) : 👑 le propriétaire — le premier utilisateur appairé — peut tout faire ; 👤 un membre écrit aux sessions, répond aux boutons et appuie sur ⏹ ; 👁 un observateur lit seulement. Approuver les autorisations, le panneau, l'archive, les réglages et inviter ou supprimer des personnes sont réservés au propriétaire ; les rôles se changent dans `/users`. Les autres membres du groupe sont ignorés. Les brouillons natifs de Telegram ne fonctionnent qu'en privé ; dans les sujets, la progression s'affiche dans un message mis à jour.

`/sessions` est un menu en un seul message, comme chez BotFather : une liste numérotée des sessions avec un bouton court chacune (« 1. Nom ● ») ; un bouton ouvre la fiche de la session : ⏹ Arrêter (pendant un tour), 👁 Écran, 🌿 Git, 💬 Ouvrir le sujet et trois groupes — « 🤖 Claude » (/compact, /clear, modèle, conversations passées, commandes rapides), « 🔔 Notifications » (🔕0/🔔1/📢2 et « ✅ terminé » pour son chat), « ⚙️ Gestion » (👑 Rendre principale, 🗄 Archiver, délier le groupe, retirer l'utilisateur, règles d'autorisation) ; chaque groupe a « « Retour », « « Vers la liste » revient en arrière. Les projets portent le nom de leur sujet ou groupe. `/topics` est le même genre de menu pour les sujets : l'état de chacun (session, 💤 pas de session, file d'attente), un écran de sujet avec 💬 Ouvrir, 📋 fiche de session, 🚀 Lancer la session, 🗄 Archiver / ↩️ Restaurer, 🗑 Supprimer ; l'archive sur sa propre page. « 👁 Écran et touches » (sur la fiche et dans les messages de lancement) envoie la vue actuelle de la fenêtre tmux avec les boutons 1/2/3, Entrée, Échap, ↑/↓, Tab — de quoi répondre à n'importe quelle question sans `tmux attach`. « 🌿 Git » affiche l'état, les derniers commits et la PR de la branche (via `gh`) ; « 📄 diff en fichier » envoie `git diff HEAD`. Sous une demande d'autorisation, il y a « ♾ Toujours <outil> dans cette session » (jusqu'à la reconnexion de la session ; réinitialisation sur la fiche) et « 📌 Toujours <outil> dans le projet » (le bot garde la règle par dossier de projet ; retrait sur la fiche). Les boutons 🧹 `/compact`, 🆕 `/clear` et 🧠 Modèle tapent la commande dans la fenêtre de la session (seulement entre deux tours). La fiche montre : le type (👑 principale ou de projet), l'état, `#id` et pid, le dossier de travail, la branche, le sujet, l'emplacement dans tmux (session, fenêtre, volet) avec un `tmux attach -t <session>:<fenêtre>` tout prêt, si « ⏹ Arrêter » est disponible, le mode d'autorisation, le modèle et la taille du contexte, le tour en cours et la dernière action, la commande `claude --resume <id>`, le nom de `/rename`, si 📱 Remote Control est actif avec un lien vers la session sur claude.ai (d'après l'événement `remote_session_change` de la transcription ; avant le premier, d'après le flag `--remote-control`/`--rc` ou `remoteControlAtStartup`), et le temps depuis le lancement et depuis la dernière activité. Les sessions lancées sans le flag des canaux apparaissent dans un bloc à part « 👻 Sans canal » avec une commande de relance : elles ne reçoivent pas de messages et étaient auparavant invisibles.

Tout ce qui suit est aussi disponible en boutons dans **`/menu`** (le menu des commandes de Telegram ne contient que `/menu`, `/sessions`, `/usage`, `/help`). Commandes du panneau (privé ou General) : `/sessions`, `/topics`, `/permissions` (demandes d'autorisation en attente pour toutes les sessions), `/send <sujet> <texte>`, `/broadcast <texte>`, `/rename <sujet> | <nom>`, `/archive <sujet>`, `/delete <sujet>`, `/new_session <nom|chemin>`. Dans n'importe quel chat : `/verbose [0|1|2]` (🔕0 la réponse seule, 🔔1 + actions, 📢2 + texte du modèle ; sans argument, affiche le niveau actuel), `/notify_done [off|long|always]`, `/lang ru|en|es|zh|fr|de|auto`, `/remember`, `/forget`, `/voice off|mirror|always`, `/transcript on|off`, `/macro add <bouton> | <texte>` et `/macro del <n>` (commandes rapides du chat), `/remind <quand> <texte>` (30m, 1h30m, « in 2 hours », 18:30, « tomorrow 9:00 », « every day 9:00 » ; les formes russes marchent aussi ; à l'heure dite, le texte arrive dans le chat et à la session du chat, et une session qui ne tourne pas est lancée), `/reminders`. Le niveau est visible sur les fiches de session (ligne 📣), se change là avec des boutons et figure dans l'en-tête « ⏳ Je travaille… · 🔔1 ». En privé : `/server` (CPU, mémoire, disques, processus Claude Code et voix ; « 📜 Journaux du démon », « ♻️ Redémarrer le démon »), `/users` (tous ceux qui ont l'accès ; 🚫 supprime un utilisateur : accès, session et fenêtre tmux, dossier, transcriptions et historique privé — après confirmation), `/invite` (inviter un utilisateur : choisir un contact → confirmer → le bot donne l'accès, lance sa session et envoie une invitation à transférer), `/usage`, `/digest`, `/reports` (rapports du jour, de la semaine et du mois avec un graphique des dépenses par heure/jour/semaine et des statistiques ; chacun s'active par un bouton et arrive à la fin de la période), `/main [id|reset]`, `/group`, `/disconnect_group`, `/status`.

`/usage` (propriétaire uniquement) : la formule de l'abonnement d'après `~/.claude/.credentials.json`, les pourcentages des limites (5 heures, semaine) avec l'heure de réinitialisation, et les jetons dépensés sur 5 heures, un jour et 7 jours dans toutes les transcriptions au tarif de l'API, par modèle et par session. Les pourcentages viennent du point d'accès **non documenté** d'Anthropic `api/oauth/usage` (celui qu'appelle `/usage` dans Claude Code) avec le jeton OAuth de l'abonnement. Il peut cesser de fonctionner à n'importe quelle mise à jour ; `/usage` n'affichera alors que les données locales. `USAGE_LIMITS=off` désactive la requête. Les sections « Qui consomme », « Par modèle » et « Par session » couvrent la période choisie par boutons : 5 heures, jour, semaine ou mois (pour 5 heures et la semaine, « qui consomme » est une part de la fenêtre de l'abonnement, sinon une part des dépenses).

## Plusieurs groupes de sujets

Le premier groupe connecté avec `/connect_group` est le principal : General, le panneau épinglé et les sessions des personnes. Connectez-en d'autres avec le même `/connect_group` : ils deviennent des groupes de sujets supplémentaires (par exemple projets pro et perso). Dans `/topics` → « 🗂 Groupes de sujets », chaque groupe supplémentaire reçoit des dossiers (cochés dans `PROJECTS_DIR`) : un projet qui s'y trouve a son sujet là, le reste va au groupe principal ; les sujets créés dans un groupe supplémentaire sont aussitôt ses projets. `/topics` passe d'un groupe à l'autre avec une rangée de boutons ; « 🔌 Déconnecter » retire un groupe supplémentaire.

## Groupes ordinaires comme projets

Un groupe sans sujets peut être un projet à part entière — un chat familial sur un site, un chat d'équipe sur un service.

1. Ajoutez le bot au groupe et autorisez-le dans le terminal : `/telegram-bewitched:access group add <id>` (le bot vous donne l'id à l'ajout ; d'ici là il y reste muet). Par défaut, le bot ne répond que lorsqu'on le mentionne — `--no-mention` désactive cela (il faut aussi désactiver le privacy mode chez @BotFather — voir [ACCESS.md](ACCESS.fr.md)).
2. Au premier message du groupe, le propriétaire reçoit une fiche en privé : « 📁 Nouveau » (`~/projects/<id du groupe>`), « 📂 Choisir un projet » (un dossier existant) ou « 🚫 Pas un projet » (la session principale répond, comme avant). Ce qu'a écrit le groupe attend dans une file en attendant.
3. La session du projet démarre dans tmux (confirmée par « ✅ Confirmer le lancement » dans votre privé), répond directement dans le groupe et y affiche sa progression. Elle n'a pas de sujet.

Tout le reste se fait depuis le privé du propriétaire : la fiche de session dans `/sessions` (avec « 👥 Délier le groupe »), la liste dans « /menu → 👥 Groupes ». Les demandes d'autorisation de la session d'un groupe ne vont qu'au propriétaire. Rappels, `/macro`, `/event` et notifications de CI fonctionnent dans le groupe comme dans un sujet.

## Types de session

Le bot est conçu pour un petit cercle de proches (une famille, par exemple) dans l'allowlist. Chacun a sa propre session Claude ; les projets vivent dans les sujets du groupe.

| | Dossier | Ce qu'elle reçoit |
|---|---|---|
| 👤 **Session utilisateur** | `~/user/<user_id>` (`USERS_DIR`) | Les messages privés de cet utilisateur et ses messages dans General ; elle y répond |
| 📂 **Session de projet** | le dossier du projet | Son sujet |
| 👑 **Principale** | `MAIN_DIR` (par défaut `~`) | Seulement avec `USER_SESSIONS=off` (les messages privés de tous et General, comme en 1.0) ou en secours pour `TOPIC_NO_SESSION=main` |

Le démon fait lui-même l'intendance, sans Claude : commandes du panneau, fermeture et ouverture des sujets, lancement des sessions, gardien.

- **La session utilisateur démarre seule.** Le premier message d'un utilisateur → le démon crée `~/user/<id>`, lance Claude dans sa propre session tmux `claude-user-<id>` ( avec `--continue` s'il y a déjà eu des conversations) ; le message attend dans la file et arrive une fois la session connectée.
- **Sujet de projet sans session** (`TOPIC_NO_SESSION=launch`) : un message lance la session du projet. Si le lancement échoue, le bot publie une commande de lancement manuel et ferme le sujet jusqu'à la connexion de la session.
- **Gardien.** Une session est partie d'elle-même (ni archive, ni inactivité) → une minute plus tard, le propriétaire reçoit en privé « ⚠️ La session … s'est arrêtée », avec les commandes pour la relancer et le bouton « 🚀 Lancer ». Le sujet du projet reçoit seulement l'avis, sans commandes ni boutons, et reste fermé jusqu'à la reconnexion ; un membre dont la propre session s'est arrêtée reçoit le bouton « 🙋 Demander un redémarrage », qui transmet la demande au propriétaire.
- **💤 Mise en veille des sessions inactives** (`/menu → 💤`) : une ligne par type — sessions des utilisateurs, celle du propriétaire, sessions de projets — « jamais · 12 h · jour · 3 jours · semaine ». Le message suivant relance une session en veille. Le membre reçoit « 💤 Votre session est en veille » avec « 🙋 Demander le lancement » ; le propriétaire (journal « 🖥 Sessions ») les commandes et 🚀 ; un sujet de projet une ligne. Par défaut : la session du propriétaire une semaine, les autres `USER_IDLE_MIN` / `PROJECT_IDLE_MIN` (`0` — jamais). Une session inactive ne consomme pas de jetons, seulement de la mémoire.

### Ce qu'il faut faire à la main

1. **Confirmer chaque lancement de session.** Tant que les canaux de Claude Code sont en research preview, un lancement avec `--dangerously-load-development-channels` affiche un écran d'avertissement. Le bot ne l'accepte pas de lui-même : le message de lancement porte un bouton « ✅ Confirmer le lancement » — à l'appui, le bot répond une à une aux questions de démarrage (confiance dans le dossier « Yes, I trust this folder » pour un nouveau dossier, et « I am using this for local development »), attend que la session se connecte et remplace l'écran par « ✅ Session connectée ». Toute autre question vous revient — « 👁 Écran et touches » (avec « ✖️ Fermer ») ou `tmux attach -t claude:<fenêtre>`. Nécessaire au premier message d'un nouvel utilisateur, après un redémarrage du serveur, après un plantage de session et après chaque fermeture pour inactivité (si activée).
2. **Garder tmux sur le serveur.** Sans lui, les sessions ne démarrent pas automatiquement — le bot enverra une commande de lancement manuel.
3. **Relancer les sessions arrêtées** — avec « 🚀 Lancer » dans l'avis du gardien (puis confirmer de nouveau) ou avec la commande qu'il contient.

### Inconvénients

- Chaque lancement se confirme d'un toucher (voir ci-dessus) ; tant que personne n'appuie, l'utilisateur attend une réponse.
- Chaque session est un processus Claude Code distinct : ~350–450 Mo de mémoire, et toutes consomment les limites d'un même compte.
- L'isolation n'est que de contexte et de mémoire : toutes les sessions tournent sous un même utilisateur système, voient toute la machine, les fichiers des autres et le `~/.claude` partagé. Pour une famille c'est un choix assumé, pas une frontière de sécurité.
- Tout le groupe voit les réponses dans General ; la session d'un utilisateur peut y citer quelque chose de ses messages privés s'il le demande lui-même.
- L'avis du gardien arrive aussi après un `/exit` volontaire dans le terminal — de l'extérieur, impossible de le distinguer d'un plantage.
- `--continue` reprend la dernière conversation du dossier, y compris une conversation lancée à la main.

`USER_SESSIONS=off` rétablit le comportement de la 1.0 : les messages privés de tous et General vont à la session principale dans `MAIN_DIR` ; `/main <id>`, `/main reset` et « 👑 Rendre principale » sur la fiche `/sessions` la réattribuent.

## Réglages (`~/.claude/channels/telegram-bewitched/.env`)

| Variable | Par défaut | |
|---|---|---|
| `TOPIC_MODE` | `project` | `project` — un sujet par projet, `session` — par session, `off` |
| `PERMISSIONS_TO` | `topic` | Où vont les demandes d'autorisation : `topic`, `dm`, `both` |
| `STOP_MODE` | `interrupt` | `interrupt` (Échap dans tmux), `notify`, `off` |
| `PROGRESS_FINAL` | `delete` | Que faire du message de progression après la réponse : `delete`, `keep` |
| `NOTIFY_LONG_SEC` | `60` | Seuil du « long tour » pour l'avis automatique |
| `DAEMON_IDLE_EXIT_MIN` | `0` | Arrêter le démon après N minutes sans session (0 — jamais) |
| `BEWITCHED_HTTP_PORT` | `8797` | HTTP local (hooks, `/notify`, `/event`), 127.0.0.1 seulement, jeton dans `http.token` |
| `HISTORY_MAX_DAYS` | `90` | Durée de conservation de l'historique |
| `PASSIVE_TOOLS` | `false` | Autoriser les outils dans les sessions sans canal (`claude -p`) |
| `TOPIC_PROJECTS` | `auto` | Un sujet créé par le propriétaire → projet et session : `auto`, `ask` (bouton), `off` |
| `PROJECTS_DIR` | `~/projects` | Où créer les dossiers des projets |
| `USER_SESSIONS` | `on` | Une session pour chaque utilisateur de l'allowlist ; `off` — comme en 1.0 (tout à la principale) |
| `USERS_DIR` | `~/user` | Où se trouvent les dossiers des sessions utilisateurs (`<USERS_DIR>/<user_id>`) |
| `USER_IDLE_MIN` | `0` | Fermer une session utilisateur après N minutes d'inactivité (0 — jamais) |
| `PROJECT_IDLE_MIN` | `0` | Fermer une session de projet après N minutes d'inactivité (0 — jamais) |
| `OWNER_IDLE_MIN` | `10080` | Fermer la session personnelle du propriétaire après N minutes d'inactivité (une semaine ; 0 — jamais). `/menu → 💤` remplace les trois |
| `TOPIC_NO_SESSION` | `launch` | Sujet de projet sans session : `launch` — la lancer, `main` — la principale répond, `queue` — file d'attente seulement |
| `WATCHDOG_GRACE_SEC` | `60` | Combien de secondes après l'arrêt d'une session la signaler |
| `MAIN_DIR` | `~` | Dossier de la session principale (avec `USER_SESSIONS=off` — messages privés et General) |
| `CONTEXT_WINDOW` | `1000000` | Taille de la fenêtre de contexte pour le pourcentage de remplissage sur les fiches |
| `CONTEXT_WARN_PCT` | `80` | À ce remplissage du contexte, proposer `/compact` dans le chat de la session (0 — jamais) |
| `DIGEST_AT` | `21:00` | Quand envoyer au propriétaire le « 🌙 Bilan du jour » (dépenses, commits, limites) ; `off` — jamais. À la demande : `/digest` |
| `LIMIT_ALERTS` | `80,95` | Seuils d'alerte des limites de l'abonnement en % ; `off` — aucune alerte. Une fenêtre qui a franchi un seuil reçoit « ✅ Jetons rétablis » au moment exact de la réinitialisation ; dans `/usage`, on peut demander la même chose avec 🔔 pour n'importe quelle fenêtre |
| `LIMIT_WARMUP` | `off` | `on` : une minute après la réinitialisation de la fenêtre de 5 heures, envoyer une toute petite requête `claude -p` (haiku) pour que la fenêtre suivante démarre aussitôt. Aussi le bouton ⚡ dans `/usage` |
| `LIMIT_CHECK_MIN` | `10` | Fréquence de vérification des limites (minutes, 0 — jamais) |
| `USAGE_LIMITS` | `on` | `/usage` : demander les pourcentages au point d'accès non documenté d'Anthropic (`off` — données locales seulement) |
| `USER_SHARE_ALERT` | `40` | Prévenir le propriétaire quand un autre utilisateur occupe ce pourcentage de la fenêtre de 5 heures (une fois par fenêtre ; 0 — jamais). Fonctionne avec `LIMIT_ALERTS` |
| `CI_WATCH_MIN` | `5` | Fréquence de consultation de la dernière exécution GitHub Actions des branches des sessions de projet (via `gh` ; 0 — jamais) |
| `QUIET_HOURS` | `off` | Heures calmes, par ex. `23:00-08:00` : tout ce qu'envoie le bot arrive sans son. Les boutons de « /menu → ⚙️ » priment sur `.env` |
| `BOT_LANGUAGE` | `ru` | Langue d'interface par défaut (`ru`, `en`, `es`, `zh`, `fr`, `de`) quand ni le chat ni le propriétaire n'en ont choisi et que la langue Telegram de l'utilisateur est inconnue |
| `TMUX_SESSION` | `claude` | La session tmux de la session principale (les sessions utilisateur et projet ont la leur) |
| `JOURNAL_CHAT_ID` | — | Un groupe (id, p. ex. `-100…`) pour les avis du bot au lieu du privé, chaque type dans son sujet : 📌 État (un message épinglé, toujours à jour : toutes les sessions et les limites comme dans `/usage` — sans commandes), 🛡 Accès (bot ajouté/retiré de groupes, messages de non-utilisateurs), 🖥 Sessions, 📊 Limites, 📰 Rapports, ⚙️ Démon. Ce qui vous attend — autorisations, lancements à confirmer, demandes d'utilisateurs, rappels demandés — reste en privé. Le groupe doit avoir des sujets, le bot être admin avec le droit de les gérer. Activer les sujets donne au groupe un nouvel id — le bot le suit tout seul. |
| `STT_PROVIDER` / `TTS_PROVIDER` | `off` | Voix : transcription des messages entrants et réponses vocales — voir [docs/voice.md](docs/voice.md), installation par `bewitched voice install` |
| `CLAUDE_LAUNCH_CMD` | `claude --dangerously-load-development-channels plugin:telegram-bewitched@bewitched` | La commande de lancement d'une nouvelle session. Le bot ajoute `-n claude-user-<telegram id>` (session utilisateur) ou `-n claude-project-<id du groupe>-<id du sujet>` (projet, comme le dossier) ; sa propre session et sa fenêtre tmux portent ce nom, `tmux ls` montre donc qui est qui |

L'accès (appairage, allowlist, groupes) fonctionne comme dans le plugin officiel : voir [ACCESS.md](ACCESS.fr.md) et `/telegram-bewitched:access`.

## Développement

```
bun install
bun test          # tests unitaires + d'intégration avec une fausse Bot API
bunx tsc --noEmit
```

Traductions : les chaînes de l'interface s'écrivent en russe sous la forme `t('…', { variables })` ; les dictionnaires sont dans `src/i18n/<langue>.ts` ; `bun scripts/i18n-keys.ts missing fr` liste les chaînes non traduites, et un test vérifie que tous les dictionnaires sont complets.

Structure : `server.ts` — un client MCP léger par session ; `src/daemon/` — le démon (interrogation, routage, sujets, streaming, boutons, outils, HTTP, menus et écrans, statistiques, rapports, rappels) ; `src/i18n/` — langues de l'interface ; `src/voice/` et `voice/*.py` — reconnaissance et synthèse vocales ; `hooks/` — hooks Claude Code → démon ; `bin/bewitched.ts` — la CLI. Synchronisation avec l'amont : [UPSTREAM.md](UPSTREAM.md).
