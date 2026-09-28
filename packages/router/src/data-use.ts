export function mayUsePromptsForTraining(
  dataUse: string | null | undefined,
  structuredTrainingUse?: boolean | null,
): boolean {
  if (structuredTrainingUse !== null && structuredTrainingUse !== undefined)
    return structuredTrainingUse;
  if (!dataUse) return false;
  const clauses = dataUse
    .toLowerCase()
    .replaceAll('’', "'")
    .split(/[.!?;]|\bbut\b|\bhowever\b|\balthough\b/);
  const negations = [
    /\b(?:not|never|no|without|don't|do not|doesn't|does not|won't|will not|cannot|can't)\b.{0,50}\b(?:use|used|using|train(?:ing)?|improv(?:e|ement|ing))\b/,
    /\b(?:train(?:ing)?|improv(?:e|ement|ing))\b.{0,35}\b(?:not|never|no|isn't|aren't|won't|will not)\b/,
    /\bzero\s+data\s+retention\b/,
  ];
  return clauses.some(
    (clause) =>
      /\b(?:train(?:ing)?|improv(?:e|ement|ing))\b/.test(clause) &&
      !negations.some((pattern) => pattern.test(clause)),
  );
}
