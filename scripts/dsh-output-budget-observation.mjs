function outputTokensOf(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  for (const field of ["outputTokens", "output_tokens"]) {
    if (Number.isFinite(usage[field]) && usage[field] >= 0) return usage[field];
  }
  return undefined;
}

export function observeProviderOutputCeiling(samples, requestedMaxTokens) {
  if (requestedMaxTokens === undefined) {
    return Object.freeze({
      status: "not-requested",
      observedRequests: 0,
      overruns: Object.freeze([]),
    });
  }
  if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) {
    throw new TypeError("requestedMaxTokens must be a positive integer or undefined");
  }

  const observed = [];
  for (const sample of samples ?? []) {
    const outputTokens = outputTokensOf(sample?.usage);
    if (outputTokens === undefined) continue;
    observed.push(Object.freeze({
      ...(sample.turn === undefined ? {} : { turn: sample.turn }),
      ...(sample.step === undefined ? {} : { step: sample.step }),
      outputTokens,
    }));
  }
  if (observed.length === 0) {
    return Object.freeze({
      status: "unobserved",
      requestedMaxTokens,
      observedRequests: 0,
      overruns: Object.freeze([]),
    });
  }

  const overruns = observed.filter((sample) => sample.outputTokens > requestedMaxTokens);
  return Object.freeze({
    status: overruns.length === 0 ? "within-requested-ceiling" : "provider-exceeded-requested-ceiling",
    requestedMaxTokens,
    observedRequests: observed.length,
    maxObservedOutputTokens: Math.max(...observed.map((sample) => sample.outputTokens)),
    overruns: Object.freeze(overruns),
  });
}
