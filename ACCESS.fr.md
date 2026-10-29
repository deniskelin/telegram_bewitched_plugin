# Telegram — accès et livraison

🌍 [English](ACCESS.md) · [Русский](ACCESS.ru.md) · [Español](ACCESS.es.md) · [中文](ACCESS.zh.md) · Français · [Deutsch](ACCESS.de.md)

Un bot Telegram est joignable par tous : quiconque trouve son nom peut lui écrire en privé et, sans filtre, ces messages iraient droit dans votre session. Le modèle d'accès décrit ici décide qui passe.

Par défaut, un message privé d'un expéditeur inconnu déclenche l'**appairage** : le bot répond par un code à 6 caractères et ignore le message. Vous exécutez `/telegram-bewitched:access pair <code>` dans votre session Claude Code pour l'approuver. Ensuite, ses messages passent.

Tout l'état se trouve dans `~/.claude/channels/telegram-bewitched/access.json`. Les commandes de la skill `/telegram-bewitched:access` modifient ce fichier ; le serveur le relit à chaque message entrant, les changements s'appliquent donc sans redémarrage. `TELEGRAM_ACCESS_MODE=static` fige la configuration telle qu'elle était au démarrage (l'appairage est alors indisponible, car il exige des écritures en cours d'exécution).

## En bref

| | |
| --- | --- |
| Politique par défaut | `pairing` |
| ID de l'expéditeur | ID numérique de l'utilisateur (par ex. `412587349`) |
| Clé de groupe | ID du supergroupe (négatif, préfixe `-100…`) |
| Particularité de `ackReaction` | Liste fixe d'emoji uniquement ; les autres ne font rien, sans erreur |
| Fichier de configuration | `~/.claude/channels/telegram-bewitched/access.json` |

## Inviter depuis le bot

Le propriétaire (la première entrée de `allowFrom`) peut aussi ajouter des personnes sans code : `/invite` en privé avec le bot, ou « 👥 Inviter » dans `/sessions`. Le sélecteur de contacts de Telegram renvoie l'ID de la personne ; après confirmation, le bot l'ajoute à `allowFrom`, prépare `USERS_DIR/<id>` et lance sa session, crée un lien à usage unique vers le groupe de sujets (le bot doit avoir le droit « Inviter des utilisateurs ») et envoie au propriétaire un message à transférer. Tous ceux de `allowFrom` ont les mêmes droits complets. En mode `static`, cela ne fonctionne qu'après un redémarrage (le fichier est écrit, l'instantané non).

La suppression fonctionne de la même manière : « 🚫 Supprimer l'utilisateur » sur la fiche de sa session dans `/sessions`, ou `/users`. Après une confirmation qui énumère ce qui sera supprimé, le bot le retire de `allowFrom` (et des listes de groupes), ferme sa fenêtre tmux, supprime `USERS_DIR/<id>` et ses transcriptions Claude Code, et oublie son historique privé, sa file d'attente, sa mémoire, ses rappels et ses réglages ; il peut aussi le retirer du groupe de sujets (ban + unban).

## Politiques des messages privés

`dmPolicy` décide du sort des messages privés d'expéditeurs absents de l'allowlist.

| Politique | Comportement |
| --- | --- |
| `pairing` (par défaut) | Répondre par un code d'appairage et ignorer le message. Approuver avec `/telegram-bewitched:access pair <code>`. |
| `allowlist` | Ignorer en silence, sans réponse. Utile si le nom du bot est facile à deviner et que les codes attireraient du spam. |
| `disabled` | Tout ignorer, y compris les utilisateurs et groupes autorisés. |

```
/telegram-bewitched:access policy allowlist
```

## ID des utilisateurs

Telegram identifie les utilisateurs par des **ID numériques** comme `412587349`. Les noms d'utilisateur sont facultatifs et modifiables ; les ID numériques sont permanents. L'allowlist contient des ID numériques.

L'appairage récupère l'ID automatiquement. Pour le trouver à la main, demandez à la personne d'écrire à [@userinfobot](https://t.me/userinfobot), qui répond avec son ID. Transférer à @userinfobot n'importe lequel de ses messages fonctionne aussi.

```
/telegram-bewitched:access allow 412587349
/telegram-bewitched:access remove 412587349
```

## Groupes

Les groupes sont désactivés par défaut. Il faut les autoriser un par un.

```
/telegram-bewitched:access group add -1001654782309
```

Les ID de supergroupe sont des nombres négatifs avec le préfixe `-100`, par ex. `-1001654782309`. L'interface de Telegram ne les affiche pas. Pour en trouver un, ajoutez temporairement [@RawDataBot](https://t.me/RawDataBot) au groupe (il renvoie un JSON avec l'ID du chat) ou ajoutez votre bot : il enverra au propriétaire l'ID du groupe et la commande toute prête ; `/telegram-bewitched:access` montre aussi les groupes dont les messages ont récemment été ignorés.

Avec `requireMention: true` (par défaut), le bot ne répond que lorsqu'on le mentionne avec @ ou qu'on répond à l'un de ses messages. `--no-mention` traite tous les messages ; `--allow id1,id2` limite quels membres peuvent le solliciter.

