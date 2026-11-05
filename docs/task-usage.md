# Task usage accounting

The **Full usage report** button downloads a JSON report with exact counts and every stage/request, without transcript text or server paths. The card previews up to eight engine/model groups.

Use **Details** on the compact result card to reveal its **Task usage** report and additional actions. **Close report** hides only the report, while **Close task** changes the task lifecycle. Result cards include a collapsed **Task usage** report, with a durable task ID. A result being ready does not close the task: corrections, answers to questions, retries, engine handoffs and another-engine reviews can contribute further stages. **Close task** ends that identity; **Continue task** reopens it. Both buttons run inside the daemon and invoke no model. Repeating an existing result also invokes no model and adds no stage.

## Boundaries

Selecting **New task** and a task intent creates a new identity on the next message. Ordinary follow-ups use the sender's current open task in that exact chat/topic. The bot does not infer semantic task boundaries. Close the old task or explicitly select a new one for unrelated work. Replying to an original result/card restores that task, even after another task has begun. Sender, chat and topic are checked; another participant cannot adopt a private task ID by sending its value.

The ID travels in channel metadata through persistent queues, batching, reconnects, question answers, handoff summaries and cross-session relays. A separate engine review records its own CLI invocation against its parent's ID. Independently requested `/once` execution starts its own task. Multiple tasks combined into one CLI turn are labelled as shared, with their usage left unallocated rather than charged in full to each task.

## What is counted

- Input includes uncached input, cache reads and cache creation; cache reads are shown separately as a subset.
- Output includes reasoning tokens. Reasoning is shown separately only when the CLI exposes it; it is never added to output a second time.
- Stages count delivered execution attempts and auxiliary CLI invocations. Model request counts and token totals are grouped by engine/model. Observed tool-call IDs are deduplicated within a stage.
- Duration is the sum of stage durations, including parallel auxiliary work; it is not wall-clock latency or measured inference time.
- Dollar values use the existing API price table. They are estimates, not subscription charges. Models without a configured price are explicitly marked; a zero known-price subtotal does not imply a free execution.

## Source and recovery

Accounting reads the exact conversation transcript, not every session sharing a directory or a time window. Persisted request-ID baselines and subsequent stage boundaries prevent re-counting old messages. Channel task markers cut attribution at unrelated user prompts. Claude native subagent transcripts are read only from that conversation's own `subagents` directory. Parent Agent/Task tool-call IDs and their returned agent IDs establish task ownership, including late background results. Unlinked native requests are explicitly marked unallocated; they are never guessed from timestamps. Shared request IDs are deduplicated across files. Codex cumulative counters contribute deltas, including cached and reasoning counters.

The initial card says usage is pending. After the Stop hook, the daemon reads the transcript again after a short grace period and updates existing cards. Incomplete ended stages are retried after daemon restart without a model request; recently ended stages are rechecked for delayed final token events. Missing CLI usage remains pending rather than being invented. Existing tasks/results created before this feature have no retrospectively reconstructed task total.

No model can report its own token totals through result metadata. CLI records are the accounting source. CLI failures that expose no usage cannot be billed accurately; their stage is retained with pending usage. Tool counts cover observed hooks/CLI events, not unreported operations inside a model's native background agents. Subagent requests within one parent stage contribute tokens/models but are not separate bridge execution stages.
