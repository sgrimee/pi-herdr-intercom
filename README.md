# pi-herdr-intercom

A [pi](https://pi.dev) extension that makes [pi-intercom](https://www.npmjs.com/package/pi-intercom) identities and message traffic visible in [Herdr](https://herdr.dev)'s Agents sidebar.

When you run several pi agents in Herdr panes and let them talk over pi-intercom, this shows **who is who** and **who is waiting on whom**:

- the sidebar shows `planner` / `worker-1` instead of `pi` for every agent;
- the Herdr agent name and the intercom name are kept in sync, so `herdr agent prompt planner …` and `intercom({ to: "planner" })` reach the same agent;
- live tokens show the last message, pending asks, and open conversations (`◷ worker-1×2, qa`, `✎ planner`).

> [!NOTE]
> Experimental. Open-conversation tracking is a heuristic (pi-intercom has no general "expects a response" flag), and it reads pi-intercom's session entries, which are not a public API. Tested with pi 1.2.0, pi-intercom 0.17.0 and Herdr 0.9.3.

## Requirements

- pi with [pi-intercom](https://www.npmjs.com/package/pi-intercom) installed
- Herdr with its pi integration installed: `herdr integration install pi`
- Node.js ≥ 22.19

The extension is inert outside Herdr (`HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` unset) and in non-interactive pi sessions (print/json/rpc, e.g. pi-subagents children), so it is safe to install globally.

## Install

```bash
pi install git:github.com/sgrimee/pi-herdr-intercom
# or pin a release
pi install git:github.com/sgrimee/pi-herdr-intercom@v0.1.0
```

Try it for one session without installing:

```bash
pi -e git:github.com/sgrimee/pi-herdr-intercom
```

## Sidebar layout

Names show up without any configuration. To also see the traffic tokens, add them to your Herdr sidebar rows (`/herdr-intercom layout` prints this snippet):

```toml
# ~/.config/herdr/config.toml  (then: herdr server reload-config)
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  [{ token = "agent", bold = true }, { token = "$ic_waits", fg = "#83a598" }, { token = "$ic_replies", fg = "#fabd2f" }],
]
```

## What it does

### Names

The pi session name is the pi-intercom address (set via `pi --name`, `/alias` or `/name`). It is pushed to Herdr as the pane's `display_agent`, so the sidebar's `agent` token shows `planner` instead of `pi`.

When the name is a valid Herdr agent name (`[a-z][a-z0-9_-]{0,31}` after normalisation) the Herdr agent is also renamed. A Herdr name set by someone else (e.g. `herdr agent start <name>`) is never overwritten.

In the other direction, if pi is unnamed but Herdr already knows the agent by a name (`herdr agent start reviewer-1 --kind pi …`), the pi session adopts that name, which makes it the intercom address too.

### Traffic tokens

Intercom traffic is tracked from pi-intercom's session entries and the `intercom` / `contact_supervisor` tool calls, and published as pane metadata tokens. Use them as `$name` in `[ui.sidebar.agents] rows`:

| Token | Example | Meaning |
|---|---|---|
| `$ic_name` | `planner` | intercom name |
| `$ic_last` | `→ worker: add retry logic…` | last message sent (→) or received (←) |
| `$ic_wait` | `asking worker` / `owes reply: planner` | blocking ask outstanding / inbound ask unanswered |
| `$ic_peers` | `worker-1, qa` | recent counterparties, most recent first |
| `$ic_count` | `↑3 ↓2` | messages sent / received this session |
| `$ic_awaiting` | `awaiting 2` | sent messages not answered yet |
| `$ic_todo` | `to answer 1` | received messages not answered yet |
| `$ic_open` | `awaiting: worker-1 · answering: planner` | who those are |
| `$ic_waits` | `◷ worker-1×2, qa` | compact: who this agent is waiting on |
| `$ic_replies` | `✎ planner` | compact: who is waiting on this agent |

`$ic_id` and `$ic_todo_from` are machine-readable tokens that peers running this extension use to tell whether a recipient has finished with a message.

While waiting, the visible state label also changes to `asking worker` (working) or `owes planner` (idle).

### How open messages are tracked

- A message from a peer answers the open message we sent it (the exact one when it carries `replyTo`, otherwise the oldest). A message we send to a peer answers the open message it sent us, the same way.
- A message that answers something is a response, not a new request, so it opens nothing, unless it is an ask (blocking `ask`, `contact_supervisor` decision/interview), which always awaits an answer. A worker reporting back therefore shows nothing open, while the orchestrator's next dispatch counts as awaiting again.
- A received non-ask message also stops counting when the agent settles (the run that handled it ended without answering). A received ask stays open until it is replied to.
- A sent non-ask message is also closed once Herdr shows the recipient has finished with it: its pane is idle/done (and, if it runs this extension, it no longer lists us as owed a reply) at least `HERDR_INTERCOM_GRACE_S` seconds after sending. This clears "no reply needed" messages.
- Open items expire after `HERDR_INTERCOM_OPEN_TTL_MIN` minutes.

All of this is local bookkeeping on session entries plus one Herdr socket query per poll while something is open. It makes no model calls and sends nothing over the network.

### Command

- `/herdr-intercom` shows the current identity, open items and recent traffic.
- `/herdr-intercom layout` prints the sidebar config snippet above.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `HERDR_INTERCOM=0` | on | disable entirely |
| `HERDR_INTERCOM_RENAME=0` | on | don't rename the Herdr agent (display only) |
| `HERDR_INTERCOM_ADOPT=0` | on | don't adopt an existing Herdr agent name |
| `HERDR_INTERCOM_DISPLAY=0` | on | don't set `display_agent` (tokens only; leaves the sidebar's agent label to Herdr or another extension) |
| `HERDR_INTERCOM_PREVIEW` | `48` | max characters of message preview in `$ic_last` |
| `HERDR_INTERCOM_OPEN_TTL_MIN` | `60` | minutes before an unanswered message stops counting |
| `HERDR_INTERCOM_GRACE_S` | `6` | seconds before an idle recipient is taken to have finished with a sent message |

## Safety

Everything published is Herdr display metadata scoped with `applies_to_source: herdr:pi`, so it disappears when the pi agent exits and never touches the lifecycle state owned by Herdr's pi integration. On shutdown all tokens and labels are cleared. The pi session name is only changed in the adopt case (unnamed session).

## Development

```bash
npm install
npm run check        # typecheck + tests
pi -e ./src/index.ts # run from source
```

## License

MIT