```
/telegram-bewitched:access group add -1001654782309 --no-mention
/telegram-bewitched:access group add -1001654782309 --allow 412587349,628194073
/telegram-bewitched:access group rm -1001654782309
```

**Groupes comme projets.** Un groupe autorisé qui n'est pas le groupe de sujets peut être lié à un dossier de projet. À son premier message (ou à l'ajout du bot), le propriétaire reçoit une fiche en privé : nouveau projet dans `PROJECTS_DIR`, dossier existant ou « pas un projet » (la session principale répond, comme avant). Les messages d'un groupe lié vont à la session de ce projet, qui répond dans le groupe ; les demandes d'autorisation de cette session ne vont qu'en privé au propriétaire. Pour délier : « 👥 Délier le groupe » sur la fiche de session ou dans « /menu → 👥 Groupes ». La liaison n'accorde aucun droit supplémentaire : qui peut écrire reste décidé par ce fichier.

**Privacy mode.** Par défaut, les bots Telegram ont le privacy mode activé : le serveur Telegram filtre les messages du groupe avant qu'ils n'atteignent votre code et ne livre que les mentions @ et les réponses. Cela correspond à `requireMention: true`, donc c'est normalement invisible. Pour `--no-mention`, il faut le désactiver : écrivez `/setprivacy` à [@BotFather](https://t.me/BotFather), choisissez votre bot, puis **Disable**. Sans cette étape, Telegram ne livre jamais ces messages, quelle que soit la configuration locale.

## Détection des mentions

Dans les groupes avec `requireMention: true`, l'un des éléments suivants déclenche le bot :

- une mention structurée `@nomdubot` ;
- une réponse à l'un des messages du bot ;
- une correspondance avec l'une des expressions régulières de `mentionPatterns`.

```
/telegram-bewitched:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Livraison

Le comportement sortant se règle avec `/telegram-bewitched:access set <clé> <valeur>`.

**`ackReaction`** réagit aux messages entrants à leur réception. Telegram n'accepte qu'une **liste fixe** d'emoji de réaction ; tout autre est ignoré sans erreur. La liste complète de la Bot API :

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram-bewitched:access set ackReaction 👀
/telegram-bewitched:access set ackReaction ""
```

**`replyToMode`** règle le fil des réponses découpées : quand une longue réponse est coupée, `first` (par défaut) ne rattache que le premier morceau au message entrant ; `all` les rattache tous ; `off` envoie tous les morceaux séparément.

**`textChunkLimit`** fixe le seuil de découpage. Telegram refuse les messages de plus de 4096 caractères.

**`chunkMode`** choisit la stratégie : `length` coupe exactement au seuil ; `newline` préfère couper entre les paragraphes.

## Référence des commandes

| Commande | Effet |
| --- | --- |
| `/telegram-bewitched:access` | Afficher l'état : politique, allowlist, appairages en attente, groupes actifs. |
| `/telegram-bewitched:access pair a4f91c` | Approuver le code `a4f91c`. Ajoute l'expéditeur à `allowFrom` et envoie une confirmation sur Telegram. |
| `/telegram-bewitched:access deny a4f91c` | Rejeter un code en attente. L'expéditeur n'est pas prévenu. |
| `/telegram-bewitched:access allow 412587349` | Ajouter directement un ID d'utilisateur. |
| `/telegram-bewitched:access remove 412587349` | Retirer de l'allowlist. |
| `/telegram-bewitched:access policy allowlist` | Définir `dmPolicy` : `pairing`, `allowlist`, `disabled`. |
| `/telegram-bewitched:access group add -1001654782309` | Activer un groupe. Options : `--no-mention` (exige aussi de désactiver le privacy mode), `--allow id1,id2`. |
| `/telegram-bewitched:access group rm -1001654782309` | Désactiver un groupe. |
| `/telegram-bewitched:access set ackReaction 👀` | Définir une clé : `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |

## Fichier de configuration

`~/.claude/channels/telegram-bewitched/access.json`. Un fichier absent équivaut à la politique `pairing` avec des listes vides : le premier message privé déclenche l'appairage.

```jsonc
{
  // Traitement des messages privés d'expéditeurs absents d'allowFrom.
  "dmPolicy": "pairing",

  // ID numériques des utilisateurs autorisés à écrire en privé.
  "allowFrom": ["412587349"],

  // Groupes où le bot est actif. Objet vide = privé seulement.
  "groups": {
    "-1001654782309": {
      // true : ne répondre qu'aux mentions @ et aux réponses.
      // false exige aussi de désactiver le privacy mode via BotFather.
      "requireMention": true,
      // Qui peut solliciter le bot. Vide = tout membre (selon requireMention).
      "allowFrom": []
    }
  },

  // Expressions régulières (insensibles à la casse) valant mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji de la liste fixe de Telegram. Chaîne vide = désactivé.
  "ackReaction": "👀",

  // Fil des réponses découpées : first | all | off
  "replyToMode": "first",

  // Seuil de découpage. Telegram refuse > 4096.
  "textChunkLimit": 4096,

  // length = couper au seuil ; newline = préférer les paragraphes.
  "chunkMode": "newline"
}
```
