CREATE TABLE IF NOT EXISTS flight_plans (
  id          INT            NOT NULL AUTO_INCREMENT,
  owner       VARCHAR(64)    NOT NULL DEFAULT 'default',
  name        VARCHAR(120)   NOT NULL,
  updated_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                             ON UPDATE CURRENT_TIMESTAMP,
  plan_json   LONGTEXT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY  uniq_owner_name (owner, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
