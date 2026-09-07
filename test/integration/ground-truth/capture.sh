#!/bin/bash
# Regenerates every transcript in this directory from a locally built ptah.
#
#   cd /Users/buster/Work/denis/ptah && go build -o /tmp/ptah ./cmd/ptah
#   PTAH_BIN=/tmp/ptah test/integration/ground-truth/capture.sh
#
# Pinned against ptah commit 112a72244a81db149899df0ce43afc704a152bc4.
# Requires: sqlite3 (only to seed rows; ptah itself never needs it).
set -u
PTAH_BIN=${PTAH_BIN:-ptah}
OUT=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
STEP=0
NAME=""

run() {  # run <argv...>   -- stdin comes from $STDIN_TEXT (empty => /dev/null)
  STEP=$((STEP+1))
  local f; f="$OUT/$(printf '%02d' $STEP)_${NAME}.txt"
  {
    echo "\$ ptah $*"
    [ -n "${STDIN_TEXT:-}" ] && printf '# stdin bytes: %q\n' "$STDIN_TEXT"
  } > "$f"
  if [ -n "${STDIN_TEXT:-}" ]; then
    printf '%s' "$STDIN_TEXT" | "$PTAH_BIN" "$@" >"$WORK/.o" 2>"$WORK/.e"
  else
    "$PTAH_BIN" "$@" >"$WORK/.o" 2>"$WORK/.e" </dev/null
  fi
  local code=$?
  {
    echo "--- exit: $code"
    echo "--- stdout ---"
    cat "$WORK/.o"
    echo "--- stderr ---"
    cat "$WORK/.e"
  } >> "$f"
  STDIN_TEXT=""
  echo "wrote $(basename "$f")  exit=$code"
}

############ scenario A: ptah schema apply / drift on a real sqlite file ############
A="$WORK/a"; mkdir -p "$A"; cd "$A" || exit 1

cat > schema.sql <<'EOF'
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
);

CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id),
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
);
EOF

cat > schema_v2.sql <<'EOF'
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id),
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_users_email ON users (email);
EOF

NAME=apply_v1_dryrun;      run schema apply --schema-file schema.sql --db-url sqlite://app.db --dry-run
NAME=apply_v1_stdin_eof;   run schema apply --schema-file schema.sql --db-url sqlite://app.db
NAME=apply_v1_stdin_no;    STDIN_TEXT=$'no\n'  run schema apply --schema-file schema.sql --db-url sqlite://app.db
STDIN_TEXT=$'no\n';  NAME=apply_v1_stdin_no2;  run schema apply --schema-file schema.sql --db-url sqlite://app.db
STDIN_TEXT=$'YES\n'; NAME=apply_v1_stdin_yes;  run schema apply --schema-file schema.sql --db-url sqlite://app.db

sqlite3 app.db <<'EOF'
INSERT INTO users (email, name) VALUES
  ('ada@example.com','Ada Lovelace'),
  ('alan@example.com','Alan Turing'),
  ('grace@example.com','Grace Hopper');
INSERT INTO tasks (user_id, title, done) VALUES
  (1,'Write the Analytical Engine notes',1),
  (1,'Review Note G',0),
  (2,'Design the Bombe',1),
  (3,'Invent the compiler',0);
EOF

NAME=drift_v1_clean;        run schema drift --schema-file schema.sql    --db-url sqlite://app.db
NAME=drift_v2_detected;     run schema drift --schema-file schema_v2.sql --db-url sqlite://app.db
NAME=drift_v2_json;         run schema drift --schema-file schema_v2.sql --db-url sqlite://app.db --format json
NAME=drift_v2_gha;          run schema drift --schema-file schema_v2.sql --db-url sqlite://app.db --format github-actions
NAME=apply_v2_dryrun;       run schema apply --schema-file schema_v2.sql --db-url sqlite://app.db --dry-run
STDIN_TEXT=$'YES\n'; NAME=apply_v2_stdin_yes; run schema apply --schema-file schema_v2.sql --db-url sqlite://app.db
NAME=drift_v2_after_apply;  run schema drift --schema-file schema_v2.sql --db-url sqlite://app.db
NAME=apply_v2_noop;         run schema apply --schema-file schema_v2.sql --db-url sqlite://app.db --auto-approve
NAME=inspect_after;         run schema inspect --db-url sqlite://app.db --format sql

