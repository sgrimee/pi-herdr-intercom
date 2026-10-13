// Inside Herdr the extension registers its hooks, but stays inert for
// non-TUI sessions (e.g. pi-subagents children inheriting HERDR_PANE_ID).
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = "/nonexistent/herdr-test.sock";
process.env.HERDR_PANE_ID = "test-pane";
delete process.env.HERDR_INTERCOM;

test("registers hooks and the /herdr-intercom command", async () => {
	const { default: ext } = await import("../src/index.ts");
	const handlers = new Map<string, (...a: any[]) => any>();
	const commands: string[] = [];
	const pi = {
		on: (event: string, fn: (...a: any[]) => any) => handlers.set(event, fn),
		registerCommand: (name: string) => commands.push(name),
		getSessionName: () => {
			throw new Error("must not be called for non-TUI sessions");
		},
	};
	ext(pi as any);
	assert.deepEqual(commands, ["herdr-intercom"]);
	for (const e of ["session_start", "session_shutdown", "tool_call", "tool_result", "agent_settled"]) {
		assert.ok(handlers.has(e), `missing ${e} handler`);
	}
	// Print/json/rpc mode: no activation, no socket traffic, no name lookups.
	await handlers.get("session_start")!({}, { mode: "print" });
	handlers.get("tool_call")!({ toolName: "intercom", toolCallId: "t1", input: { action: "ask", to: "x" } });
	await handlers.get("session_shutdown")!({});
});
