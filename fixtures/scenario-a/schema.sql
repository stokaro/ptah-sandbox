-- The schema you want the database to have.
--
-- Ptah reads this file as the desired state, reads the real catalog out of
-- app.db, and works out the difference. You never write ALTER statements here.

CREATE TABLE users (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE tasks (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title   TEXT NOT NULL,
  done    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
