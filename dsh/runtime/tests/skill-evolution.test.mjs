import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadSkillBundle } from "../src/skill-bundle.mjs";
import {
  applySkillEvolutionSelection,
  createSkillEvolutionTool,
  readSkillEvolutionState,
  resolveSkillEvolutionRoot,
  skillEvolutionDisabled,
} from "../src/skill-evolution.mjs";

const canonicalRoot = resolve(import.meta.dirname, "../../../skills/odai");
const canonicalPath = resolve(canonicalRoot, "SKILL.md");

function scratchRoot(label) {
  return mkdtempSync(resolve(tmpdir(), `odai-evolution-${label}-`));
}

function upstreamSelection(bundle = loadSkillBundle(canonicalPath)) {
  return Object.freeze({
    mode: "bundled",
    status: "selected",
    reasonCode: "bundled-configured",
    bundle,
    rejections: Object.freeze([]),
  });
}

function execution(header = {}) {
  return { agent: { phase: {}, session: { header, events: [] } } };
}

function nextSeq(agent) {
  return agent.session.events.length === 0 ? 0 : agent.session.events.at(-1).seq + 1;
}

function appendEvent(agent, type, data) {
  agent.session.events.push({ type, seq: nextSeq(agent), time: 1_777_000_000_000 + nextSeq(agent), data });
}

function userMessage(text, source = "user", content = [{ type: "text", text }]) {
  return {
    id: `user-${text}-${source}`,
    role: "user",
    source: { kind: source },
    content,
  };
}

function beginTurn(agent, message) {
  const previous = [...agent.session.events].reverse().find((event) => event.type === "turn/start" || event.type === "turn/end");
  if (previous?.type === "turn/start") appendEvent(agent, "turn/end", { turn: previous.data.turn, reason: "success" });
  const turn = (previous?.data?.turn ?? 0) + 1;
  agent.phase.turn = turn;
  appendEvent(agent, "turn/start", { turn });
  if (message) appendEvent(agent, "user/message", message);
  return turn;
}

function authorize(agent, phrase, source = "user", content) {
  beginTurn(agent, userMessage(phrase, source, content));
}

function sha256For(tool, agent, path) {
  return tool.execute({ action: "inspect", path }, { agent }).then((result) => result.sha256);
}

function replacementFor(bundle, path, marker) {
  const content = readFileSync(resolve(bundle.root, ...path.split("/")), "utf8");
  const firstLine = content.split(/\r?\n/u)[0];
  return {
    path,
    oldString: firstLine,
    newString: `${firstLine}\n\n${marker}`,
  };
}

async function authorizedProposal(tool, agent, args) {
  const prepared = await tool.execute(args, { agent });
  assert.equal(prepared.status, "authorization-required");
  assert.match(prepared.proposalPhrase, /^PROPOSE ODAI EVOLUTION [a-f0-9]{64}$/u);
  authorize(agent, prepared.proposalPhrase);
  return tool.execute(args, { agent });
}

async function proposeMarker(tool, agent, selection, path, marker, objective = "Add a bounded fixture marker") {
  const replacement = replacementFor(selection.bundle, path, marker);
  const expectedSha256 = await sha256For(tool, agent, path);
  return authorizedProposal(tool, agent, {
    action: "propose",
    objective,
    expectedBundleDigest: selection.bundle.digest,
    changes: [{
      path,
      expectedSha256,
      replacements: [{ oldString: replacement.oldString, newString: replacement.newString }],
    }],
  });
}

