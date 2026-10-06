-- Use wall-clock time so events written in one transaction keep their real order.
alter table ferry.logs alter column ts set default clock_timestamp();
alter table ferry.model_switches alter column created_at set default clock_timestamp();
