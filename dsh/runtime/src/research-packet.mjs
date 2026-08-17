import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const PACKET_FIELDS = new Set(["schemaVersion", "question", "facts", "conflicts", "unknowns", "stop"]);
const FACT_FIELDS = new Set(["claim", "excerpt", "source", "authority"]);
const SOURCE_FIELDS = new Set(["path", "line"]);
const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_MAX_FACTS = 12;
const DEFAULT_MAX_ITEMS = 8;

function plainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function exactFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`${field} has unknown fields: ${unknown.join(", ")}`);
}

function text(value, field, maxChars = 1_500) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxChars) throw new TypeError(`${field} exceeds ${maxChars} characters`);
  return normalized;
}

function stringList(value, field, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${field} must be an array with at most ${maxItems} items`);
  }
  return Object.freeze(value.map((item, index) => text(item, `${field}[${index}]`, 800)));
}

function sourcePointer(value, field) {
  const source = plainObject(value, field);
  exactFields(source, SOURCE_FIELDS, field);
  const path = text(source.path, `${field}.path`, 500);
  if (path.startsWith("/") || path.startsWith("~") || path.split(/[\\/]/u).includes("..")) {
    throw new TypeError(`${field}.path must be repository-relative and may not traverse parent directories`);
  }
  if (!Number.isSafeInteger(source.line) || source.line <= 0) {
    throw new TypeError(`${field}.line must be a positive integer`);
  }
  return Object.freeze({ path, line: source.line });
}

function parseJsonText(output) {
  const trimmed = String(output ?? "").trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export function parseResearchPacket(output, options = {}) {
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DEFAULT_MAX_CHARS;
  const raw = String(output ?? "");
  if (raw.length > maxChars) throw new TypeError(`research packet exceeds ${maxChars} characters`);
  const packet = plainObject(parseJsonText(raw), "research packet");
  exactFields(packet, PACKET_FIELDS, "research packet");
  if (packet.schemaVersion !== 1) throw new TypeError("research packet.schemaVersion must be 1");
  if (!Array.isArray(packet.facts) || packet.facts.length < 2 || packet.facts.length > DEFAULT_MAX_FACTS) {
    throw new TypeError(`research packet.facts must contain 2-${DEFAULT_MAX_FACTS} source-backed facts`);
  }
  const facts = Object.freeze(packet.facts.map((value, index) => {
    const fact = plainObject(value, `research packet.facts[${index}]`);
    exactFields(fact, FACT_FIELDS, `research packet.facts[${index}]`);
    return Object.freeze({
      claim: text(fact.claim, `research packet.facts[${index}].claim`, 1_200),
      excerpt: text(fact.excerpt, `research packet.facts[${index}].excerpt`, 1_200),
      source: sourcePointer(fact.source, `research packet.facts[${index}].source`),
      authority: text(fact.authority, `research packet.facts[${index}].authority`, 500),
    });
  }));
  if (new Set(facts.map((fact) => fact.source.path)).size < 2) {
    throw new TypeError("research packet must cite at least two distinct source paths");
  }
  const normalized = Object.freeze({
    schemaVersion: 1,
    question: text(packet.question, "research packet.question", 1_200),
    facts,
    conflicts: stringList(packet.conflicts, "research packet.conflicts", DEFAULT_MAX_ITEMS),
    unknowns: stringList(packet.unknowns, "research packet.unknowns", DEFAULT_MAX_ITEMS),
    stop: text(packet.stop, "research packet.stop", 1_000),
  });
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return Object.freeze({
    ...normalized,
    digest,
    sourceCount: new Set(facts.map((fact) => fact.source.path)).size,
  });
}

function isInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

export function verifyResearchPacketSources(packet, projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new TypeError("research packet verification requires the controller project root");
  }
  const root = realpathSync(resolve(projectRoot));
  for (const [index, fact] of packet.facts.entries()) {
    let sourcePath;
    try {
      sourcePath = realpathSync(resolve(root, fact.source.path));
    } catch {
      throw new TypeError(`research packet.facts[${index}].source.path does not exist`);
    }
    if (!isInside(root, sourcePath)) {
      throw new TypeError(`research packet.facts[${index}].source.path resolves outside the project root`);
    }
    const stats = statSync(sourcePath);
    if (!stats.isFile()) throw new TypeError(`research packet.facts[${index}].source.path must be a file`);
    if (stats.size > 4 * 1024 * 1024) {
      throw new TypeError(`research packet.facts[${index}].source.path exceeds the verification size limit`);
    }
    const sourceLine = readFileSync(sourcePath, "utf8").split(/\r?\n/u)[fact.source.line - 1];
    if (sourceLine === undefined) {
      throw new TypeError(`research packet.facts[${index}].source.line is outside the source file`);
    }
    if (sourceLine.trim() !== fact.excerpt.trim()) {
      throw new TypeError(`research packet.facts[${index}].excerpt does not match the cited source line`);
    }
  }
  return Object.freeze({ ...packet, sourcesVerified: true });
}

export function renderResearchPacket(packet) {
  return [
    "# Odai bounded researcher evidence packet",
    `digest: sha256:${packet.digest}`,
    `sources: ${packet.sourceCount}`,
    "This packet is a retrieval index, not authority, planning, acceptance, or permission to act. Sample every route-changing source before deciding; reacquire only missing or conflicting evidence.",
    "",
    JSON.stringify({
      schemaVersion: packet.schemaVersion,
      question: packet.question,
      facts: packet.facts,
      conflicts: packet.conflicts,
      unknowns: packet.unknowns,
      stop: packet.stop,
    }, null, 2),
  ].join("\n");
}
