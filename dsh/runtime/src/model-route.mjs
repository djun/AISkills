const DETERMINISTIC_CODES = new Set([
  "NO_ADAPTER",
  "UNKNOWN_MODEL",
  "UNSUPPORTED_REASONING_EFFORT",
  "INVALID_MODEL",
  "INVALID_MODEL_CONFIG",
  "MODEL_NOT_FOUND",
]);

const ENVIRONMENT_CODES = new Set([
  "AUTH",
  "MISSING_CREDENTIAL",
  "PERMISSION",
  "QUOTA_EXCEEDED",
]);

const TRANSIENT_CODES = new Set([
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

function errorCode(error) {
  const code = error?.code ?? error?.failure?.code;
  return typeof code === "string" && code.trim() ? code.trim().toUpperCase() : "UNKNOWN";
}

function errorMessage(error) {
  const message = error?.message ?? error?.failure?.message;
  return typeof message === "string" && message.trim() ? message.trim() : String(error);
}

function explicitMissingModel(message) {
  return /(?:\bmodel\b[^\n]{0,80}\b(?:not found|does not exist|unknown|unsupported)\b)|(?:\b(?:not found|unknown)\b[^\n]{0,80}\bmodel\b)|(?:\bmodel_not_found\b)/iu.test(message);
}

export function classifyModelRouteFailure(error) {
  const code = errorCode(error);
  const message = errorMessage(error);
  let kind = "unknown";
  if (DETERMINISTIC_CODES.has(code) || explicitMissingModel(message)) kind = "deterministic";
  else if (ENVIRONMENT_CODES.has(code)) kind = "environment";
  else if (TRANSIENT_CODES.has(code)) kind = "transient";
  else if (code === "ABORTED") kind = "cancelled";
  return Object.freeze({ kind, code, message });
}

export async function probeModelRoute(resolveCallConfig, route, signal) {
  if (typeof resolveCallConfig !== "function") {
    return Object.freeze({ status: "unavailable" });
  }
  try {
    const resolved = await resolveCallConfig({ ...route }, signal);
    return Object.freeze({
      status: "verified",
      config: Object.freeze({ ...(resolved?.config ?? resolved ?? route) }),
    });
  } catch (error) {
    return Object.freeze({
      status: "rejected",
      failure: classifyModelRouteFailure(error),
    });
  }
}

export async function requireModelRoute(resolveCallConfig, route, signal, subject = "model route") {
  const result = await probeModelRoute(resolveCallConfig, route, signal);
  if (result.status !== "rejected") return result;
  const error = new Error(`${subject} rejected: ${result.failure.code}: ${result.failure.message}`);
  error.code = result.failure.code;
  error.routeFailureKind = result.failure.kind;
  throw error;
}

export function sameModelRoute(left, right) {
  if (!left || !right) return false;
  return ["provider", "model", "reasoningEffort", "maxTokens"]
    .every((field) => left[field] === right[field]);
}
