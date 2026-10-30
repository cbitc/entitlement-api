-- Runs only when the MySQL data volume is empty (`docker compose down -v`).
-- MYSQL_USER only receives privileges on MYSQL_DATABASE, so the e2e schema
-- used by `pnpm db:test:deploy` has to be created and granted here.
CREATE DATABASE IF NOT EXISTS `entitlement_test`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON `entitlement_test`.* TO 'entitlement'@'%';
FLUSH PRIVILEGES;
