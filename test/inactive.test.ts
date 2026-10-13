// Outside Herdr the extension must not register anything.
import assert from "node:assert/strict";
import { test } from "node:test";

for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) delete process.env[k];

test("does nothing outside Herdr", async () => {
	const { default: ext } = await import("../src/index.ts");
	const calls: string[] = [];
	const pi = new Proxy({}, { get: (_t, p) => () => calls.push(String(p)) });
	ext(pi as any);
	assert.deepEqual(calls, []);
});
