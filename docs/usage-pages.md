# Usage report pages

`/usage`, Menu → Statistics → Limits and usage, and the local natural-language limit shortcut all open the same paginated report. The report stays in one message: arrows move between pages and the counter shows the current/total page. A single-page report omits the navigation row.

All model and owner/project rows remain reachable, including rows beyond the previous first-15 limit. Generated HTML is divided on line boundaries where possible. Oversized lines are split without cutting HTML tags, entities, surrogate pairs or ordinary grapheme clusters; open formatting is closed and reopened across pages. Page bodies use a conservative 3,600-character raw HTML budget, with room for headings and page counters below Telegram's 4,096-character text limit.

## View state

Each opened report has its own persistent snapshot: period, pages, current page, creation time, chat/topic scope and captured limit references. Navigation reads these saved pages without collecting statistics or invoking a model. Refresh rebuilds that snapshot and retains the selected period/page, clamping the page if the report became shorter. Changing the period resets only that report to its first page, without changing another report's selected period.

Snapshots survive daemon restarts and expire after seven days. New reports prune expired snapshots. Old/missing snapshots show an expiration notice and ask the owner to reopen `/usage`. Access is restricted to the subscription owner and the original chat/topic. Notification and warmup controls retain the current report's page navigation; reminders for already expired windows are rejected. Actions on the same report are serialized to prevent overlapping clicks from overwriting view state.

Legacy usage buttons remain supported; refreshing or changing period on a legacy report upgrades it to the paginated interface.

## Scope

This change fixes the size/dropped-row problem in the interactive usage report. It does not change provider quota calculations, API pricing tables, calendar report delivery, or the meaning of the existing reporting periods. Codex API-equivalent pricing is possible for identified models with published tariffs; adding those tariffs is separate from pagination. Monetary estimates must remain distinct from subscription charges, and unknown prices must not be represented as a verified zero.

Reference: [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage).
