/**
 * pi-herdr-intercom — shows pi-intercom identities and traffic in Herdr's
 * Agents sidebar. See README.md for behaviour, tokens and configuration.
 *
 * Only active for the pane's own interactive (TUI) pi session inside Herdr.
 * Everything published is Herdr display metadata guarded by
 * `--applies-to-source herdr:pi`, so it disappears with the pi agent and never
 * touches lifecycle state owned by Herdr's pi integration
 * (`herdr integration install pi`). The pi session name is only changed when
 * adopting a Herdr agent name for an unnamed session.
 */

import net from "node:net";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Direction,
	type LogEntry,
	type Open,
	type Peer,
	closeOpen,
	idMatch,
	isIdish,
	isUnreadableName,
	oneLine as clip,
	peerCounts,
	peerFromInput,
	samePeer,
	textOf,
	toHerdrName,
} from "./util.ts";

export { toHerdrName } from "./util.ts";

const DISABLED = process.env.HERDR_INTERCOM === "0";
const RENAME = process.env.HERDR_INTERCOM_RENAME !== "0";
const ADOPT = process.env.HERDR_INTERCOM_ADOPT !== "0";
const DISPLAY = process.env.HERDR_INTERCOM_DISPLAY !== "0";
const PREVIEW = Math.max(12, Number(process.env.HERDR_INTERCOM_PREVIEW) || 48);

const SOURCE = "herdr:intercom";
const PI_SOURCE = "herdr:pi";
const TOKEN_KEYS = [
	"ic_name",
	"ic_last",
	"ic_wait",
	"ic_peers",
	"ic_count",
	"ic_awaiting",
	"ic_todo",
	"ic_open",
	"ic_id",
	"ic_todo_from",
	"ic_waits",
	"ic_replies",
] as const;
const LOG_LIMIT = 50;
// Inbound asks whose asker gave up are dismissed silently by pi-intercom, so
// stop showing "owes reply" after a while.
const OWED_TTL_MS = 60 * 60 * 1000;
const OPEN_TTL_MS = Math.max(1, Number(process.env.HERDR_INTERCOM_OPEN_TTL_MIN) || 60) * 60 * 1000;
const GRACE_MS = Math.max(2, Number(process.env.HERDR_INTERCOM_GRACE_S) || 6) * 1000;
const CLOSED_ENTRY = "herdr_intercom_closed";

const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
	process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;

function inHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;
}

// ---------------------------------------------------------------------------
// Herdr socket client (one JSON line per request, first reply line wins)

type HerdrReply = { result?: any; error?: { code?: string; message?: string } };