test("candidate lifecycle is immutable, explicit, next-turn, and reversible", async () => {
  const scratch = scratchRoot("lifecycle");
  try {
    const root = resolve(scratch, "skill-evolution");
    const upstream = upstreamSelection();
    let current = upstream;
    const events = [];
    const tool = createSkillEvolutionTool(root, {
      currentSelectionFor: () => current,
      now: (() => {
        let tick = 0;
        return () => `2026-08-18T00:00:0${tick++}.000Z`;
      })(),
      onChanged(_agent, data) {
        events.push(data);
      },
    });
    const owner = execution().agent;
    const original = readFileSync(resolve(canonicalRoot, "references/support.md"), "utf8");

    const initial = await tool.execute({ action: "show" }, { agent: owner });
    assert.equal(initial.status, "inactive");
    assert.equal(initial.generations.length, 0);

    const proposed = await proposeMarker(tool, owner, current, "references/support.md", "EVOLUTION_A");
    assert.equal(proposed.status, "candidate");
    assert.match(proposed.generation.generationId, /^[a-f0-9]{64}$/u);
    assert.equal(proposed.generation.creationAuthorization.action, "propose");
    assert.match(proposed.generation.creationAuthorization.phrase, /^PROPOSE ODAI EVOLUTION /u);
    assert.deepEqual(proposed.generation.changedPaths, ["references/support.md"]);
    assert.equal(readSkillEvolutionState(root).activeGenerationId, undefined);
    assert.equal(applySkillEvolutionSelection(upstream, root), upstream);
    assert.equal(readFileSync(resolve(canonicalRoot, "references/support.md"), "utf8"), original);

    const validated = await tool.execute({ action: "validate", generationId: proposed.generation.generationId }, { agent: owner });
    assert.equal(validated.status, "valid");
    assert.equal(validated.generation.authorizationLevel, "standard");
    assert.equal(validated.generation.activationPhrase, `ACTIVATE ODAI EVOLUTION ${proposed.generation.generationId}`);
    assert.throws(
      () => tool.execute({
        action: "activate",
        generationId: proposed.generation.generationId,
        expectedUpstreamDigest: upstream.bundle.digest,
        evidence: ["model-authored evidence is not an accepted argument"],
      }, { agent: owner }),
      /unknown fields: evidence/u,
    );
    assert.throws(
      () => tool.execute({
        action: "activate",
        generationId: proposed.generation.generationId,
        expectedUpstreamDigest: upstream.bundle.digest,
      }, { agent: owner }),
      /current open turn must contain exactly this direct human message/u,
    );
    assert.throws(
      () => tool.execute({ action: "show" }, execution({ origin: "subagent" })),
      /child agents may not/u,
    );
    authorize(owner, validated.generation.activationPhrase, "plugin");
    assert.throws(
      () => tool.execute({
        action: "activate",
        generationId: proposed.generation.generationId,
        expectedUpstreamDigest: upstream.bundle.digest,
      }, { agent: owner }),
      /current open turn must contain exactly this direct human message/u,
    );
    authorize(owner, validated.generation.activationPhrase);
    authorize(owner, "A newer genuine user message revoked the pending confirmation");
    assert.throws(
      () => tool.execute({
        action: "activate",
        generationId: proposed.generation.generationId,
        expectedUpstreamDigest: upstream.bundle.digest,
      }, { agent: owner }),
      /current open turn must contain exactly this direct human message/u,
    );

    authorize(owner, validated.generation.activationPhrase);
    const activated = await tool.execute({
      action: "activate",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: upstream.bundle.digest,
    }, { agent: owner });
    assert.equal(activated.requiresNextTurn, true);
    assert.deepEqual(readSkillEvolutionState(root).history[0].evidence, [
      "direct-human-action:activate",
      `direct-human-turn:${owner.phase.turn}`,
      `direct-human-event-seq:${owner.session.events.at(-1).seq}`,
      `direct-human-message-id:${owner.session.events.at(-1).data.id}`,
      `direct-human-phrase:${validated.generation.activationPhrase}`,
    ]);
    assert.equal(current, upstream, "the existing turn snapshot remains unchanged");

    current = applySkillEvolutionSelection(upstream, root);
    assert.equal(current.bundle.source, "evolution");
    assert.equal(current.evolution.rebaseRequired, false);
    assert.match(current.bundle.referenceContracts.craft, /通用制作工艺/u);
    assert.match(readFileSync(resolve(current.bundle.root, "references/support.md"), "utf8"), /EVOLUTION_A/u);
    const shown = await tool.execute({ action: "show" }, { agent: owner });
    assert.equal(shown.status, "active");
    assert.equal(shown.active.generationId, proposed.generation.generationId);

    const second = await proposeMarker(tool, owner, current, "references/verification.md", "EVOLUTION_B");
    assert.throws(
      () => tool.execute({
        action: "rollback",
        generationId: second.generation.generationId,
      }, { agent: owner }),
      /was never an active/u,
    );
    authorize(owner, second.generation.activationPhrase);
    await tool.execute({
      action: "activate",
      generationId: second.generation.generationId,
      expectedUpstreamDigest: upstream.bundle.digest,
    }, { agent: owner });
    current = applySkillEvolutionSelection(upstream, root);
    assert.equal(current.evolution.generationId, second.generation.generationId);
    assert.throws(
      () => tool.execute({ action: "rollback" }, { agent: owner }),
      /ROLLBACK ODAI EVOLUTION/u,
    );
    authorize(owner, `ROLLBACK ODAI EVOLUTION ${proposed.generation.generationId} TO ${proposed.generation.generationId}`);
    const storeBeforeRejectedRollback = storeFingerprint(root);
    assert.throws(
      () => tool.execute({ action: "rollback" }, { agent: owner }),
      new RegExp(`ROLLBACK ODAI EVOLUTION ${second.generation.generationId} TO`, "u"),
      "rollback authorization is bound to the current active generation",
    );
    assert.equal(readSkillEvolutionState(root).activeGenerationId, second.generation.generationId);
    assert.equal(storeFingerprint(root), storeBeforeRejectedRollback, "rejected rollback performs no filesystem write");
    authorize(owner, `ROLLBACK ODAI EVOLUTION ${second.generation.generationId} TO ${proposed.generation.generationId}`);
    const rolledBack = await tool.execute({ action: "rollback" }, { agent: owner });
    assert.equal(rolledBack.activeGenerationId, proposed.generation.generationId);
    current = applySkillEvolutionSelection(upstream, root);
    assert.equal(current.evolution.generationId, proposed.generation.generationId);

    authorize(owner, "DEACTIVATE ODAI EVOLUTION");
    const storeBeforeRejectedDeactivate = storeFingerprint(root);
    assert.throws(
      () => tool.execute({ action: "deactivate" }, { agent: owner }),
      new RegExp(`DEACTIVATE ODAI EVOLUTION ${proposed.generation.generationId}`, "u"),
      "deactivation authorization is bound to the current active generation",
    );
    assert.equal(readSkillEvolutionState(root).activeGenerationId, proposed.generation.generationId);
    assert.equal(storeFingerprint(root), storeBeforeRejectedDeactivate, "rejected deactivation performs no filesystem write");
    authorize(owner, `DEACTIVATE ODAI EVOLUTION ${proposed.generation.generationId}`);
    const deactivated = await tool.execute({ action: "deactivate" }, { agent: owner });
    assert.equal(deactivated.requiresNextTurn, true);
    assert.equal(readSkillEvolutionState(root).activeGenerationId, undefined);
    current = applySkillEvolutionSelection(upstream, root);
    assert.equal(current, upstream);
    assert.deepEqual(events.map((event) => event.action), [
      "propose",
      "activate",
      "propose",
      "activate",
      "rollback",
      "deactivate",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("authorization is exact, current-turn, single-block, and mutation-free on rejection", async () => {
  const scratch = scratchRoot("authorization-shape");
  try {
    const root = resolve(scratch, "skill-evolution");
    const current = upstreamSelection();
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    const proposed = await proposeMarker(tool, owner, current, "references/support.md", "EVOLUTION_AUTH_SHAPE");
    const phrase = proposed.generation.activationPhrase;
    const generationNames = () => readFileNames(resolve(root, "generations"));
    const baselineGenerationNames = generationNames();
    const assertRejectedWithoutMutation = () => {
      assert.equal(readSkillEvolutionState(root).activeGenerationId, undefined);
      assert.equal(readSkillEvolutionState(root).history.length, 0);
      assert.deepEqual(generationNames(), baselineGenerationNames);
      assert.equal(existsSync(resolve(root, "conflicts")), false);
    };
    const activate = () => tool.execute({
      action: "activate",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: current.bundle.digest,
    }, { agent: owner });

    appendEvent(owner, "turn/end", { turn: owner.phase.turn, reason: "success" });
    const storeBeforeRejectedActivation = storeFingerprint(root);
    assert.throws(activate, /current open turn/u);
    assert.equal(storeFingerprint(root), storeBeforeRejectedActivation, "rejected activation performs no filesystem write");
    assertRejectedWithoutMutation();

    authorize(owner, phrase);
    beginTurn(owner);
    assert.throws(activate, /current open turn/u, "a phrase from a closed turn cannot authorize");
    assertRejectedWithoutMutation();

    for (const text of [` ${phrase}`, `${phrase}\n`, phrase.toLowerCase(), `ACTIVATE ODAI EVOLUTION ${"0".repeat(64)}`]) {
      authorize(owner, text);
      assert.throws(activate, /current open turn/u);
      assertRejectedWithoutMutation();
    }

    authorize(owner, phrase, "user", [{ type: "text", text: phrase }, { type: "text", text: "" }]);
    assert.throws(activate, /current open turn/u, "multiple text blocks cannot authorize");
    assertRejectedWithoutMutation();

    authorize(owner, phrase, "user", [{ type: "text", text: phrase }, { type: "image", mediaType: "image/png", data: "AA==" }]);
    assert.throws(activate, /current open turn/u, "a text block plus an attachment cannot authorize");
    assertRejectedWithoutMutation();

    authorize(owner, phrase);
    appendEvent(owner, "user/message", userMessage("", "user", []));
    assert.throws(activate, /current open turn/u, "a malformed latest human message cannot fall back");
    assertRejectedWithoutMutation();

    beginTurn(owner);
    appendEvent(owner, "assistant/message", { message: { role: "assistant", content: [{ type: "text", text: phrase }] } });
    appendEvent(owner, "user/message", userMessage(phrase, "goal"));
    assert.throws(activate, /current open turn/u, "assistant and goal text cannot authorize");
    assertRejectedWithoutMutation();

    authorize(owner, phrase);
    appendEvent(owner, "user/message", userMessage("host notice after approval", "plugin"));
    const activated = await activate();
    assert.equal(activated.status, "active", "a later non-human notice does not revoke exact human authorization");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("proposal rejects stale, executable, ambiguous, duplicate, and unowned changes", async () => {
  const scratch = scratchRoot("proposal-guards");
  try {
    const root = resolve(scratch, "skill-evolution");
    const current = upstreamSelection();
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    const supportHash = await sha256For(tool, owner, "references/support.md");
    const support = readFileSync(resolve(canonicalRoot, "references/support.md"), "utf8");
    const firstLine = support.split(/\r?\n/u)[0];
    const prepared = await tool.execute({
      action: "propose",
      objective: "valid but not yet authorized",
      expectedBundleDigest: current.bundle.digest,
      changes: [{ path: "references/support.md", expectedSha256: supportHash, replacements: [{ oldString: firstLine, newString: `${firstLine}\nAUTHORIZED_ONLY` }] }],
    }, { agent: owner });
    assert.equal(prepared.status, "authorization-required");
    assert.equal(existsSync(root), false, "preparing an authorization phrase does not create the store");

    assert.throws(
      () => tool.execute({
        action: "propose",
        objective: "stale",
        expectedBundleDigest: "0".repeat(64),
        changes: [{ path: "references/support.md", expectedSha256: supportHash, replacements: [{ oldString: firstLine, newString: `${firstLine}\nX` }] }],
      }, { agent: owner }),
      /expectedBundleDigest does not match/u,
    );
    assert.throws(
      () => tool.execute({
        action: "propose",
        objective: "runtime injection",
        expectedBundleDigest: current.bundle.digest,
        changes: [{ path: "scripts/run-role.mjs", expectedSha256: "0".repeat(64), replacements: [{ oldString: "x", newString: "y" }] }],
      }, { agent: owner }),
      /governance Markdown/u,
    );
    const ambiguousArgs = {
      action: "propose",
      objective: "ambiguous",
      expectedBundleDigest: current.bundle.digest,
      changes: [{ path: "references/support.md", expectedSha256: supportHash, replacements: [{ oldString: "-", newString: "+" }] }],
    };
    const ambiguousPrepared = await tool.execute(ambiguousArgs, { agent: owner });
    authorize(owner, ambiguousPrepared.proposalPhrase);
    assert.throws(
      () => tool.execute(ambiguousArgs, { agent: owner }),
      /must match exactly once/u,
    );
    assert.throws(
      () => tool.execute({
        action: "propose",
        objective: "duplicate",
        expectedBundleDigest: current.bundle.digest,
        changes: [
          { path: "references/support.md", expectedSha256: supportHash, replacements: [{ oldString: firstLine, newString: `${firstLine}\nA` }] },
          { path: "references/support.md", expectedSha256: supportHash, replacements: [{ oldString: firstLine, newString: `${firstLine}\nB` }] },
        ],
      }, { agent: owner }),
      /duplicate path/u,
    );
    assert.equal(existsSync(resolve(root, "state.json")), false, "rejected proposals do not change the active pointer");
    assert.equal(existsSync(resolve(root, "generations")), false, "rejected proposals do not create a generation");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("core and destructive changes require a generation-bound BREAKING confirmation", async () => {
  const scratch = scratchRoot("breaking-authorization");
  try {
    const root = resolve(scratch, "skill-evolution");
    let current = upstreamSelection();
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    const skill = await tool.execute({ action: "inspect", path: "SKILL.md" }, { agent: owner });
    const dao = await tool.execute({ action: "inspect", path: "references/dao.md" }, { agent: owner });
    const support = await tool.execute({ action: "inspect", path: "references/support.md" }, { agent: owner });
    const core = "不曲事实、不越权、不造事";
    const daoHeading = dao.content.split(/\r?\n/u)[0];
    const supportHeading = support.content.split(/\r?\n/u)[0];
    const proposed = await authorizedProposal(tool, owner, {
      action: "propose",
      objective: "Exercise every breaking authorization class",
      expectedBundleDigest: current.bundle.digest,
      changes: [
        {
          path: "SKILL.md",
          expectedSha256: skill.sha256,
          replacements: [{ oldString: core, newString: `${core}，并保留核心确认门` }],
        },
        {
          path: "references/dao.md",
          expectedSha256: dao.sha256,
          replacements: [{ oldString: daoHeading, newString: `${daoHeading}\n\nDAO_PROTECTED_CHANGE` }],
        },
        {
          path: "references/support.md",
          expectedSha256: support.sha256,
          replacements: [{ oldString: supportHeading, newString: "# Replaced support heading" }],
        },
      ],
    });
    const validated = await tool.execute({ action: "validate", generationId: proposed.generation.generationId }, { agent: owner });
    assert.equal(validated.generation.authorizationLevel, "breaking");
    assert.equal(
      validated.generation.activationPhrase,
      `ACTIVATE BREAKING ODAI EVOLUTION ${proposed.generation.generationId}`,
    );
    assert.deepEqual(validated.generation.breakingReasons, [
      "destructive-replacement:references/support.md",
      "protected-file:SKILL.md",
      "protected-file:references/dao.md",
    ]);

    authorize(owner, `ACTIVATE ODAI EVOLUTION ${proposed.generation.generationId}`);
    assert.throws(
      () => tool.execute({
        action: "activate",
        generationId: proposed.generation.generationId,
        expectedUpstreamDigest: current.bundle.digest,
      }, { agent: owner }),
      /ACTIVATE BREAKING ODAI EVOLUTION/u,
    );
    authorize(owner, validated.generation.activationPhrase);
    const activated = await tool.execute({
      action: "activate",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: current.bundle.digest,
    }, { agent: owner });
    assert.equal(activated.status, "active");

    const newRoot = resolve(scratch, "breaking-new-upstream");
    cpSync(canonicalRoot, newRoot, { recursive: true });
    const manifestPath = resolve(newRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.skillVersion = "0.2.2";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const verificationPath = resolve(newRoot, "references/verification.md");
    writeFileSync(verificationPath, `${readFileSync(verificationPath, "utf8").trimEnd()}\n\nBREAKING_REBASE_UPSTREAM\n`, "utf8");
    const newUpstream = upstreamSelection(loadSkillBundle(resolve(newRoot, "SKILL.md"), { source: "bundled", provider: "odai-dsh-runtime" }));
    current = applySkillEvolutionSelection(newUpstream, root);
    authorize(owner, `REBASE ODAI EVOLUTION ${proposed.generation.generationId}`);
    const rebased = await tool.execute({
      action: "rebase",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: newUpstream.bundle.digest,
    }, { agent: owner });
    assert.equal(rebased.generation.authorizationLevel, "breaking");
    assert.ok(rebased.generation.breakingReasons.includes("protected-file:SKILL.md"));
    assert.match(rebased.generation.activationPhrase, /^ACTIVATE BREAKING ODAI EVOLUTION /u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("every SKILL.md surface is conservatively classified as BREAKING", async () => {
  const scratch = scratchRoot("breaking-skill-surfaces");
  try {
    const root = resolve(scratch, "skill-evolution");
    const current = upstreamSelection();
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    const skill = await tool.execute({ action: "inspect", path: "SKILL.md" }, { agent: owner });
    const anchors = [
      "description: 以“成事而不妄为”为入口处理通用任务。用户点名 odai，或任务模糊、复杂、高风险、前提可疑、易漏项或需跨能力协作时使用；简单任务直做。",
      "## 精神内核",
      "## 当前判断",
      "## 按表现分配支撑",
      "## 共同行动边界",
      "## 完成",
    ];
    for (const [index, anchor] of anchors.entries()) {
      const proposed = await authorizedProposal(tool, owner, {
        action: "propose",
        objective: `Classify SKILL surface ${index}`,
        expectedBundleDigest: current.bundle.digest,
        changes: [{
          path: "SKILL.md",
          expectedSha256: skill.sha256,
          replacements: [{ oldString: anchor, newString: `${anchor}\nSKILL_SURFACE_${index}` }],
        }],
      });
      assert.equal(proposed.generation.authorizationLevel, "breaking");
      assert.deepEqual(proposed.generation.breakingReasons, ["protected-file:SKILL.md"]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("tampering and undeclared files invalidate a generation before activation", async () => {
  const scratch = scratchRoot("tamper");
  try {
    const root = resolve(scratch, "skill-evolution");
    const current = upstreamSelection();
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    const proposed = await proposeMarker(tool, owner, current, "references/verification.md", "EVOLUTION_TAMPER");
    const generationRoot = resolve(root, "generations", proposed.generation.generationId);
    writeFileSync(resolve(generationRoot, "bundle/extra.mjs"), "export default true;\n", "utf8");

    assert.throws(
      () => tool.execute({ action: "validate", generationId: proposed.generation.generationId }, { agent: owner }),
      /undeclared file/u,
    );
    assert.throws(
      () => tool.execute({
        action: "activate",
        generationId: proposed.generation.generationId,
        expectedUpstreamDigest: current.bundle.digest,
      }, { agent: owner }),
      /undeclared file/u,
    );
    assert.equal(readSkillEvolutionState(root).activeGenerationId, undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("clean rebase preserves both upstream and user changes without activating", async () => {
  const scratch = scratchRoot("rebase-clean");
  try {
    const root = resolve(scratch, "skill-evolution");
    const oldUpstream = upstreamSelection();
    let current = oldUpstream;
    const tool = createSkillEvolutionTool(root, {
      currentSelectionFor: () => current,
      now: (() => {
        let tick = 0;
        return () => `2026-08-18T01:00:0${tick++}.000Z`;
      })(),
    });
    const owner = execution().agent;
    const proposed = await proposeMarker(tool, owner, current, "references/support.md", "EVOLUTION_REBASE");
    authorize(owner, proposed.generation.activationPhrase);
    await tool.execute({
      action: "activate",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: oldUpstream.bundle.digest,
    }, { agent: owner });

    const newRoot = resolve(scratch, "new-upstream");
    cpSync(canonicalRoot, newRoot, { recursive: true });
    const manifestPath = resolve(newRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.skillVersion = "0.2.2";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(
      resolve(newRoot, "references/verification.md"),
      `${readFileSync(resolve(newRoot, "references/verification.md"), "utf8").trimEnd()}\n\nUPSTREAM_REBASE\n`,
      "utf8",
    );
    const newUpstream = upstreamSelection(loadSkillBundle(resolve(newRoot, "SKILL.md"), { source: "bundled", provider: "odai-dsh-runtime" }));
    current = applySkillEvolutionSelection(newUpstream, root);
    assert.equal(current.evolution.rebaseRequired, true);
    assert.match(readFileSync(resolve(current.bundle.root, "references/support.md"), "utf8"), /EVOLUTION_REBASE/u);

    const generationsBeforeRejectedRebase = readFileNames(resolve(root, "generations"));
    const storeBeforeRejectedRebase = storeFingerprint(root);
    assert.throws(
      () => tool.execute({
        action: "rebase",
        generationId: proposed.generation.generationId,
        expectedUpstreamDigest: newUpstream.bundle.digest,
      }, { agent: owner }),
      /REBASE ODAI EVOLUTION/u,
    );
    assert.deepEqual(readFileNames(resolve(root, "generations")), generationsBeforeRejectedRebase);
    assert.equal(existsSync(resolve(root, "conflicts")), false);
    assert.equal(storeFingerprint(root), storeBeforeRejectedRebase, "rejected rebase performs no filesystem write");

    authorize(owner, `REBASE ODAI EVOLUTION ${proposed.generation.generationId}`);
    const rebased = await tool.execute({
      action: "rebase",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: newUpstream.bundle.digest,
    }, { agent: owner });
    assert.equal(rebased.status, "candidate");
    assert.equal(rebased.generation.creationAuthorization.action, "rebase");
    assert.match(rebased.generation.creationAuthorization.phrase, /^REBASE ODAI EVOLUTION /u);
    assert.notEqual(rebased.generation.generationId, proposed.generation.generationId);
    assert.equal(readSkillEvolutionState(root).activeGenerationId, proposed.generation.generationId, "rebase does not activate");
    const inspectedSupport = await tool.execute({ action: "inspect", generationId: rebased.generation.generationId, path: "references/support.md" }, { agent: owner });
    const inspectedVerification = await tool.execute({ action: "inspect", generationId: rebased.generation.generationId, path: "references/verification.md" }, { agent: owner });
    assert.match(inspectedSupport.content, /EVOLUTION_REBASE/u);
    assert.match(inspectedVerification.content, /UPSTREAM_REBASE/u);

    authorize(owner, rebased.generation.activationPhrase);
    await tool.execute({
      action: "activate",
      generationId: rebased.generation.generationId,
      expectedUpstreamDigest: newUpstream.bundle.digest,
    }, { agent: owner });
    current = applySkillEvolutionSelection(newUpstream, root);
    assert.equal(current.evolution.rebaseRequired, false);
    assert.equal(current.bundle.manifest.skillVersion, "0.2.2");
    assert.match(readFileSync(resolve(current.bundle.root, "references/support.md"), "utf8"), /EVOLUTION_REBASE/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("rebase conflicts preserve three-way evidence and leave active unchanged", async () => {
  const scratch = scratchRoot("rebase-conflict");
  try {
    const root = resolve(scratch, "skill-evolution");
    const oldUpstream = upstreamSelection();
    let current = oldUpstream;
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current, now: () => "2026-08-18T02:00:00.000Z" });
    const owner = execution().agent;
    const proposed = await proposeMarker(tool, owner, current, "references/support.md", "EVOLUTION_CONFLICT");
    authorize(owner, proposed.generation.activationPhrase);
    await tool.execute({
      action: "activate",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: oldUpstream.bundle.digest,
    }, { agent: owner });

    const conflictingRoot = resolve(scratch, "conflicting-upstream");
    cpSync(canonicalRoot, conflictingRoot, { recursive: true });
    const supportPath = resolve(conflictingRoot, "references/support.md");
    const support = readFileSync(supportPath, "utf8");
    const firstLine = support.split(/\r?\n/u)[0];
    writeFileSync(supportPath, support.replace(firstLine, "# Upstream replaced this heading"), "utf8");
    const conflicting = upstreamSelection(loadSkillBundle(resolve(conflictingRoot, "SKILL.md"), { source: "bundled", provider: "odai-dsh-runtime" }));
    current = applySkillEvolutionSelection(conflicting, root);

    authorize(owner, `REBASE ODAI EVOLUTION ${proposed.generation.generationId}`);
    const rebased = await tool.execute({
      action: "rebase",
      generationId: proposed.generation.generationId,
      expectedUpstreamDigest: conflicting.bundle.digest,
    }, { agent: owner });
    assert.equal(rebased.status, "conflict");
    assert.equal(rebased.conflicts[0].path, "references/support.md");
    assert.equal(readSkillEvolutionState(root).activeGenerationId, proposed.generation.generationId);
    const conflictRoot = resolve(root, "conflicts", rebased.attemptId);
    assert.equal(existsSync(resolve(conflictRoot, "base/references/support.md")), true);
    assert.equal(existsSync(resolve(conflictRoot, "ours/references/support.md")), true);
    assert.equal(existsSync(resolve(conflictRoot, "theirs/references/support.md")), true);
    const report = JSON.parse(readFileSync(resolve(conflictRoot, "report.json"), "utf8"));
    const authorizationEvent = owner.session.events.at(-1);
    assert.deepEqual(report.authorization, {
      action: "rebase",
      phrase: `REBASE ODAI EVOLUTION ${proposed.generation.generationId}`,
      turn: owner.phase.turn,
      eventSeq: authorizationEvent.seq,
      messageId: authorizationEvent.data.id,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("generation identity covers provenance instead of only result bundle bytes", async () => {
  const scratch = scratchRoot("identity");
  try {
    const root = resolve(scratch, "skill-evolution");
    const current = upstreamSelection();
    let tick = 0;
    const tool = createSkillEvolutionTool(root, {
      currentSelectionFor: () => current,
      now: () => `2026-08-18T03:00:0${tick++}.000Z`,
    });
    const owner = execution().agent;
    const first = await proposeMarker(tool, owner, current, "references/dao.md", "EVOLUTION_IDENTITY", "Same result, first provenance");
    const second = await proposeMarker(tool, owner, current, "references/dao.md", "EVOLUTION_IDENTITY", "Same result, second provenance");
    assert.notEqual(first.generation.generationId, second.generation.generationId);
    assert.equal(first.generation.resultDigest, second.generation.resultDigest);
    assert.equal((await tool.execute({ action: "validate", generationId: first.generation.generationId }, { agent: owner })).status, "valid");
    assert.equal((await tool.execute({ action: "validate", generationId: second.generation.generationId }, { agent: owner })).status, "valid");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("legacy schema-1 generation metadata remains readable without creation authorization", async () => {
  const scratch = scratchRoot("legacy-generation");
  try {
    const root = resolve(scratch, "skill-evolution");
    const current = upstreamSelection();
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    const proposed = await proposeMarker(tool, owner, current, "references/support.md", "LEGACY_GENERATION");
    const source = resolve(root, "generations", proposed.generation.generationId);
    const metadata = JSON.parse(readFileSync(resolve(source, "metadata.json"), "utf8"));
    const { generationId: _generationId, authorization: _authorization, ...legacyMetadata } = metadata;
    const legacyIdentity = {
      schemaVersion: legacyMetadata.schemaVersion,
      parentGenerationId: legacyMetadata.parentGenerationId ?? null,
      createdAt: legacyMetadata.createdAt,
      objective: legacyMetadata.objective,
      base: legacyMetadata.base,
      result: legacyMetadata.result,
      patches: legacyMetadata.patches,
    };
    const legacyId = createHash("sha256").update(JSON.stringify(legacyIdentity)).digest("hex");
    const destination = resolve(root, "generations", legacyId);
    cpSync(source, destination, { recursive: true });
    writeFileSync(resolve(destination, "metadata.json"), `${JSON.stringify({ generationId: legacyId, ...legacyMetadata }, null, 2)}\n`, "utf8");

    const validated = await tool.execute({ action: "validate", generationId: legacyId }, { agent: owner });
    assert.equal(validated.status, "valid");
    assert.equal("creationAuthorization" in validated.generation, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("runtime bundle snapshots survive on-disk package replacement within a process", async () => {
  const scratch = scratchRoot("memory-snapshot");
  try {
    const source = resolve(scratch, "bundled");
    cpSync(canonicalRoot, source, { recursive: true });
    const loaded = loadSkillBundle(resolve(source, "SKILL.md"), { source: "bundled", provider: "odai-dsh-runtime" });
    const current = upstreamSelection(loaded);
    const root = resolve(scratch, "skill-evolution");
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    const before = await tool.execute({ action: "inspect", path: "references/support.md" }, { agent: owner });
    writeFileSync(resolve(source, "references/support.md"), "PACKAGE_REPLACED_ON_DISK\n", "utf8");
    const after = await tool.execute({ action: "inspect", path: "references/support.md" }, { agent: owner });
    assert.equal(after.sha256, before.sha256);
    assert.equal(after.content, before.content);
    const oldString = before.content.split(/\r?\n/u)[0];
    const proposed = await authorizedProposal(tool, owner, {
      action: "propose",
      objective: "Use the process immutable upstream snapshot",
      expectedBundleDigest: current.bundle.digest,
      changes: [{
        path: "references/support.md",
        expectedSha256: before.sha256,
        replacements: [{ oldString, newString: `${oldString}\n\nMEMORY_SNAPSHOT` }],
      }],
    });
    assert.equal(proposed.status, "candidate");
    const candidate = await tool.execute({ action: "inspect", generationId: proposed.generation.generationId, path: "references/support.md" }, { agent: owner });
    assert.match(candidate.content, /MEMORY_SNAPSHOT/u);
    assert.doesNotMatch(candidate.content, /PACKAGE_REPLACED_ON_DISK/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("store symlinks and semantically broken pointer history fail closed", async (t) => {
  const scratch = scratchRoot("store-safety");
  try {
    const root = resolve(scratch, "skill-evolution");
    const outside = resolve(scratch, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    let symlinkAvailable = true;
    try {
      symlinkSync(outside, resolve(root, "generations"), "dir");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
      symlinkAvailable = false;
      t.diagnostic(`skill-evolution symlink assertion unavailable in this environment (${error.code})`);
    }
    const current = upstreamSelection();
    const tool = createSkillEvolutionTool(root, { currentSelectionFor: () => current });
    const owner = execution().agent;
    if (symlinkAvailable) {
      const inspected = await tool.execute({ action: "inspect", path: "references/support.md" }, { agent: owner });
      const oldString = inspected.content.split(/\r?\n/u)[0];
      const proposalArgs = {
        action: "propose",
        objective: "must not cross a store symlink",
        expectedBundleDigest: current.bundle.digest,
        changes: [{
          path: "references/support.md",
          expectedSha256: inspected.sha256,
          replacements: [{ oldString, newString: `${oldString}\nSYMLINK_ESCAPE` }],
        }],
      };
      const prepared = await tool.execute(proposalArgs, { agent: owner });
      authorize(owner, prepared.proposalPhrase);
      assert.throws(
        () => tool.execute(proposalArgs, { agent: owner }),
        /generations directory must be a regular directory/u,
      );
      assert.deepEqual(readFileNames(outside), []);
      rmSync(resolve(root, "generations"), { force: true });
    }
    const first = "1".repeat(64);
    const second = "2".repeat(64);
    writeFileSync(resolve(root, "state.json"), `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      activeGenerationId: first,
      history: [
        { revision: 1, action: "activate", from: null, to: first, at: "2026-08-18T04:00:00.000Z", evidence: ["legacy model-authored evidence"] },
      ],
    }, null, 2)}\n`, "utf8");
    assert.deepEqual(readSkillEvolutionState(root).history[0].evidence, ["legacy model-authored evidence"]);

    writeFileSync(resolve(root, "state.json"), `${JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      activeGenerationId: second,
      history: [
        { revision: 1, action: "activate", from: null, to: first, at: "2026-08-18T04:00:00.000Z", evidence: ["first"] },
        { revision: 2, action: "deactivate", from: second, to: second, at: "2026-08-18T04:00:01.000Z", evidence: ["tampered"] },
      ],
    }, null, 2)}\n`, "utf8");
    assert.throws(() => readSkillEvolutionState(root), /does not change|breaks the active-pointer chain|deactivate must clear/u);
    const selected = applySkillEvolutionSelection(current, root);
    assert.equal(selected.status, "fallback");
    assert.equal(selected.bundle, current.bundle);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function readFileNames(root, prefix = "") {
  if (!existsSync(root)) return [];
  const files = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (lstatSync(path).isDirectory()) files.push(...readFileNames(path, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

function storeFingerprint(root) {
  if (!existsSync(root)) return "absent";
  const entries = [];
  const visit = (path, relativePath) => {
    const metadata = statSync(path, { bigint: true });
    entries.push({
      path: relativePath,
      type: metadata.isDirectory() ? "directory" : "file",
      mode: metadata.mode.toString(),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ...(metadata.isFile() ? { sha256: createHash("sha256").update(readFileSync(path)).digest("hex") } : {}),
    });
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(resolve(path, name), relativePath ? `${relativePath}/${name}` : name);
    }
  };
  visit(root, ".");
  return JSON.stringify(entries);
}

test("invalid state falls back visibly and host bypass keeps upstream", async () => {
  const scratch = scratchRoot("fallback");
  try {
    const root = resolve(scratch, "skill-evolution");
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, "state.json"), "{broken\n", "utf8");
    const upstream = upstreamSelection();
    const selected = applySkillEvolutionSelection(upstream, root);
    assert.equal(selected.status, "fallback");
    assert.equal(selected.reasonCode, "evolution-state-invalid");
    assert.equal(selected.bundle, upstream.bundle);

    const disabled = applySkillEvolutionSelection(upstream, root, { disabled: true });
    assert.equal(disabled.bundle, upstream.bundle);
    assert.equal(disabled.evolution.hostOverride, true);
    const tool = createSkillEvolutionTool(root, { disabled: true, currentSelectionFor: () => disabled });
    assert.equal((await tool.execute({ action: "show" }, execution())).status, "disabled");
    assert.throws(
      () => tool.execute({ action: "validate", generationId: "0".repeat(64) }, execution()),
      /disabled by ODAI_DISABLE_EVOLUTION/u,
    );
    assert.equal(skillEvolutionDisabled({ ODAI_DISABLE_EVOLUTION: "1" }), true);
    assert.equal(skillEvolutionDisabled({ ODAI_DISABLE_EVOLUTION: "0" }), false);
    assert.equal(
      resolveSkillEvolutionRoot(undefined, { DSH_HOME: resolve(scratch, "home") }),
      resolve(scratch, "home/odai/skill-evolution"),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
