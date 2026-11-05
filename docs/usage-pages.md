# Control panel, sessions and usage reports

The compact menu links to Sessions, Limits and Period reports. More contains secondary controls. The pinned dashboard defaults to a short view, prioritizes sessions needing attention, and links to the full list. Session lists show the owner even when offline, use seven additional sessions per page, retain filter/page on return, and offer attention, working, project, user and passive-session filters. Agent custom icons and grapheme-safe shortened names leave the status visible. Task titles are shown only in their original chat/topic; the shared dashboard omits private task text.

## Report navigation

Reports initially show a summary with exactly two buttons: Details and Close report. Details exposes periods, models, projects/users, limits, commits, charts, CSV/JSON exports and notification controls. Collapse returns to the summary. Charts are generated on demand, with tokens, model responses or API equivalent as the metric. All rows remain reachable through pages in one message; HTML tags, entities and graphemes survive splitting. Page bodies have a conservative 3,600-character budget.

Each report has its own persisted, chat/topic-bound snapshot, selected period, section and page. Navigation invokes no model and does not recollect data. Refresh rebuilds the selected period; changing one report does not change another. Actions on one report serialize. Owner-only callbacks reject another chat/topic and expired snapshots. Interactive snapshots expire after seven days; reopen `/usage` when prompted.

## Consistent periods and accounting

Claude transcripts and Codex rollouts feed the same aggregation for interactive, daily, weekly and monthly reports. Five hours is a rolling interval. Day/week/month support rolling 24 hours/7 days/30 days, current calendar period and previous calendar period. Calendar boundaries follow the daemon's local timezone, displayed with the full date range. Current periods compare against an equally elapsed portion of the previous period, clamped to its end. Scheduled reports retain their completed historical range. Current quota observations are labeled separately from historical activity.

Tokens include fresh input, cached input, cache creation and output. Reasoning is an output subset and is not added twice. Model responses count CLI usage records, not user messages. Activity depends on recorded responses, including unknown-price models. Model, project and user totals use the same selected records as the chart. Project identity uses its full path internally; friendly names and short stable identifiers disambiguate identical names. Exports omit server paths; CSV neutralizes spreadsheet formulas.

Shares describe **observed tokens**, not a share of the provider's subscription quota. Provider windows remain authoritative for quota. Expired Codex observations become unknown and retain their last value; crossing a reset time does not fabricate 0%. Reports show source time, remaining quota and reset time. Forecasts require four fresh, monotonic observations over at least 15 minutes in one reset window, a stable trend and predicted exhaustion before reset; otherwise the UI states that data is insufficient. They are estimates, not provider guarantees.

## Codex API equivalents

Known model IDs are valued using published OpenAI rates verified on **2026-11-05**. This is an API-equivalent estimate, **not subscription spending or an invoice**. Supported models: GPT-6 Astra, GPT-6.1 Sol/Terra, GPT-6 Luna, and GPT-5/5.1/5.2/5.3 Codex. Date-suffixed IDs use the corresponding exact base model; unknown models and unsupported service tiers remain unpriced.

For GPT-6 models, input plus cached input above 272,000 tokens uses the published long-context multipliers. Observed fast/priority and flex/batch tiers apply verified multipliers where supported; absent tier information uses Standard as an estimate. GPT-5.3 Codex fast pricing is supported. Cache-write, tool and regional surcharges absent from CLI logs cannot be reconstructed. Historical records use this tariff table rather than historical invoices. Unknown portions are displayed and are never silently valued at zero.

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage).

## Scheduled delivery

Scheduled reports persist a compact screen before sending. A recipient/topic and completed period identify the job. Only a successful Bot API acknowledgement marks it sent. Failures retry with bounded exponential backoff, survive daemon restarts and remain eligible after the period changes; disabling a report cancels pending jobs of that kind. Details and charts remain on demand. Manual reports preserve their originating forum topic.

Delivery is at least once: a process crash after Telegram accepted a message but before its acknowledgement was committed can produce a duplicate on retry. The Bot API provides no idempotency key for this gap. This queue does not promise exactly-once delivery.