function herdrRequest(method: string, params: Record<string, unknown>, timeoutMs = 1500): Promise<HerdrReply | undefined> {
	return new Promise((resolve) => {
		let done = false;
		let buf = "";
		const socket = net.createConnection(socketEndpoint!);
		const finish = (value: HerdrReply | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		timer.unref?.();
		socket.on("error", () => finish(undefined));
		socket.on("end", () => finish(undefined));
		socket.on("connect", () => {
			const id = `${SOURCE}:${method}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				finish(JSON.parse(buf.slice(0, nl)));
			} catch {
				finish(undefined);
			}
		});
	});
}

const oneLine = (text: unknown, max = PREVIEW): string => clip(text, max);

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (DISABLED || !inHerdr()) return;

	let active = false; // TUI root session in a Herdr pane
	let ctxRef: ExtensionContext | undefined;

	// Identity
	let name: string | undefined;
	let herdrNameWeSet: string | undefined;
	let renameFailedFor: string | undefined;

	// Traffic
	let sent = 0;
	let received = 0;
	let log: LogEntry[] = [];
	const asking = new Map<string, string>(); // toolCallId -> peer
	const owed = new Map<string, Peer & { at: number }>(); // inbound ask id -> asker
	let awaiting: Open[] = []; // sent, not answered yet
	let todo: Open[] = []; // received, not answered yet

	// Publishing (coalesced; each report carries the full presentation state)
	let seq = Date.now() * 1000;
	let inFlight = false;
	let dirty = false;

	function currentName(): string | undefined {
		const n = pi.getSessionName()?.trim();
		return n ? n : undefined;
	}

	function last(): LogEntry | undefined {
		return log[log.length - 1];
	}

	function peers(): string[] {
		const out: string[] = [];
		for (let i = log.length - 1; i >= 0 && out.length < 3; i--) {
			const p = displayPeer(log[i]);
			if (!out.includes(p)) out.push(p);
		}
		return out;
	}

	function waitText(): { working?: string; idle?: string; token?: string } {
		const askingPeers = [...new Set(asking.values())];
		const owedPeers = [...new Set([...owed.values()].map(displayPeer))];
		const parts: string[] = [];
		let working: string | undefined;
		let idle: string | undefined;
		if (askingPeers.length) {
			working = `asking ${askingPeers.join(", ")}`;
			parts.push(working);
		}
		if (owedPeers.length) {
			idle = `owes ${owedPeers.join(", ")}`;
			parts.push(`owes reply: ${owedPeers.join(", ")}`);
		}
		return { working, idle, token: parts.length ? parts.join(" · ") : undefined };
	}

	function ownId(): string | undefined {
		const id = process.env.PI_INTERCOM_SESSION_ID?.trim();
		if (id) return id;
		try {
			return ctxRef?.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}

	// Herdr agent directory (read-only agent.list), refreshed by the poll while
	// anything is open; used to name unnamed peers and check recipients.
	let herdrAgents: any[] = [];
	let herdrAgentsAt = 0;
	async function refreshHerdrAgents(maxAgeMs: number): Promise<any[]> {
		if (Date.now() - herdrAgentsAt < maxAgeMs) return herdrAgents;
		const r = await herdrRequest("agent.list", {});
		if (Array.isArray(r?.result?.agents)) {
			herdrAgents = r.result.agents;
			herdrAgentsAt = Date.now();
		}
		return herdrAgents;
	}

	function findHerdrAgent(o: Peer): any | undefined {
		const pid = o.peerId?.toLowerCase();
		const pname = o.peer.toLowerCase();
		const others = herdrAgents.filter((a) => a?.pane_id !== paneId);
		const tid = (a: any) => String(a?.tokens?.ic_id ?? "").toLowerCase();
		// Most specific first: exact id, session file, name, then (legacy) id prefix.
		const tests: ((a: any) => boolean)[] = [];
		if (pid) {
			tests.push((a) => tid(a) === pid);
			tests.push((a) => String(a?.agent_session?.value ?? "").toLowerCase().includes(pid));
		}
		tests.push((a) =>
			[a?.tokens?.ic_name, a?.display_agent, a?.name].some(
				(n) => typeof n === "string" && n.toLowerCase() === pname,
			),
		);
		if (pid) tests.push((a) => idMatch(pid, tid(a)));
		for (const test of tests) {
			const hit = others.find(test);
			if (hit) return hit;
		}
		return undefined;
	}

	/** Human-readable label for a peer: its name, else its Herdr name, else pi@<cwd>. */
	function displayPeer(o: Peer): string {
		if (!isUnreadableName(o.peer)) return o.peer;
		const a = findHerdrAgent(o);
		if (a) {
			const n = [a.tokens?.ic_name, a.display_agent, a.name].find(
				(x) => typeof x === "string" && x && !isUnreadableName(x),
			);
			if (n) return n;
			const dir = path.basename(String(a.cwd ?? "")) || "?";
			return `${a.agent ?? "agent"}@${dir}`;
		}
		return "unnamed";
	}

	/** Peers whose label is published: open items + the recent log ones. */
	function shownPeers(): Peer[] {
		return [...awaiting, ...todo, ...owed.values(), ...log.slice(-6)];
	}

	function anyUnreadable(): boolean {
		return shownPeers().some((o) => isUnreadableName(o.peer));
	}

	/**
	 * Close sent non-ask messages whose recipient Herdr shows as finished:
	 * idle/done and not listing us in its $ic_todo_from. Read-only query.
	 */
	let peerCheckInFlight = false;
	async function checkRecipients(): Promise<void> {
		const now = Date.now();
		const candidates = awaiting.filter((o) => !o.ask && now - o.at >= GRACE_MS);
		const naming = anyUnreadable();
		if ((!candidates.length && !naming) || peerCheckInFlight) return;
		peerCheckInFlight = true;
		try {
			const before = naming ? openLabels() : "";
			// Fresh each poll for recipient state; names alone can be 10s stale.
			await refreshHerdrAgents(candidates.length ? 0 : 10_000);
			const me = ownId()?.toLowerCase();
			const findPeer = findHerdrAgent;
			let changed = naming && openLabels() !== before;
			const closedIds: string[] = [];
			for (const o of candidates) {
				const a = findPeer(o);
				if (!a) continue; // not in Herdr: TTL only
				if (a.agent_status !== "idle" && a.agent_status !== "done") continue;
				const t = a.tokens ?? {};
				if (t.ic_id) {
					const from = String(t.ic_todo_from ?? "").toLowerCase().split(",").filter(Boolean);
					if (me && from.some((f) => idMatch(me, f))) continue; // still on its to-answer list
				}
				const i = awaiting.indexOf(o);
				if (i >= 0) {
					awaiting.splice(i, 1);
					if (o.id) closedIds.push(o.id);
					changed = true;
				}
			}
			// Record the closure in the session (not sent to the model) so a
			// reload/resume replay doesn't reopen it.
			if (closedIds.length) {
				try {
					pi.appendEntry(CLOSED_ENTRY, { ids: closedIds, reason: "recipient-finished", at: Date.now() });
				} catch {
					/* best effort */
				}
			}
			if (changed) publish();
		} finally {
			peerCheckInFlight = false;
		}
	}

	function openLabels(): string {
		return shownPeers().map(displayPeer).join("|");
	}

	function openText(): string | undefined {
		const parts: string[] = [];
		if (awaiting.length) parts.push(`awaiting: ${[...new Set(awaiting.map(displayPeer))].join(", ")}`);
		if (todo.length) parts.push(`answering: ${[...new Set(todo.map(displayPeer))].join(", ")}`);
		return parts.length ? parts.join(" · ") : undefined;
	}

	/** Drop expired open items (and, when settled, non-ask inbound ones). */
	function pruneOpen(now: number, settled = false): boolean {
		const a = awaiting.length;
		const t = todo.length;
		awaiting = awaiting.filter((o) => now - o.at <= OPEN_TTL_MS);
		todo = todo.filter((o) => now - o.at <= OPEN_TTL_MS && (!settled || o.ask));
		return awaiting.length !== a || todo.length !== t;
	}

	function buildReport(): Record<string, unknown> {
		const l = last();
		const wait = waitText();
		const tokens: Record<string, string | null> = {
			ic_name: name ?? null,
			ic_last: l ? `${l.dir === "out" ? "→" : "←"} ${displayPeer(l)}: ${oneLine(l.text)}` : null,
			ic_wait: wait.token ?? null,
			ic_peers: peers().join(", ") || null,
			ic_count: sent || received ? `↑${sent} ↓${received}` : null,
			ic_awaiting: awaiting.length ? `awaiting ${awaiting.length}` : null,
			ic_todo: todo.length ? `to answer ${todo.length}` : null,
			ic_open: openText() ?? null,
			ic_waits: awaiting.length ? `◷ ${peerCounts(awaiting, displayPeer)}` : null,
			ic_replies: todo.length ? `✎ ${peerCounts(todo, displayPeer)}` : null,
			// Machine-readable, for peers' "has the recipient finished?" check.
			ic_id: ownId() ?? null,
			ic_todo_from: [...new Set(todo.map((o) => o.peerId).filter(Boolean))].join(",") || null,
		};
		const stateLabels: Record<string, string> = {};
		if (wait.working) stateLabels.working = wait.working;
		if (wait.idle) stateLabels.idle = wait.idle;
		if (wait.idle) stateLabels.done = wait.idle;
		const params: Record<string, unknown> = {
			pane_id: paneId,
			source: SOURCE,
			agent: "pi",
			applies_to_source: PI_SOURCE,
			tokens,
			seq: ++seq,
		};
		if (DISPLAY && name) params.display_agent = name;
		// Herdr keeps the previous state_labels when a report omits them, so
		// clear explicitly once nothing is outstanding (else e.g. a stale
		// "owes planner" lingers).
		if (Object.keys(stateLabels).length) params.state_labels = stateLabels;
		else params.clear_state_labels = true;
		return params;
	}

	function publish(): void {
		if (!active) return;
		dirty = true;
		if (inFlight) return;
		inFlight = true;
		void (async () => {
			try {
				while (dirty) {
					dirty = false;
					await herdrRequest("pane.report_metadata", buildReport());
				}
			} finally {
				inFlight = false;
			}
		})();
	}

	async function getHerdrAgentName(): Promise<string | undefined> {
		const r = await herdrRequest("agent.get", { target: paneId });
		const n = r?.result?.agent?.name;
		return typeof n === "string" && n ? n : undefined;
	}

	async function syncHerdrName(): Promise<void> {
		if (!active || !RENAME) return;
		const wanted = toHerdrName(name);
		if (!wanted || wanted === herdrNameWeSet || wanted === renameFailedFor) return;
		const existing = await getHerdrAgentName();
		if (existing === wanted) {
			herdrNameWeSet = wanted;
			return;
		}
		// Don't clobber a name somebody else gave this agent.
		if (existing && existing !== herdrNameWeSet) return;
		const r = await herdrRequest("agent.rename", { target: paneId, name: wanted });
		if (r?.result) {
			herdrNameWeSet = wanted;
			renameFailedFor = undefined;
		} else {
			// Usually a duplicate name elsewhere; keep display-only and don't retry.
			renameFailedFor = wanted;
		}
	}

	function refreshName(): void {
		const n = currentName();
		if (n === name) return;
		name = n;
		publish();
		void syncHerdrName();
	}

	let changes = 0; // bumped by every traffic/owed mutation from entries

	// Session id -> name, learned from inbound messages, so an outbound target
	// typed as an id prefix ("01a134b3") is shown under the peer's name.
	const knownPeers = new Map<string, string>();
	function resolvePeer(label: unknown): Peer {
		const l = typeof label === "string" ? label.trim() : "";
		if (!l) return { peer: "?" };
		for (const [id, n] of knownPeers) {
			if (n.toLowerCase() === l.toLowerCase()) return { peer: n, peerId: id };
			if (isIdish(l) && id.toLowerCase().startsWith(l.toLowerCase())) return { peer: n, peerId: id };
		}
		return { peer: l };
	}

	function record(at: number, dir: Direction, who: Peer, text: unknown, kind: string): void {
		changes++;
		log.push({ at, dir, peer: who.peer || "?", peerId: who.peerId, text: oneLine(text, 400), kind });
		if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
		if (dir === "out") sent++;
		else received++;
	}

	function entryTime(e: any, fallback?: unknown): number {
		const t = typeof fallback === "number" ? fallback : Date.parse(e?.timestamp ?? "");
		return Number.isFinite(t) ? t : Date.now();
	}

	/**
	 * Apply one session entry. pi-intercom records every delivered message as a
	 * session entry — `intercom_sent` / `intercom_received` (custom) and
	 * `intercom_message` (custom_message, inbound) — including traffic sent from
	 * the /intercom overlay, so entries are the single source of truth.
	 * `live` is false while replaying history: stale inbound asks from an older
	 * run are not counted as owed.
	 */
	function apply(e: any, live: boolean, askIds: Set<string>): void {
		if (e?.type === "custom" && e.customType === "intercom_sent") {
			const d = e.data ?? {};
			if (d.error) return; // recordSubagentDeliveryError
			const msg = typeof d.message === "string" ? { text: d.message } : (d.message ?? {});
			const kind = msg.replyTo ? "reply" : msg.reason ? String(msg.reason) : "send";
			const at = entryTime(e, d.timestamp);
			const who = resolvePeer(d.to);
			record(at, "out", who, msg.text, kind);
			if (msg.replyTo && owed.delete(msg.replyTo)) changes++;
			// Sending anything to a peer answers the oldest open message from it
			// (or exactly the one an explicit reply points at).
			const answered = closeOpen(todo, who, msg.replyTo);
			const raw = String(d.to ?? "").toLowerCase();
			const isAsk =
				msg.reason === "need_decision" ||
				msg.reason === "interview_request" ||
				(!!d.messageId && askIds.has(d.messageId)) ||
				(live && [...asking.values()].some((v) => v.toLowerCase() === raw || samePeer({ peer: v }, who)));
			if (!msg.replyTo && (isAsk || !answered)) awaiting.push({ ...who, id: d.messageId, at, ask: isAsk });
		} else if (e?.type === "custom" && e.customType === CLOSED_ENTRY) {
			const ids: unknown[] = Array.isArray(e.data?.ids) ? e.data.ids : [];
			const before = awaiting.length;
			awaiting = awaiting.filter((o) => !o.id || !ids.includes(o.id));
			if (awaiting.length !== before) changes++;
		} else if (e?.type === "custom" && e.customType === "intercom_received") {
			const d = e.data ?? {};
			// Answer to our blocking ask / contact_supervisor question.
			const who = resolvePeer(d.from);
			record(entryTime(e, d.timestamp), "in", who, d.message?.text, "reply");
			const i = awaiting.findLastIndex((o) => o.ask && samePeer(o, who));
			if (i >= 0) awaiting.splice(i, 1);
		} else if (e?.type === "custom_message" && e.customType === "intercom_message") {
			const d = e.details ?? {};
			const m = d.message ?? {};
			if (d.from?.id && d.from?.name) knownPeers.set(String(d.from.id), String(d.from.name));
			const peer = d.from?.name || d.from?.id?.slice?.(0, 8);
			const at = entryTime(e);
			const who: Peer = { peer: peer || "?", peerId: d.from?.id ? String(d.from.id) : undefined };
			record(at, "in", who, m.content?.text ?? d.bodyText ?? textOf(e.content), m.expectsReply ? "ask" : "message");
			const answered = closeOpen(awaiting, who, m.replyTo);
			if (m.expectsReply || (!m.replyTo && !answered)) todo.push({ ...who, id: m.id, at, ask: !!m.expectsReply });
			if (live && m.expectsReply && m.id) {
				owed.set(m.id, { ...who, at: Date.now() });
				changes++;
			}
		}
	}

	/**
	 * Incrementally scan the active branch for new intercom entries. Walks back
	 * from the leaf to the last entry already seen; if that entry is no longer
	 * on the branch (tree navigation, new session) everything is rebuilt.
	 */
	let lastSeenId: string | undefined;
	function scan(ctx: ExtensionContext | undefined, live = true): boolean {
		if (!ctx) return false;
		let branch: any[];
		try {
			branch = ctx.sessionManager.getBranch() as any[];
		} catch {
			return false;
		}
		let from = 0;
		if (lastSeenId) {
			const idx = branch.findLastIndex((e) => e?.id === lastSeenId);
			if (idx >= 0) from = idx + 1;
			else live = false;
		}
		if (from === 0) {
			sent = 0;
			received = 0;
			log = [];
			owed.clear();
			awaiting = [];
			todo = [];
		}
		// An ask writes intercom_sent, then intercom_received from the same peer
		// once answered; mark those sent ids as asks for history replay.
		const askIds = new Set<string>();
		const lastSentTo = new Map<string, string>();
		for (let i = from; i < branch.length; i++) {
			const e = branch[i];
			if (e?.type !== "custom") continue;
			if (e.customType === "intercom_sent" && !e.data?.message?.replyTo && e.data?.messageId) {
				lastSentTo.set(String(e.data.to ?? "").toLowerCase(), e.data.messageId);
			} else if (e.customType === "intercom_received") {
				const id = lastSentTo.get(String(e.data?.from ?? "").toLowerCase());
				if (id) askIds.add(id);
			}
		}
		const before = changes;
		for (let i = from; i < branch.length; i++) apply(branch[i], live, askIds);
		// History replay: every earlier run has settled.
		if (from === 0) pruneOpen(Date.now(), true);
		if (branch.length) lastSeenId = branch[branch.length - 1]?.id;
		return from === 0 || changes !== before;
	}

	function rescan(ctx?: ExtensionContext): void {
		if (!active) return;
		if (ctx) ctxRef = ctx;
		if (scan(ctxRef)) publish();
	}

	async function adoptHerdrName(): Promise<void> {
		if (!ADOPT || currentName()) return;
		// Herdr names a managed agent before launching it, but the pane may not be
		// recognised as hosting pi yet on the very first tick; retry briefly.
		for (const delay of [0, 400, 1200]) {
			if (delay) await new Promise((r) => setTimeout(r, delay));
			if (!active || currentName()) return;
			const n = await getHerdrAgentName();
			if (n) {
				herdrNameWeSet = n; // ours to keep in sync from now on
				try {
					pi.setSessionName(n);
				} catch {
					return;
				}
				refreshName();
				return;
			}
		}
	}

	// -------------------------------------------------------------------------
	// Lifecycle

	let poll: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// TUI only: print/json/rpc children (e.g. pi-subagents) inherit
		// HERDR_PANE_ID from their parent and must not relabel its pane.
		if (ctx?.mode !== "tui") return;
		active = true;
		ctxRef = ctx;
		name = undefined;
		renameFailedFor = undefined;
		lastSeenId = undefined;
		asking.clear();
		scan(ctx, false);
		refreshName();
		publish();
		void adoptHerdrName();
		// Inbound messages can land while idle without starting a turn
		// (intercom inboundTrigger "never"/"replies"), so also poll lightly.
		if (!poll) {
			poll = setInterval(() => {
				let expired = false;
				for (const [id, o] of owed) {
					if (Date.now() - o.at > OWED_TTL_MS) expired = owed.delete(id) || expired;
				}
				if (pruneOpen(Date.now())) expired = true;
				if (expired) publish();
				rescan();
				void checkRecipients();
			}, 2000);
			poll.unref?.();
		}
	});

	pi.on("session_info_changed", () => refreshName());
	// Cheap safety net for name changes that don't emit session_info_changed,
	// plus prompt pickup of entries appended around turn boundaries.
	pi.on("agent_start", (_e, ctx) => {
		refreshName();
		rescan(ctx);
	});
	pi.on("turn_start", (_e, ctx) => rescan(ctx));
	pi.on("message_end", (_e, ctx) => rescan(ctx));
	pi.on("agent_settled", (_e, ctx) => {
		refreshName();
		rescan(ctx);
		// The run that handled inbound non-ask messages ended without answering.
		if (ctx?.isIdle?.() !== false && pruneOpen(Date.now(), true)) publish();
	});

	// Blocking asks: the entry for the question is only written once delivered
	// and the tool keeps running until the reply arrives, so track the
	// in-flight call to show "asking <peer>" meanwhile.
	const isAsk = (e: any) =>
		(e.toolName === "intercom" && e.input?.action === "ask") ||
		(e.toolName === "contact_supervisor" && e.input?.reason !== "progress_update");

	pi.on("tool_call", (event: any) => {
		if (!active || !isAsk(event)) return;
		const peer = event.toolName === "contact_supervisor" ? "supervisor" : (peerFromInput(event.input) ?? "?");
		asking.set(event.toolCallId, peer);
		publish();
	});

	pi.on("tool_result", (event: any, ctx) => {
		if (!active) return;
		if (event.toolName !== "intercom" && event.toolName !== "contact_supervisor") return;
		// Scan first so the ask's intercom_sent entry still sees the in-flight call.
		let changed = scan(ctx);
		changed = asking.delete(event.toolCallId) || changed;
		// A delivered ask that then failed (timeout, cancel, asker gave up) will
		// never get an answer; stop counting it as awaiting.
		const failedId = event.details?.error ? event.details?.messageId : undefined;
		if (failedId) {
			const i = awaiting.findIndex((o) => o.id === failedId);
			if (i >= 0) {
				awaiting.splice(i, 1);
				changed = true;
			}
		}
		if (changed) publish();
	});

	pi.on("session_shutdown", async () => {
		if (poll) clearInterval(poll);
		poll = undefined;
		if (!active) return;
		active = false;
		const tokens: Record<string, null> = {};
		for (const k of TOKEN_KEYS) tokens[k] = null;
		await herdrRequest(
			"pane.report_metadata",
			{
				pane_id: paneId,
				source: SOURCE,
				agent: "pi",
				applies_to_source: PI_SOURCE,
				clear_display_agent: true,
				clear_state_labels: true,
				tokens,
				seq: ++seq,
			},
			800,
		);
	});

	// -------------------------------------------------------------------------
	// /herdr-intercom

	const LAYOUT = `# ~/.config/herdr/config.toml  (then: herdr server reload-config)
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  [{ token = "agent", bold = true }, { token = "$ic_waits", fg = "#83a598" }, { token = "$ic_replies", fg = "#fabd2f" }],
]`;

	pi.registerCommand("herdr-intercom", {
		description: "Show intercom identity/traffic as published to Herdr (`layout` for sidebar config)",
		handler: async (args, ctx) => {
			if (args.trim() === "layout") {
				ctx.ui.notify(LAYOUT, "info");
				return;
			}
			refreshName();
			rescan(ctx);
			const herdrName = await getHerdrAgentName();
			const wait = waitText().token;
			const lines = [
				`pane ${paneId} · intercom name: ${name ?? "(unnamed — set with /alias or pi --name)"}`,
				`herdr agent name: ${herdrName ?? "(none)"}${RENAME ? "" : " · rename disabled"}`,
				`traffic: ↑${sent} ↓${received}${wait ? ` · ${wait}` : ""}`,
				`open: ${awaiting.length} awaiting response, ${todo.length} to answer${openText() ? ` (${openText()})` : ""}`,
				...log
					.slice(-10)
					.map(
						(e) =>
							`  ${new Date(e.at).toLocaleTimeString()} ${e.dir === "out" ? "→" : "←"} ${e.peer} [${e.kind}] ${oneLine(e.text, 80)}`,
					),
				"Use `/herdr-intercom layout` for a sidebar layout showing $ic_* tokens.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
			publish();
		},
	});

}
