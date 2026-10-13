/**
 * Pure helpers for pi-herdr-intercom (no I/O, no pi or Herdr state), kept
 * separate so they can be unit tested.
 */

import path from "node:path";

export type Direction = "out" | "in";
export type Peer = { peer: string; peerId?: string };
export type LogEntry = Peer & { at: number; dir: Direction; text: string; kind: string };
/** A message that has not been answered yet. */
export type Open = Peer & { id?: string; at: number; ask?: boolean };

// Peers built before full ids were published report 8-char id prefixes in
// $ic_id / $ic_todo_from. UUIDv7 prefixes that short are a ~65 s timestamp
// bucket, so sessions started together collide; we publish full ids and only
// fall back to prefix matching.
export const MIN_ID_PREFIX = 8;

/** Whether two session ids (or an id and an id prefix) refer to the same session. */
export function idMatch(full: string | undefined, other: string | undefined): boolean {
	const f = (full ?? "").toLowerCase();
	const o = (other ?? "").toLowerCase();
	if (!f || o.length < MIN_ID_PREFIX) return false;
	return f === o || f.startsWith(o) || o.startsWith(f);
}

/** Collapse whitespace and truncate with an ellipsis. */
export function oneLine(text: unknown, max = 48): string {
	const s = String(text ?? "").replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Normalise an intercom name into a Herdr agent name, or undefined. */
export function toHerdrName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	let n = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/[-_]+$/, "");
	n = n.slice(0, 32).replace(/[-_]+$/, "");
	return /^[a-z][a-z0-9_-]{0,31}$/.test(n) ? n : undefined;
}

/** Plain text of a message content (string or content-block array). */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
}

/** Target peer of an intercom tool call: `to`, else the basename of `cwd`. */
export function peerFromInput(input: any): string | undefined {
	if (typeof input?.to === "string" && input.to.trim()) return input.to.trim();
	if (typeof input?.cwd === "string" && input.cwd.trim()) return path.basename(input.cwd.trim());
	return undefined;
}

/** Looks like a session id or id prefix. */
export const isIdish = (s: string): boolean => /^[0-9a-f][0-9a-f-]{5,}$/i.test(s);

export function samePeer(a: Peer, b: Peer): boolean {
	const an = a.peer.toLowerCase();
	const bn = b.peer.toLowerCase();
	if (an === bn) return true;
	if (a.peerId && b.peerId) return a.peerId === b.peerId;
	const aid = (a.peerId ?? "").toLowerCase();
	const bid = (b.peerId ?? "").toLowerCase();
	return (isIdish(an) && !!bid && bid.startsWith(an)) || (isIdish(bn) && !!aid && aid.startsWith(bn));
}

/** Remove the open item with this id, else the oldest one for this peer. */
export function closeOpen(list: Open[], who: Peer, id?: string): boolean {
	let i = id ? list.findIndex((o) => o.id === id) : -1;
	if (i < 0) i = list.findIndex((o) => samePeer(o, who));
	if (i < 0) return false;
	list.splice(i, 1);
	return true;
}

/** "worker-1×2, qa" — peers in first-seen order with a count when > 1. */
export function peerCounts(list: Open[], label: (o: Open) => string): string {
	const counts = new Map<string, number>();
	for (const o of list) {
		const l = label(o);
		counts.set(l, (counts.get(l) ?? 0) + 1);
	}
	return [...counts].map(([p, n]) => (n > 1 ? `${p}×${n}` : p)).join(", ");
}

/**
 * Names that are not human-chosen: pi-intercom's fallback alias for unnamed
 * sessions ("subagent-chat-<id…>"), bare session ids / id prefixes, "?".
 */
export function isUnreadableName(p: string): boolean {
	return p === "?" || /^subagent-chat-[0-9a-f-]+$/i.test(p) || isIdish(p);
}
