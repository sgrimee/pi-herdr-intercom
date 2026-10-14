import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Open,
	closeOpen,
	idMatch,
	isUnreadableName,
	oneLine,
	peerCounts,
	peerFromInput,
	peerIdFromLabel,
	samePeer,
	textOf,
	toHerdrName,
} from "../src/util.ts";

test("toHerdrName normalises intercom names into Herdr agent names", () => {
	assert.equal(toHerdrName("planner"), "planner");
	assert.equal(toHerdrName("Worker 1"), "worker-1");
	assert.equal(toHerdrName("Revisão  QA!"), "revisao-qa");
	assert.equal(toHerdrName("--1st_reviewer--"), "st_reviewer");
	assert.equal(toHerdrName("a".repeat(40)), "a".repeat(32));
	assert.equal(toHerdrName(`${"a".repeat(31)}-b`), "a".repeat(31));
	assert.equal(toHerdrName("123"), undefined);
	assert.equal(toHerdrName(""), undefined);
	assert.equal(toHerdrName(undefined), undefined);
});

test("oneLine collapses whitespace and truncates", () => {
	assert.equal(oneLine("  a\n\tb  c "), "a b c");
	assert.equal(oneLine("abcdefghij", 5), "abcd…");
	assert.equal(oneLine(undefined), "");
});

test("idMatch accepts full ids and long-enough prefixes only", () => {
	const id = "01a134b3-7c2d-7e00-8000-000000000001";
	assert.ok(idMatch(id, id));
	assert.ok(idMatch(id, "01a134b3"));
	assert.ok(idMatch(id, id.toUpperCase()));
	assert.ok(!idMatch(id, "01a134b"));
	assert.ok(!idMatch(undefined, id));
	assert.ok(!idMatch(id, "01a134b4"));
});

test("peerIdFromLabel extracts outbound ids and generated aliases", () => {
	assert.equal(peerIdFromLabel("01a13b01-144a"), "01a13b01-144a");
	assert.equal(peerIdFromLabel("subagent-chat-01a13b01-144a-7796"), "01a13b01-144a-7796");
	assert.equal(peerIdFromLabel("SUBAGENT-CHAT-01A13B01-144A"), "01A13B01-144A");
	assert.equal(peerIdFromLabel("01a13b"), undefined);
	assert.equal(peerIdFromLabel("planner"), undefined);
	assert.equal(peerIdFromLabel("?"), undefined);
});

test("samePeer matches by name, full id, or id prefix used as name", () => {
	assert.ok(samePeer({ peer: "Planner" }, { peer: "planner" }));
	assert.ok(samePeer({ peer: "a", peerId: "x1" }, { peer: "b", peerId: "x1" }));
	assert.ok(!samePeer({ peer: "a", peerId: "x1" }, { peer: "b", peerId: "x2" }));
	assert.ok(samePeer({ peer: "01a134b3" }, { peer: "worker", peerId: "01a134b3-aaaa" }));
	assert.ok(!samePeer({ peer: "worker" }, { peer: "planner" }));
	const id = "01a13b01-144a-7796-aa77-d6ec6d73b88d";
	const outbound = { peer: `subagent-chat-${id.slice(0, 18)}`, peerId: id.slice(0, 18) };
	const inbound = { peer: "reviewer", peerId: id };
	assert.ok(samePeer(outbound, inbound));
	assert.ok(samePeer(inbound, outbound));
	assert.ok(!samePeer(outbound, { peer: "other", peerId: "01a13b01-21f2-7528-b7a7-8f6bf65b7d66" }));
});

test("closeOpen removes the exact id, else the oldest item for the peer", () => {
	const list: Open[] = [
		{ peer: "w", id: "1", at: 1 },
		{ peer: "q", id: "2", at: 2 },
		{ peer: "w", id: "3", at: 3 },
	];
	assert.ok(closeOpen(list, { peer: "w" }, "3"));
	assert.deepEqual(list.map((o) => o.id), ["1", "2"]);
	assert.ok(closeOpen(list, { peer: "w" }, "missing"));
	assert.deepEqual(list.map((o) => o.id), ["2"]);
	assert.ok(!closeOpen(list, { peer: "w" }));
});

test("peerCounts groups in first-seen order", () => {
	const list: Open[] = [
		{ peer: "worker-1", at: 1 },
		{ peer: "qa", at: 2 },
		{ peer: "worker-1", at: 3 },
	];
	assert.equal(peerCounts(list, (o) => o.peer), "worker-1×2, qa");
	assert.equal(peerCounts([], (o) => o.peer), "");
});

test("isUnreadableName flags generated names", () => {
	assert.ok(isUnreadableName("?"));
	assert.ok(isUnreadableName("subagent-chat-01a134b3"));
	assert.ok(isUnreadableName("01a134b3"));
	assert.ok(!isUnreadableName("planner"));
	assert.ok(!isUnreadableName("deadline")); // contains non-hex letters
});

test("peerFromInput and textOf", () => {
	assert.equal(peerFromInput({ to: " worker " }), "worker");
	assert.equal(peerFromInput({ cwd: "/src/my-app/" }), "my-app");
	assert.equal(peerFromInput({}), undefined);
	assert.equal(textOf("hi"), "hi");
	assert.equal(
		textOf([
			{ type: "text", text: "a" },
			{ type: "image", data: "" },
			{ type: "text", text: "b" },
		]),
		"a\nb",
	);
	assert.equal(textOf(42), "");
});
