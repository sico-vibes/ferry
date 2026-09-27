import type { ModelInfo } from '@ferry/shared';

export function ModelQualityBadge({ model }: { model: ModelInfo }) {
  const quality = model.quality ?? null;
  const filledStars = quality === null ? 0 : Math.round(quality * 4);
  const stars = quality === null ? 'n/a' : '★'.repeat(filledStars) + '☆'.repeat(4 - filledStars);
  const tools =
    (model.capability?.toolCall ?? model.toolCalling) ||
    model.capability?.toolProtocol === 'xml' ||
    model.capability?.toolProtocol === 'react';
  const sources = model.qualitySources?.join(', ') ?? 'No benchmark match';
  const date = model.qualityDate ? ` · ${model.qualityDate}` : '';
  const confidence = model.qualityConfidence ?? 0.1;
  const title =
    quality === null
      ? `Coding quality unknown, treated neutrally. Confidence ${String(Math.round(confidence * 100))}%. ${sources}${date}`
      : `Coding quality ${String(Math.round(quality * 100))}% · confidence ${String(Math.round(confidence * 100))}% · ${sources}${date}`;

  return (
    <span
      className="ml-2 inline-flex items-center gap-1 text-meta text-text-2"
      title={`${title} · Tools ${tools ? 'supported' : 'not listed'}`}
    >
      <span>{`coding ${stars}`}</span>
      <span aria-label={tools ? 'Tools supported' : 'Tools not listed'}>
        {tools ? '· tools ✓' : '· tools n/a'}
      </span>
    </span>
  );
}
