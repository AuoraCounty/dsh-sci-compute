export function envelope(fields) {
  return {
    status: fields.status,
    op: fields.op ?? null,
    profile: fields.profile ?? null,
    mode: fields.mode ?? null,
    engine: fields.engine ?? null,
    engineVersion: fields.engineVersion ?? null,
    method: fields.method ?? null,
    inputsEcho: fields.inputsEcho ?? null,
    exact: fields.exact ?? null,
    numeric: fields.numeric ?? null,
    lab: fields.lab ?? null,
    resultRef: fields.resultRef ?? null,
    missing: fields.missing ?? [],
    seed: fields.seed ?? null,
  };
}
