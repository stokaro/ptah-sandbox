# Workspace

    schema.sql   the schema you want
    app.db       the SQLite database you have
    README.md    this file

Ptah's job is the gap between the two.

Try it:

    ptah schema drift --schema-file schema.sql --db-url sqlite://app.db

That reads both and tells you whether they agree. Right now they do.

Add a column to `users` in `schema.sql`:

    active INTEGER NOT NULL DEFAULT 1

and an index below the tables:

    CREATE INDEX idx_users_email ON users (email);

Then look before you leap:

    ptah schema apply --schema-file schema.sql --db-url sqlite://app.db --dry-run

Nothing changed — that was a plan. Run it again without `--dry-run` to apply it,
and confirm when asked. Then check the rows are still there in the SQL pane:

    SELECT id, name, active FROM users ORDER BY id;

Everything here runs in this browser tab. Export takes the workspace with you.
