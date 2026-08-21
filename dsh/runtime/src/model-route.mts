import type { ModelRoute, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const DETERMINISTIC_CODES = new Set<string>([
  "NO_ADAPTER",
  "UNKNOWN_MODEL",
  "UNSUPPORTED_REASONING_EFFORT",
  "INVALID_MODEL",
  "INVALID_MODEL_CONFIG",
  "MODEL_NOT_FOUND",
]);

const ENVIRONMENT_CODES = new Set<string>([
  "AUTH",
  "MISSING_CREDENTIAL",
  "PERMISSION",
  "QUOTA_EXCEEDED",
]);

const TRANSIENT_CODES = new Set<string>([
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

export type ModelRouteFailureKind = "unknown" | "deterministic" | "environment" | "transient" | "cancelled";

export interface ModelRouteFailure {
  readonly kind: ModelRouteFailureKind;
  readonly code: string;
  readonly message: string;
}

export type ModelRouteProbe =
  | { readonly status: "unavailable" }
  | { readonly status: "verified"; readonly config: Readonly<UnknownRecord> }
  | { readonly status: "rejected"; readonly failure: ModelRouteFailure };

export type ResolveCallConfig = (
  route: ModelRoute,
  signal?: AbortSignal,
) => unknown | Promise<unknown>;

function nestedFailure(error: UnknownRecord): UnknownRecord | undefined {
  return isUnknownRecord(error.failure) ? error.failure : undefined;
}

function errorCode(error: unknown): string {
  if (!isUnknownRecord(error)) return "UNKNOWN";
  const code = error.code ?? nestedFailure(error)?.code;
  return typeof code === "string" && code.trim() ? code.trim().toUpperCase() : "UNKNOWN";
}

function errorMessage(error: unknown): string {
  if (!isUnknownRecord(error)) return String(error);
  const message = error.message ?? nestedFailure(error)?.message;
  return typeof message === "string" && message.trim() ? message.trim() : String(error);
}

function explicitMissingModel(message: string): boolean {
  return /(?:\bmodel\b[^\n]{0,80}\b(?:not found|does not exist|unknown|unsupported)\b)|(?:\b(?:not found|unknown)\b[^\n]{0,80}\bmodel\b)|(?:\bmodel_not_found\b)/iu.test(message);
}

export function classifyModelRouteFailure(error: unknown): Readonly<ModelRouteFailure> {
  const code = errorCode(error);
  const message = errorMessage(error);
  let kind: ModelRouteFailureKind = "unknown";
  if (DETERMINISTIC_CODES.has(code) || explicitMissingModel(message)) kind = "deterministic";
  else if (ENVIRONMENT_CODES.has(code)) kind = "environment";
  else if (TRANSIENT_CODES.has(code)) kind = "transient";
  else if (code === "ABORTED") kind = "cancelled";
  return Object.freeze({ kind, code, message });
}

export async function probeModelRoute(
  resolveCallConfig: ResolveCallConfig | undefined,
  route: ModelRoute,
  signal?: AbortSignal,
): Promise<ModelRouteProbe> {
  if (typeof resolveCallConfig !== "function") {
    return Object.freeze({ status: "unavailable" });
  }
  try {
    const resolved = await resolveCallConfig({ ...route }, signal);
    const config = isUnknownRecord(resolved) && isUnknownRecord(resolved.config)
      ? resolved.config
      : isUnknownRecord(resolved) ? resolved : route;
    return Object.freeze({
      status: "verified",
      config: Object.freeze({ ...config }),
    });
  } catch (error) {
    return Object.freeze({
      status: "rejected",
      failure: classifyModelRouteFailure(error),
    });
  }
}

export async function requireModelRoute(
  resolveCallConfig: ResolveCallConfig | undefined,
  route: ModelRoute,
  signal?: AbortSignal,
  subject = "model route",
): Promise<ModelRouteProbe> {
  const result = await probeModelRoute(resolveCallConfig, route, signal);
  if (result.status !== "rejected") return result;
  const error = Object.assign(
    new Error(`${subject} rejected: ${result.failure.code}: ${result.failure.message}`),
    { code: result.failure.code, routeFailureKind: result.failure.kind },
  );
  throw error;
}

export function sameModelRoute(
  left: Partial<ModelRoute> | null | undefined,
  right: Partial<ModelRoute> | null | undefined,
): boolean {
  if (!left || !right) return false;
  const fields: readonly (keyof ModelRoute)[] = ["provider", "model", "reasoningEffort", "maxTokens"];
  return fields.every((field) => left[field] === right[field]);
}
