import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

const recipientId = "01a13b01-144a-7796-aa77-d6ec6d73b88d";

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 1500;
	while (!check()) {
		assert.ok(Date.now() < deadline, "timed out waiting for sidebar metadata");
		await sleep(5);
	}
}

test("outbound peers resolve without a prior inbound message", async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-hi-"));
	const socketPath = path.join(dir, "herdr.sock");
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = socketPath;
	process.env.HERDR_PANE_ID = "sender-pane";
	process.env.HERDR_INTERCOM_RENAME = "0";
	process.env.HERDR_INTERCOM_ADOPT = "0";
	delete process.env.HERDR_INTERCOM;

	let agents: any[] = [];
	let reports: any[] = [];
	let listRequests = 0;
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (!buffer.includes("\n")) return;
			const request = JSON.parse(buffer.split("\n")[0]);
			let result = {};
			if (request.method === "agent.list") {
				listRequests++;
				result = { agents };
			}
			if (request.method === "pane.report_metadata") reports.push(request.params);
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(dir, { recursive: true, force: true });
	});
	const { default: ext } = await import("../src/index.ts");

	for (const fixture of [
		{ label: recipientId.slice(0, 13), tokens: { ic_id: recipientId }, expected: "pi@iq-forge" },
		{ label: recipientId, tokens: {}, expected: "pi@iq-forge" },
		{ label: `subagent-chat-${recipientId.slice(0, 18)}`, tokens: {}, expected: "pi@iq-forge" },
		{ label: `subagent-chat-${recipientId.slice(0, 18)}`, tokens: { ic_id: recipientId }, expected: "pi@iq-forge" },
		{ label: recipientId.slice(0, 13), tokens: { ic_id: recipientId, ic_name: "reviewer" }, expected: "reviewer" },
		{ label: recipientId, tokens: { ic_id: recipientId.slice(0, 8) }, expected: "pi@iq-forge" },
		{ label: recipientId.slice(0, 8), tokens: { ic_id: recipientId }, expected: "unnamed" },
	]) {
		await t.test(`resolves ${fixture.label} as ${fixture.expected}`, async (t) => {
			t.mock.timers.enable({ apis: ["setInterval"] });
			agents = [{
				pane_id: "other-pane",
				agent: "pi",
				cwd: "/src/wrong-project",
				agent_session: { value: "/sessions/01a13b01-21f2-7528-b7a7-8f6bf65b7d66.jsonl" },
				tokens: { ic_id: recipientId.slice(0, 8) },
			}, {
				pane_id: "recipient-pane",
				agent: "pi",
				cwd: "/src/iq-forge",
				agent_status: "working",
				agent_session: { value: `/sessions/2026-10-14_${recipientId}.jsonl` },
				tokens: fixture.tokens,
			}];
			reports = [];
			const handlers = new Map<string, (...args: any[]) => any>();
			const branch: any[] = [{ id: "initial", type: "session" }];
			const ctx = {
				mode: "tui",
				sessionManager: { getBranch: () => branch, getSessionId: () => "sender-id" },
			};
			ext({
				on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
				registerCommand: () => {},
				getSessionName: () => "sender",
			} as any);
			t.after(async () => handlers.get("session_shutdown")!({}));
			await handlers.get("session_start")!({}, ctx);
			await waitFor(() => reports.length > 0);
			branch.push({
				id: "sent-entry",
				type: "custom",
				customType: "intercom_sent",
				data: { to: fixture.label, messageId: "message-1", message: { text: "Please investigate" }, timestamp: Date.now() },
			});
			handlers.get("tool_result")!({ toolName: "intercom", toolCallId: "send-1" }, ctx);
			await waitFor(() => reports.at(-1)?.tokens.ic_awaiting === "awaiting 1");
			const before = listRequests;
			t.mock.timers.tick(2000);
			await waitFor(() => listRequests > before);
			if (fixture.expected === "unnamed") {
				// Make another report after the directory lookup to check the
				// ambiguous prefix stays unresolved rather than selecting a pane.
				await sleep(20);
				branch.push({ id: "second-sent", type: "custom", customType: "intercom_sent", data: {
					to: "named-peer", messageId: "message-2", message: { text: "ping" }, timestamp: Date.now(),
				} });
				handlers.get("tool_result")!({ toolName: "intercom", toolCallId: "send-2" }, ctx);
				await waitFor(() => reports.at(-1)?.tokens.ic_awaiting === "awaiting 2");
				assert.equal(reports.at(-1).tokens.ic_waits, "◷ unnamed, named-peer");
				return;
			}
			await waitFor(() => reports.at(-1)?.tokens.ic_waits === `◷ ${fixture.expected}`);
			const tokens = reports.at(-1).tokens;
			assert.equal(tokens.ic_last, `→ ${fixture.expected}: Please investigate`);
			assert.equal(tokens.ic_peers, fixture.expected);
			assert.equal(tokens.ic_open, `awaiting: ${fixture.expected}`);

			// A subsequent inbound message with the full id answers the open
			// outbound item even when we only knew a generated alias/id prefix.
			branch.push({ id: "inbound", type: "custom_message", customType: "intercom_message", details: {
				from: { id: recipientId, name: "reviewer" },
				message: { id: "reply-1", content: { text: "Done" } },
			} });
			handlers.get("message_end")!({}, ctx);
			await waitFor(() => reports.at(-1)?.tokens.ic_count === "↑1 ↓1");
			assert.equal(reports.at(-1).tokens.ic_waits, null);
			assert.equal(reports.at(-1).tokens.ic_replies, null);
		});
	}
});
