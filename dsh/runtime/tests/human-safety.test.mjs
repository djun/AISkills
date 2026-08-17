import assert from "node:assert/strict";
import test from "node:test";

import { createHumanSafetyTool } from "../src/human-safety.mjs";

test("human-safety guidance is proactive, argument-free, and keeps the controller on the user channel", async () => {
  const contract = "提前预警、及时干预、主动引导；不得造成二次伤害。";
  const tool = createHumanSafetyTool({
    contractFor() { return contract; },
    isChild(agent) { return agent.child === true; },
  });
  assert.match(tool.description, /Invoke proactively/iu);
  assert.match(tool.description, /must not be used to diagnose, profile, score, or persist/iu);
  assert.deepEqual(tool.parameters.required, undefined);
  assert.deepEqual(tool.output.schema.required, ["priority", "principles", "userChannelOwner", "contract"]);

  const controller = await tool.execute({}, { agent: { child: false } });
  assert.equal(controller.priority, "highest");
  assert.equal(controller.userChannelOwner, "current-controller");
  assert.equal(controller.contract, contract);
  assert.deepEqual(controller.principles, [
    "early-warning",
    "timely-intervention",
    "active-guidance",
    "no-secondary-harm",
  ]);
  assert.match(tool.output.render({}, controller)[0].text, /提前预警、及时干预、主动引导/u);

  const child = await tool.execute({}, { agent: { child: true } });
  assert.equal(child.userChannelOwner, "controller");
  assert.throws(() => tool.execute({ severity: "high" }, { agent: {} }), /accepts no arguments/u);
});
