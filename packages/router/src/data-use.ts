export function mayUsePromptsForTraining(dataUse: string | null | undefined): boolean {
  if (!dataUse) return false;
  if (
    /not used for training|does not use .* train|no training|not train|zero data retention/i.test(
      dataUse,
    )
  )
    return false;
  return /\b(?:train|training|improve)\b/i.test(dataUse);
}
