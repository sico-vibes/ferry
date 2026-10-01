UPDATE delegations
SET data_json = json_set(
  data_json,
  '$.events',
  json(COALESCE((
    SELECT json_group_array(json_object(
      'id', 'legacy-' || CAST(progress.key AS TEXT),
      'type', 'text',
      'content', json_extract(progress.value, '$.text'),
      'timestamp', json_extract(progress.value, '$.at')
    ))
    FROM json_each(data_json, '$.progress') AS progress
  ), '[]'))
)
WHERE json_type(data_json, '$.events') IS NULL;

UPDATE sessions
SET data_json = json_set(data_json, '$.agentEvents', json('[]'))
WHERE json_type(data_json, '$.agentEvents') IS NULL;