{ echo "-- sqlite3 app.db 'select id,email,name,active from users'"; sqlite3 app.db 'select id,email,name,active from users;'
  echo "-- sqlite3 app.db 'select id,user_id,title,done from tasks'"; sqlite3 app.db 'select id,user_id,title,done from tasks;'
  echo "-- sqlite3 app.db .schema";  sqlite3 app.db '.schema'; } > "$OUT/A_data_after_apply.txt"

############ scenario B: destructive plan (drop a column) ############
NAME=drift_v3_destructive
cat > schema_v3.sql <<'EOF'
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id),
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_users_email ON users (email);
EOF
run schema drift --schema-file schema_v3.sql --db-url sqlite://app.db
NAME=drift_v3_severity_destructive; run schema drift --schema-file schema_v3.sql --db-url sqlite://app.db --severity destructive
NAME=apply_v3_dryrun_rebuild;       run schema apply --schema-file schema_v3.sql --db-url sqlite://app.db --dry-run

############ scenario C: ptah schema plan -> schema apply --plan ############
C="$WORK/c"; mkdir -p "$C"; cp schema.sql schema_v2.sql "$C"/; cd "$C" || exit 1
NAME=plan_apply_v1;      run schema apply --schema-file schema.sql --db-url sqlite://app.db --auto-approve
NAME=plan_dryrun;        run schema plan --schema-file schema_v2.sql --db-url sqlite://app.db --dry-run --name add_active
NAME=plan_save;          run schema plan --schema-file schema_v2.sql --db-url sqlite://app.db --save    --name add_active
cp add_active.plan.json "$OUT/C_add_active.plan.json"
NAME=plan_apply_dryrun;  run schema apply --db-url sqlite://app.db --plan add_active.plan.json --dry-run
NAME=plan_apply_exec;    run schema apply --db-url sqlite://app.db --plan add_active.plan.json --auto-approve

############ scenario D: migrations workflow ############
D="$WORK/d"; mkdir -p "$D/migrations"; cp "$A/schema.sql" "$A/schema_v2.sql" "$D"/; cd "$D" || exit 1
NAME=mig_plan;              run migrations plan --schema-file schema.sql --db-url sqlite://app.db
NAME=mig_generate_init;     run migrations generate --schema-file schema.sql --db-url sqlite://app.db --migrations-dir migrations --name init
NAME=mig_ls;                run migrations ls --migrations-dir migrations
NAME=mig_validate_no_sum;   run migrations validate --dir migrations
NAME=mig_hash;              run migrations hash --dir migrations
NAME=mig_validate_ok;       run migrations validate --dir migrations
NAME=mig_lint;              run migrations lint --dir migrations --dialect sqlite
NAME=mig_status_pending;    run migrations status --migrations-dir migrations --db-url sqlite://app.db
NAME=mig_status_json;       run migrations status --migrations-dir migrations --db-url sqlite://app.db --json
NAME=mig_up_dryrun;         run migrations up --migrations-dir migrations --db-url sqlite://app.db --dry-run
NAME=mig_up;                run migrations up --migrations-dir migrations --db-url sqlite://app.db
NAME=mig_status_applied;    run migrations status --migrations-dir migrations --db-url sqlite://app.db

sqlite3 app.db "INSERT INTO users (email,name) VALUES ('ada@example.com','Ada Lovelace'),('alan@example.com','Alan Turing'),('grace@example.com','Grace Hopper'); INSERT INTO tasks (user_id,title,done) VALUES (1,'Write the Analytical Engine notes',1),(1,'Review Note G',0),(2,'Design the Bombe',1),(3,'Invent the compiler',0);"
sleep 1

