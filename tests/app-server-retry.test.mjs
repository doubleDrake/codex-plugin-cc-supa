import test from "node:test";
import assert from "node:assert/strict";

import {
  AppServerClientBase,
  BROKER_BUSY_RPC_CODE,
  BROKER_BUSY_MAX_RETRIES
} from "../plugins/codex/scripts/lib/app-server.mjs";

// Fake transport: replies to each request via the JSONL handleLine path, with a
// configurable number of leading BROKER_BUSY refusals before a success.
class BusyClient extends AppServerClientBase {
  constructor(busyResponses) {
    super("/tmp");
    this.busyRemaining = busyResponses;
    this.sent = 0;
  }

  sendMessage(message) {
    if (message.id === undefined) {
      return;
    }
    this.sent += 1;
    queueMicrotask(() => {
      if (this.busyRemaining > 0) {
        this.busyRemaining -= 1;
        this.handleLine(JSON.stringify({ id: message.id, error: { code: BROKER_BUSY_RPC_CODE, message: "broker busy" } }));
      } else {
        this.handleLine(JSON.stringify({ id: message.id, result: { ok: true } }));
      }
    });
  }
}

test("request retries on BROKER_BUSY and then succeeds", async () => {
  const client = new BusyClient(2);
  const result = await client.request("turn/start", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(client.sent, 3); // 2 busy refusals + 1 success
});

test("request gives up after BROKER_BUSY_MAX_RETRIES", async () => {
  const client = new BusyClient(BROKER_BUSY_MAX_RETRIES + 1);
  await assert.rejects(client.request("turn/start", {}), /broker busy/);
  assert.equal(client.sent, BROKER_BUSY_MAX_RETRIES + 1);
});

test("request does not retry non-busy errors", async () => {
  class FailClient extends AppServerClientBase {
    constructor() {
      super("/tmp");
      this.sent = 0;
    }
    sendMessage(message) {
      if (message.id === undefined) {
        return;
      }
      this.sent += 1;
      queueMicrotask(() =>
        this.handleLine(JSON.stringify({ id: message.id, error: { code: -32000, message: "other failure" } }))
      );
    }
  }
  const client = new FailClient();
  await assert.rejects(client.request("turn/start", {}), /other failure/);
  assert.equal(client.sent, 1); // no retry
});
