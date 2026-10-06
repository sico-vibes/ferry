-- Ferry cloud mode: delete ferry.logs rows older than 30 days, daily at 03:23 UTC.
-- Adds one new pg_cron job; existing jobs (pipeline-tick, reddit-discover-daily, pipeline-watchdog) are untouched.
select cron.schedule(
  'ferry-log-retention',
  '23 3 * * *',
  $$delete from ferry.logs where ts < now() - interval '30 days'$$
);
