import path from "node:path";

export const CANARY_ISOLATION_CONTRACT = "odai-canary-isolation/v1";

export function requireCanaryIsolation(adapter, role = "runner") {
  const contract = String(process.env.ODAI_CANARY_ISOLATION || "");
  const skillMode = String(process.env.ODAI_CANARY_SKILL_MODE || "");
  const isolatedHome = path.resolve(String(process.env.ODAI_CANARY_HOME || ""));
  const actualHome = path.resolve(String(process.env.HOME || process.env.USERPROFILE || ""));
  if (contract !== CANARY_ISOLATION_CONTRACT) {
    throw new Error(`${adapter}: formal canary runs require ${CANARY_ISOLATION_CONTRACT}`);
  }
  if (!new Set(["on", "off"]).has(skillMode)) {
    throw new Error(`${adapter}: ODAI_CANARY_SKILL_MODE must be on or off`);
  }
  if (!isolatedHome || actualHome !== isolatedHome) {
    throw new Error(`${adapter}: HOME must be the harness-owned isolated home`);
  }
  return {
    contract,
    skillMode,
    isolatedHome,
    marker: `[canary-isolation contract=${contract} adapter=${adapter} role=${role} skill_mode=${skillMode} home=isolated]`,
  };
}

export function emitCanaryIsolation(adapter, role = "runner") {
  const isolation = requireCanaryIsolation(adapter, role);
  process.stdout.write(`${isolation.marker}\n`);
  return isolation;
}
