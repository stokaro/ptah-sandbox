#!/bin/sh
# Regenerates test/integration/expected/*.txt by running the NATIVE ptah binary
# through the same scenario the browser harness drives, on the same fixture.
#
# The transcripts in test/integration/ground-truth were captured against a different
# schema (see test/integration/ground-truth/capture.sh), so they pin the wording but not
# the DDL for fixtures/scenario-a. These files close that gap: same fixture,
# same argv, same order, native SQLite on a real file. run.mjs diffs the
# browser transcripts against them byte for byte.
#
#   test/integration/capture-native.sh
#
# Needs a Go toolchain and the sqlite3 CLI (only to seed app.db and to read the
# rows back; ptah itself never shells out to it).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
FIX="$ROOT/fixtures/scenario-a"
OUT="$ROOT/test/integration/expected"
SRC="$ROOT/build/ptah-src"

if [ ! -d "$SRC" ]; then
	echo "capture-native.sh: $SRC is missing; run scripts/build-wasm.sh first" >&2
	exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PTAH="$WORK/ptah"
(cd "$SRC" && GOWORK=off go build -o "$PTAH" ./cmd/ptah)

mkdir -p "$OUT"
cd "$WORK"
cp "$FIX/schema.sql" "$FIX/README.md" .
sqlite3 app.db <"$FIX/seed.sql"

# run <name> <argv...> -- stdin comes from $STDIN_TEXT, empty meaning /dev/null.
run() {
	name=$1
	shift
	# `set -e` would abort on the runs whose whole point is a nonzero exit.
	code=0
	if [ -n "${STDIN_TEXT:-}" ]; then
		printf '%s' "$STDIN_TEXT" | "$PTAH" "$@" >.o 2>.e || code=$?
	else
		"$PTAH" "$@" >.o 2>.e </dev/null || code=$?
	fi
	{
		echo "--- exit: $code"
		echo "--- stdout ---"
		cat .o
		echo "--- stderr ---"
		cat .e
	} >"$OUT/$name.txt"
	STDIN_TEXT=""
	echo "wrote expected/$name.txt  exit=$code"
}

run a_drift_clean schema drift --schema-file schema.sql --db-url sqlite://app.db

# Step b: the edit the README tells the user to make.
python3 - <<'PY'
path = "schema.sql"
text = open(path).read()
text = text.replace(
    "  email TEXT NOT NULL\n);",
    "  email TEXT NOT NULL,\n  active INTEGER NOT NULL DEFAULT 1\n);",
)
text += "\nCREATE INDEX idx_users_email ON users (email);\n"
open(path, "w").write(text)
PY

run c_apply_dryrun schema apply --schema-file schema.sql --db-url sqlite://app.db --dry-run
STDIN_TEXT='YES
' run d_apply_yes schema apply --schema-file schema.sql --db-url sqlite://app.db

sqlite3 app.db 'SELECT id, name, active FROM users ORDER BY id;' >"$OUT/e_rows.txt"
echo "wrote expected/e_rows.txt"

run f_drift_clean_again schema drift --schema-file schema.sql --db-url sqlite://app.db

sqlite3 app.db 'ALTER TABLE users ADD COLUMN nickname TEXT;'
run g_drift_detected schema drift --schema-file schema.sql --db-url sqlite://app.db

# The confirmation paths, on the rebuild plan the stray column now forces.
run h_apply_eof schema apply --schema-file schema.sql --db-url sqlite://app.db
STDIN_TEXT='no
' run i_apply_no schema apply --schema-file schema.sql --db-url sqlite://app.db
