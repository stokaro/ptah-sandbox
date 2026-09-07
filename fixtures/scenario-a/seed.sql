-- Builds app.db for the playground. Synthetic data only.
PRAGMA foreign_keys = ON;

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

INSERT INTO users (id, name, email) VALUES
  (1, 'Ada',   'ada@example.com'),
  (2, 'Grace', 'grace@example.com'),
  (3, 'Alan',  'alan@example.com');

INSERT INTO tasks (id, user_id, title, done) VALUES
  (1, 1, 'Draft the analytical engine notes', 1),
  (2, 1, 'Review the note G example',         0),
  (3, 2, 'Write the compiler proposal',       0),
  (4, 3, 'Prepare the Bombe report',          1);