NAME=mig_generate_v2;       run migrations generate --schema-file schema_v2.sql --db-url sqlite://app.db --migrations-dir migrations --name add_active_and_email_index
NAME=mig_validate_drift;    run migrations validate --dir migrations
NAME=mig_up_verify_sum_fail;run migrations up --migrations-dir migrations --db-url sqlite://app.db --verify-sum
NAME=mig_status_exit_code;  run migrations status --migrations-dir migrations --db-url sqlite://app.db --exit-code
NAME=mig_hash_2;            run migrations hash --dir migrations
NAME=mig_up_2;              run migrations up --migrations-dir migrations --db-url sqlite://app.db --verify-sum
NAME=mig_status_final;      run migrations status --migrations-dir migrations --db-url sqlite://app.db
NAME=mig_drift_after;       run schema drift --schema-file schema_v2.sql --db-url sqlite://app.db

{ echo "== migrations directory =="; ls -1 migrations
  for f in migrations/*.sql; do echo; echo "== $f =="; cat "$f"; echo; done
  echo; echo "== migrations/ptah.sum =="; cat migrations/ptah.sum
  echo; echo "== sqlite3 app.db .tables =="; sqlite3 app.db '.tables'
  echo; echo "== schema_migrations =="; sqlite3 -header app.db 'select * from schema_migrations;'
  echo; echo "== users =="; sqlite3 app.db 'select id,email,name,active from users;'; } > "$OUT/D_migrations_dir.txt"

############ scenario E: error paths and exit codes ############
E="$WORK/e"; mkdir -p "$E"; cp "$A/schema_v2.sql" "$E"/; cd "$E" || exit 1
NAME=err_no_source;    run schema apply --db-url sqlite://app.db
NAME=err_no_db_url;    run schema apply --schema-file schema_v2.sql
NAME=err_bad_flag;     run schema apply --schema-file schema_v2.sql --db-url sqlite://app.db --nope
NAME=err_unknown_cmd;  run schema nosuchverb
NAME=err_missing_file; run schema drift --schema-file nope.sql --db-url sqlite://app.db
NAME=err_bad_conn;     run schema drift --schema-file schema_v2.sql --db-url sqlite://no-such-dir/x.db
NAME=version;          run version
NAME=root_help_nontty; run --help

echo
echo "work dir: $WORK"

############ scenario F: streams, log formats, ephemeral schema test ############
F="$WORK/f"; mkdir -p "$F/migrations" "$F/tests"; cp "$A/schema.sql" "$F"/; cd "$F" || exit 1
cat > tests/users.yaml <<'YAML'
cases:
  - name: users table accepts rows
    steps:
      - exec: INSERT INTO users (email, name) VALUES ('ada@example.com', 'Ada Lovelace')
      - assert:
          query: SELECT COUNT(*) FROM users
          scalar: "1"
  - name: email is unique
    steps:
      - exec: INSERT INTO users (email, name) VALUES ('ada@example.com', 'Ada Lovelace')
      - assert:
          query: INSERT INTO users (email, name) VALUES ('ada@example.com', 'Someone Else')
          error_contains: UNIQUE
YAML

STEP=50
NAME=schema_test_ephemeral_sqlite; run schema test --schema-file schema.sql --dir tests
NAME=mig_create;                   run migrations create --migrations-dir migrations --name manual_tweak
"$PTAH_BIN" migrations generate --schema-file schema.sql --db-url sqlite://app.db --migrations-dir migrations --name init >/dev/null 2>&1
"$PTAH_BIN" migrations hash --dir migrations >/dev/null 2>&1
V=$(ls migrations | grep init | head -1 | cut -d_ -f1)
NAME=mig_show;                     run migrations show --migrations-dir migrations --version "$V"
NAME=mig_up_log_json;              run migrations up --migrations-dir migrations --db-url sqlite://j.db --log-format json
NAME=mig_up_log_level_error;       run migrations up --migrations-dir migrations --db-url sqlite://k.db --log-level error
NAME=sql_lint_sqlite;              run sql lint schema.sql --dialect sqlite
NAME=schema_inspect_json;          run schema inspect --db-url sqlite://j.db --format json
NAME=db_capabilities;              run db capabilities --db-url sqlite://j.db
