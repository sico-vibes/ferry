export type DataUseStatus = 'training' | 'no-training' | 'unknown';

export function dataUseStatus(dataUse: string | null | undefined): DataUseStatus {
  if (!dataUse || /\bunknown\b|subject to .* terms|not specified/i.test(dataUse)) return 'unknown';
  if (
    /not used for training|does not use .* train|no training|not train|zero data retention/i.test(
      dataUse,
    )
  )
    return 'no-training';
  if (/\b(?:train|training|improve)\b/i.test(dataUse)) return 'training';
  return 'unknown';
}

export function DataUseBadge({ dataUse }: { dataUse: string | null | undefined }) {
  const status = dataUseStatus(dataUse);
  const label =
    status === 'training'
      ? 'May train on your prompts'
      : status === 'no-training'
        ? 'No training'
        : 'Unknown';
  const tone =
    status === 'training'
      ? 'bg-warning/10 text-warning'
      : status === 'no-training'
        ? 'bg-success/10 text-success'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-ui-meta ${tone}`}
      title={dataUse ?? label}
    >
      {label}
    </span>
  );
}
