# shellcheck shell=sh
# repo and die() come from build-wasm.sh.
DUCKDB_REMOTE=${DUCKDB_REMOTE:-https://github.com/stokaro/ptah-duckdb-plugin.git}
DUCKDB_MIRROR=build/duckdb-git
DUCKDB_PIN=third_party/duckdb.pin

duckdb_field() {
	value=$(awk -v key="$1" '$1 == key { $1 = ""; sub(/^ /, ""); print; exit }' "$repo/$DUCKDB_PIN")
	[ -n "$value" ] || die "$DUCKDB_PIN has no $1 line"
	printf '%s' "$value"
}

duckdb_materialize() {
	duckdb_tag=$(duckdb_field tag)
	duckdb_commit=$(duckdb_field commit)
	if [ ! -d "$DUCKDB_MIRROR" ]; then
		git clone --quiet --filter=blob:none --no-checkout --branch "$duckdb_tag" --depth 1 \
			"$DUCKDB_REMOTE" "$DUCKDB_MIRROR" || die "could not clone $DUCKDB_REMOTE at $duckdb_tag"
	fi
	git -C "$DUCKDB_MIRROR" remote set-url origin "$DUCKDB_REMOTE"
	actual=$(git -C "$DUCKDB_MIRROR" rev-parse "$duckdb_tag^{commit}" 2>/dev/null || true)
	if [ "$actual" != "$duckdb_commit" ]; then
		git -C "$DUCKDB_MIRROR" fetch --quiet --force origin "refs/tags/$duckdb_tag:refs/tags/$duckdb_tag" ||
			die "could not fetch $duckdb_tag from $DUCKDB_REMOTE"
		actual=$(git -C "$DUCKDB_MIRROR" rev-parse "$duckdb_tag^{commit}" 2>/dev/null || true)
	fi
	[ "$actual" = "$duckdb_commit" ] || die "$duckdb_tag resolves to $actual, expected $duckdb_commit"
	rm -rf build/duckdb-src
	mkdir -p build/duckdb-src
	git -C "$DUCKDB_MIRROR" archive --format=tar "$duckdb_commit" | tar -x -C build/duckdb-src
	git apply --directory=build/duckdb-src --whitespace=error -p1 "$repo/duckdb-patch/0001-browser.patch" ||
		die "could not apply DuckDB browser overlay"
	tar -cf - -C runtime/duckdb-plugin . | tar -xf - -C build/duckdb-src
	echo "build-wasm: materialized DuckDB plugin $duckdb_tag@$duckdb_commit"
}
