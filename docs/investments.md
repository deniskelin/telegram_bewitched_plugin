# Investments: independent daemon module

The module runs without an LLM or an agent session. It is a service profile bound to a Telegram topic, rather than a permanently prompted trading agent. An active profile keeps the daemon alive when no agent sessions exist. Module-topic messages, including voice and files, are handled by its menu and never forwarded to an agent.

`/invest` opens Portfolio, News, Calendar, Operations, Strategy and module status. The owner can refresh, pause/resume monitoring, navigate long reports and export JSON, CSV and an announced-payment ICS calendar. Access is restricted to the owner’s DM and the configured topic. A Telegram topic is visible to the group's participants; callback authorization does not make existing messages private.

## What this release implements

- Up to four explicitly selected accounts, including one optional strategy account, with broker-enforced read-only access. A full-access token is rejected. The adapter contains no real order or transfer methods.
- Portfolio NAV and positions, operation pagination, amended/cancelled operations, exact nanounit arithmetic and source timestamps. Initial operation backfill is 90 days; subsequent fetches overlap 48 hours. Retained operation history is bounded to 100 days.
- Ten-minute collection, with a one-minute scheduler heartbeat for delivery retries. No repeated model invocation, no model token expense, and no agent keepalive prompts.
- Daily morning news at 10:00 Europe/Moscow by default; source RSS/Atom feeds and issuer keywords must be explicitly configured. Morning cutoff advances after successful delivery. A source's publication time and current holdings filter relevance.
- Conservative headline signals, labelled **requires verification**. This is a rules-based candidate detector, not semantic validation or guaranteed full-market news coverage. Exact URL fingerprints deduplicate repeated feed entries. Serious-event completeness depends on configured sources; paraphrases/reposts across distinct URLs can still duplicate a story.
- Price movement alerts require a verified active exchange schedule, two recent samples, advancing exchange quote timestamps, both a movement threshold and an estimated RUB portfolio-impact threshold. Fresh price timestamps come from GetLastPrices. No FX conversion guesses are used for these rules. The same direction/severity band is bounded per instrument/account/day. Corporate-action-aware interpretation remains a later analytical layer; a price signal requests verification rather than asserting a fundamental event.
- Evening snapshots five minutes after the broker-provided main or last session close. The calendar, not weekday assumptions, determines whether a trading session exists.
- Separate strategy-account reporting; a local paper-only target-weight simulator is optional. It is **not** the broker's sandbox and sends no sandbox/real orders. It simulates whole shares currently available in the monitored RUB share quote set, commissions and available cash. Missing quotes block rebalance; automatic rebalance runs at most daily. No margin/shorting, slippage, dividends or exchange-lot modelling is implied. Results do not demonstrate executable real-world returns.
- Upcoming announced coupons/dividends, one/seven-day reminders and separate confirmed receipt notifications. Entitlement, record date and broker-credit date are not interchangeable. Announced totals use current quantities and require entitlement verification; actual credits come from executed operations. Actual receipts are shown separately rather than guessed onto an ambiguous announcement. An unknown dividend-payment date remains unknown; the record date is preserved separately and is never substituted into a payment reminder or ICS event.
- Source failure counters, pause persistence, an acknowledged outbox and restart-safe scheduled jobs. A broker failure never becomes an empty portfolio. Sent outbox entries are retained 30 days; news seven days/1,000 entries.

## Setup without sending secrets to an agent

The module is inactive unless `INVESTMENTS_CONFIG` points to a valid private JSON file. A disabled configuration can bind the topic/menu without making broker requests. The example is `docs/examples/investments.json`; it uses the Investments topic created for this installation and contains no accounts or tokens.

Create a private config locally:

```bash
bun bin/investments.ts init /private/investments.json -1004291818146 1316
bun bin/investments.ts check /private/investments.json
```

Then edit it locally:

```json
{
  "enabled": false,
  "chatId": "-1004291818146",
  "threadId": 1316,
  "timezone": "Europe/Moscow",
  "morning": "10:00",
  "close": "main",
  "accounts": [
    { "id": "SELECTED_ACCOUNT_ID", "name": "Primary", "tokenEnv": "INVEST_PRIMARY" }
  ],
  "feeds": [],
  "maxPositionPct": 30,
  "priceAlertPct": 5,
  "portfolioImpactPct": 1
}
```

