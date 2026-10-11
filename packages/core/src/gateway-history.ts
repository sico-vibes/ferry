import {
  GatewayHistoryQuerySchema,
  type GatewayHistoryQuery,
  type GatewayHistoryPage,
  type GatewayRequestRecord,
  type GatewayUsageSummary,
  type GatewayUsageGroup,
} from '@ferry/shared';
import type { FerryServices } from './services.js';

export function gatewayHistory(
  services: FerryServices,
  input: GatewayHistoryQuery,
): GatewayHistoryPage {
  const query = GatewayHistoryQuerySchema.parse(input);
  const days = query.range === '24h' ? 1 : query.range === '7d' ? 7 : 30;
  const cutoff = new Date(services.clock.now().getTime() - days * 86_400_000).toISOString();
  const where = `at >= ? AND (? = '' OR instr(lower(json_extract(data_json,'$.keyName') || ' ' || json_extract(data_json,'$.requestedModel') || ' ' || coalesce(json_extract(data_json,'$.modelRef'),'') || ' ' || id), lower(?)) > 0)
    AND (? IS NULL OR json_extract(data_json,'$.keyId') = ?)
    AND (? IS NULL OR json_extract(data_json,'$.status') = ?)`;
  const params = [
    cutoff,
    query.query,
    query.query,
    query.keyId ?? null,
    query.keyId ?? null,
    query.status ?? null,
    query.status ?? null,
  ];
  const { total } = services.db.client
    .prepare(`SELECT count(*) AS total FROM gateway_requests WHERE ${where}`)
    .get(...params) as { total: number };
  const rows = services.db.client
    .prepare(
      `SELECT data_json FROM gateway_requests WHERE ${where} ORDER BY at DESC,id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset) as { data_json: string }[];
  return {
    records: rows.map((row) => JSON.parse(row.data_json) as GatewayRequestRecord),
    total,
    nextOffset: query.offset + rows.length < total ? query.offset + rows.length : null,
  };
}

export function gatewayRequest(services: FerryServices, id: string): GatewayRequestRecord | null {
  const row = services.db.client
    .prepare('SELECT data_json FROM gateway_requests WHERE id=?')
    .get(id) as { data_json: string } | undefined;
  return row ? (JSON.parse(row.data_json) as GatewayRequestRecord) : null;
}

export function gatewayUsageSummary(
  services: FerryServices,
  range: GatewayHistoryQuery['range'],
  groupBy: 'key' | 'provider' | 'model',
): GatewayUsageSummary {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 1;
  const cutoff = new Date(services.clock.now().getTime() - days * 86_400_000).toISOString();
  const field = groupBy === 'key' ? 'keyId' : groupBy === 'provider' ? 'providerId' : 'modelRef';
  if (groupBy !== 'key') {
    const model = "coalesce(json_extract(attempt.value,'$.model'),'Unserved')";
    const name =
      groupBy === 'model'
        ? model
        : `CASE WHEN instr(${model},'/')>0 THEN substr(${model},1,instr(${model},'/')-1) ELSE 'Unserved' END`;
    const rows = services.db.client
      .prepare(
        `SELECT ${name} AS name,count(DISTINCT request.id) AS requests,
      sum(coalesce(json_extract(attempt.value,'$.inputTokens'),0)) AS inputTokens,
      sum(coalesce(json_extract(attempt.value,'$.outputTokens'),0)) AS outputTokens,
      sum(coalesce(json_extract(attempt.value,'$.cachedTokens'),0)) AS cachedTokens,
      sum(CASE WHEN json_extract(attempt.value,'$.estimatedCost')=1 THEN 0 ELSE coalesce(json_extract(attempt.value,'$.costUsd'),0) END) AS actualUsd,
      sum(CASE WHEN json_extract(attempt.value,'$.estimatedCost')=1 THEN coalesce(json_extract(attempt.value,'$.costUsd'),0) ELSE 0 END) AS estimatedUsd,
      sum(CASE WHEN json_extract(attempt.value,'$.costUsd') IS NULL THEN 1 ELSE 0 END) AS unknownCosts
      FROM gateway_requests AS request,json_each(CASE WHEN EXISTS(SELECT 1 FROM json_each(request.data_json,'$.attempts') WHERE json_extract(value,'$.costUsd') IS NOT NULL)
        THEN json_extract(request.data_json,'$.attempts') ELSE json_array(json_object('model',json_extract(request.data_json,'$.modelRef'),'status','served','inputTokens',json_extract(request.data_json,'$.inputTokens'),'outputTokens',json_extract(request.data_json,'$.outputTokens'),'cachedTokens',json_extract(request.data_json,'$.cachedTokens'),'costUsd',json_extract(request.data_json,'$.costUsd'),'estimatedCost',json_extract(request.data_json,'$.estimatedCost'))) END) AS attempt
      WHERE request.at>=? AND json_extract(attempt.value,'$.status') IN ('failed','served') GROUP BY name ORDER BY requests DESC`,
      )
      .all(cutoff) as GatewayUsageGroup[];
    return {
      groups: rows,
      allowanceNote:
        'Costs include every charged attempt, including failed paid fallbacks. Tokens reflect reported usage; interrupted attempts may not report tokens. Subscription and credit balances are unavailable unless the provider reports them in Models → Usage.',
    };
  }
  const rows = services.db.client
    .prepare(
      `SELECT coalesce(json_extract(data_json,'$.${field}'),'Unserved') AS name,
    count(*) AS requests, sum(coalesce(json_extract(data_json,'$.inputTokens'),0)) AS inputTokens,
    sum(coalesce(json_extract(data_json,'$.outputTokens'),0)) AS outputTokens,
    sum(coalesce(json_extract(data_json,'$.cachedTokens'),0)) AS cachedTokens,
    sum(CASE WHEN json_extract(data_json,'$.estimatedCost')=1 THEN 0 ELSE coalesce(json_extract(data_json,'$.costUsd'),0) END) AS actualUsd,
    sum(CASE WHEN json_extract(data_json,'$.estimatedCost')=1 THEN coalesce(json_extract(data_json,'$.costUsd'),0) ELSE 0 END) AS estimatedUsd,
    sum(CASE WHEN json_extract(data_json,'$.costUsd') IS NULL THEN 1 ELSE 0 END) AS unknownCosts
    FROM gateway_requests WHERE at >= ? GROUP BY name ORDER BY requests DESC`,
    )
    .all(cutoff) as GatewayUsageGroup[];
  return {
    groups: rows,
    allowanceNote:
      'Provider subscription and credit balances are not reported by all providers. Check Models → Usage for observed allowances; unknown balances are not estimates.',
  };
}
