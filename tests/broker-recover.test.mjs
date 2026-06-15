import assert from "node:assert/strict";
import { test } from "node:test";

import * as brokerLifecycle from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { isBrokerEndpointReady } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

// PORTING NOTE (supa vs Robbyfuu/codex-plugin-cc):
//
// Robbyfuu's broker-recover.test.mjs also exercises `sendBrokerRecover` against
// a live socket — the client half of the broker's `broker/recover` HARD-CANCEL
// hook (an explicit cancel that forces an immediate interrupt+restart of the
// active slot). That hook is a SEPARATE feature from the idle-driven self-heal
// loop ported in this change, and supa's broker-lifecycle.mjs does not export
// `sendBrokerRecover` (nor does the broker implement the `broker/recover`
// method). Porting those assertions would require pulling in that unrelated
// feature, which is out of scope here, so they are intentionally deferred.
//
// What IS in scope and asserted below: `isBrokerEndpointReady` (already exported
// by supa's broker-lifecycle.mjs and reused by doctor) must remain a stable
// export. The self-heal recovery sequence itself is covered, with no live
// socket, by broker-routing.test.mjs (performBrokerRecovery happy/unhappy paths).

test("broker-lifecycle exports isBrokerEndpointReady for doctor reuse", () => {
  assert.equal(typeof brokerLifecycle.isBrokerEndpointReady, "function");
  assert.equal(typeof isBrokerEndpointReady, "function");
});