The file must have mode 0600 and be at most 128 KiB. Account IDs and aliases are configured explicitly. Broker tokens belong in the daemon's private environment/configuration on the server, under the referenced `INVEST_*` names; never in the JSON example, chat, tool arguments or Git. Tokens must be read-only, preferably restricted at the broker to individual accounts.

Set `INVESTMENTS_CONFIG` to the absolute path, enable the profile only after accounts/sources/thresholds are reviewed, and restart the daemon. Existing operational restart approval still applies. Configuration changes currently require restart. The offline `check` command validates file/settings/credential presence, not live broker connectivity; live account permission checks happen on synchronization. Initial failed connections are reported as errors, not silently considered verified.

At module initialization, credential values are captured privately and their configured environment names removed from the daemon environment to reduce accidental inheritance by future agent processes. This is not an OS security boundary against agents running as root: strict confidentiality requires separate service identities and protected secret storage. The module never puts raw credentials in messages, exports or model prompts. Error bodies from the broker are not exposed.

## Feeds and virtual strategy

Feed configuration is explicit:

```json
{
  "url": "https://issuer.example/news.rss",
  "name": "Official issuer source",
  "keywords": { "INSTRUMENT_UID": ["Exact issuer name"] }
}
```

Use trusted official sources. Fetching is bounded to 1 MiB, uses HTTPS/timeouts and no redirects, and rejects resolved loopback/private destinations. Links must stay on the feed's host. This is defense in depth for owner-controlled configuration, not a general-purpose URL proxy or a perfect DNS-rebinding sandbox. Issuer keyword matching uses word boundaries; similarly named companies still require careful configuration. No default feed is invented and the UI states when news coverage is absent.

Optional paper configuration:

```json
{ "paper": { "cash": "100000", "weights": { "INSTRUMENT_UID": 30 }, "feeBps": 10 } }
```

The weights define a virtual target allocation, not investment advice. No strategy is activated by default. Assets outside the fresh monitored share-quote set prevent simulation rather than receiving fabricated prices.

## Accounting and delivery limitations

NAV change is adjusted for known external cash inputs/outputs. Dividends already included in NAV are not added twice. Unsupported transfers, security movements, foreign-currency cash flows and unknown operation kinds make the adjusted result unavailable. Values are observations from the **first sample of the day**, not an invented opening-auction baseline; the baseline time is shown. Per-position changes describe price movement since that sample, not cash-flow-adjusted position profit. Money calculations retain nanounit precision; display amounts are truncated to cents, quantities retain significant fractional digits.

This release does not calculate tax-lot realized profit, a complete historical TWR/XIRR, future floating coupons, amortization/offers via a complete bond-event model or retroactive entitlement from pre-sample holdings. Those require further broker reconciliation. Late receipts and changed operations produce notifications and appear in subsequent reads; the first closing snapshot is not a final tax/broker statement and is not silently rewritten into a historical closing-price series. `/invest` refresh/export provides the latest stored data.

The outbox is at least once. A crash after Telegram accepts a message but before its acknowledgement is persisted can duplicate it. Each report is persisted as one envelope before sending. Delivery is serialized, failed pages retry in order and cursor advancement waits for the final acknowledged page. Serious signal/data-loss jobs request audible delivery by default; set `criticalSound: false` for silent delivery. Ordinary reports remain silent. A paused module preserves pending jobs and sends them after resume, with original timestamps; it does not discard delayed history. A process supervisor is still needed for machine/process crashes; keepalive prevents intentional idle shutdown, not power loss.

Changing the destination produces a separate repository namespace so old portfolio messages cannot be replayed into a newly configured chat. Existing databases and exports must still be treated as private financial data.

## Relationship to the original specification

See [original requirements](investments-spec.md). The owner's follow-up makes the daemon service independent of agents and models. This release provides the executable read-only/monitoring/reporting core; optional prose analysis, buy/sell scenarios, semantic news verification and a broker sandbox adapter are not implemented or faked. Autonomous real-money trading is excluded. Real orders remain actions the owner performs at the broker.

No live broker connection or production financial schedule is claimed before credentials/accounts/sources are configured and validated. The supplied topic profile is disabled by default.

Sources: [T-Bank tokens](https://developer.tbank.ru/invest/intro/intro/token), [operations](https://developer.tbank.ru/invest/api/operations-service), [instruments/calendar contracts](https://developer.tbank.ru/invest/services/instruments/methods), [market data](https://developer.tbank.ru/invest/services/quotes/marketdata/), [limits](https://developer.tbank.ru/invest/intro/intro/limits).
