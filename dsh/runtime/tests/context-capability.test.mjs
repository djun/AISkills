import assert from "node:assert/strict";
import test from "node:test";

import {
  activateRequestedCapabilities,
  createContextCapabilityTool,
  requestedContextCapabilities,
} from "../build/context-capability.mjs";
import { classifyContextActivation } from "../build/context-activation.mjs";

test("capability gateway enables an otherwise missed intent for the current turn", async () => {
  const requests = [];
  const tool = createContextCapabilityTool({
    isChild(agent) { return agent.child === true; },
    onRequested(_agent, capability) { requests.push(capability); },
  });
  const result = await tool.execute({ capability: "compaction-config" }, { agent: { child: false } });
  assert.deepEqual(result, { capability: "compaction-config", status: "available-next-step" });
  assert.deepEqual(requests, ["compaction-config"]);

  const events = [
    { type: "odai/context-capability-requested", data: { turn: 3, step: 1, capability: "compaction-config" } },
    { type: "odai/context-capability-requested", data: { turn: 2, step: 4, capability: "memory" } },
  ];
  const capabilities = requestedContextCapabilities(events, 3);
  assert.deepEqual(capabilities, ["compaction-config"]);
  const activation = activateRequestedCapabilities(classifyContextActivation("这个设置换一下"), capabilities);
  assert.equal(activation.compactionConfig, true);
  assert.equal(activation.memory, false);
});

test("capability gateway performs no child or unknown capability action", async () => {
  const tool = createContextCapabilityTool({ isChild(agent) { return agent.child === true; } });
  assert.throws(
    () => tool.execute({ capability: "routing-config" }, { agent: { session: {}, child: true } }),
    /child agents/u,
  );
  assert.throws(
    () => tool.execute({ capability: "unknown" }, { agent: { session: {} } }),
    /capability must be/u,
  );
});
