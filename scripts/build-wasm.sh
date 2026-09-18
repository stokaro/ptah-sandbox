#!/bin/sh
# Build web/vendor/ptah/{ptah.wasm,wasm_exec.js,manifest.json} from the commit
# named in third_party/ptah.pin.
#
# The sandbox has no Go module of its own. Everything is built inside a
# materialized copy of ptah at the pinned commit, so a package added here lives
# under ptah.run/... and no new public Ptah API is invented. The copy is
# rebuilt from scratch on every run, and build/ptah-src is never edited by
# hand.
#
# Usage:
#   scripts/build-wasm.sh              build everything
#   scripts/build-wasm.sh --tree-only  materialize build/ptah-src and stop
#   scripts/build-wasm.sh --link       symlink runtime/ptah instead of copying,
#                                      so an editor pointed at build/ptah-src
#                                      edits the real files
set -eu

LC_ALL=C
export LC_ALL

# Deterministic go: never let a developer's go.work or module cache settings
# decide what a release build links.
GOWORK=off
GOFLAGS=
export GOWORK GOFLAGS

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"

srcdir=build/ptah-src
outdir=web/vendor/ptah
runtime=runtime/ptah

tree_only=0
link_runtime=0
for arg in "$@"; do
	case "$arg" in
	--tree-only) tree_only=1 ;;
	--link) link_runtime=1 ;;
	*)
		echo "build-wasm: unknown option: $arg" >&2
		exit 2
		;;
	esac
done

die() {
	echo "build-wasm: $*" >&2
	exit 1
}

sha256() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		die "no sha256 tool found (looked for shasum, sha256sum)"
	fi
}

bytes() {
	wc -c <"$1" | tr -d ' \t'
}

# json_string escapes a value for embedding in the manifest. Only the two
# characters that can appear in a path, a version or a command name are handled;
# anything else would mean the input is not what this script thinks it is.
json_string() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# ---------------------------------------------------------------------------
# 1. The pin. third_party/ptah.pin names the commit, the version git describes
#    it as, and its commit date. All three are checked against git rather than
#    trusted, so an edited line fails the build instead of mislabeling a binary
#    or applying the patch below to something other than what it was written
#    against.
# ---------------------------------------------------------------------------

. "$repo/scripts/ptah-git.sh"

pinned=$(pin_field commit)
ptah_version=$(pin_field version)
ptah_date=$(pin_field date)

case "$pinned" in
*[!0-9a-f]* | "") die "$PTAH_PIN records commit $pinned, which is not a hexadecimal object name" ;;
esac
[ ${#pinned} -eq 40 ] || die "$PTAH_PIN records a $((${#pinned}))-character commit; the full 40 are needed"

mirror_ready
mirror_has "$pinned" || mirror_fetch
mirror_has "$pinned" ||
	die "$PTAH_REMOTE has no commit $pinned; run: scripts/pin-ptah.sh REF"

# --abbrev is pinned because git sizes the default one from the repository's
# object count, so the same commit describes as g4c5825d4a in a full clone and
# g4c5825d4 in a shallower one -- identical sources, different version string,
# and a deploy gate that compares manifests fails on nothing. Twelve is the
# width Go pseudo-versions use, and it makes the suffix the first twelve of
# ptahCommit, which the manifest carries in full beside it.
actual_version=$(git -C "$PTAH_MIRROR" describe --tags --always --abbrev=12 "$pinned")
[ "$actual_version" = "$ptah_version" ] ||
	die "$PTAH_PIN says version $ptah_version but git describes $pinned as $actual_version;
run: scripts/pin-ptah.sh $pinned"

actual_date=$(git -C "$PTAH_MIRROR" show -s --format=%cI "$pinned")
[ "$actual_date" = "$ptah_date" ] ||
	die "$PTAH_PIN says date $ptah_date but $pinned was committed at $actual_date;
run: scripts/pin-ptah.sh $pinned"

# ---------------------------------------------------------------------------
# 2. Materialize. git archive gives a tree with no .git and with mtimes taken
#    from the commit, so two runs of this script produce identical inputs.
# ---------------------------------------------------------------------------

rm -rf "$srcdir"
mkdir -p "$srcdir"
git -C "$PTAH_MIRROR" archive --format=tar "$pinned" | tar -x -C "$srcdir"
echo "build-wasm: materialized ptah@$(echo "$pinned" | cut -c1-12) -> $srcdir"

# An empty upstream-patch/ is the goal state, not an error: every change the
# browser build needs is meant to end up in Ptah itself. See its README.
for patch in upstream-patch/*.patch; do
	[ -e "$patch" ] || break
	# --directory rather than a cd, so the patch paths stay repo-relative and a
	# hunk that tried to escape the overlay would land outside it and fail.
	git apply --directory="$srcdir" --whitespace=error -p1 "$repo/$patch" ||
		die "failed to apply $patch"
	echo "build-wasm: applied $patch"
done

# ---------------------------------------------------------------------------
# 3. Overlay the sandbox's own Go sources at their target paths inside ptah.
# ---------------------------------------------------------------------------

if [ "$link_runtime" = 1 ]; then
	# Symlink each file so an editor opening build/ptah-src edits runtime/ptah.
	# Files only: a symlinked directory would let a stray write land outside
	# the overlay, and Go's loader is happier with real directories.
	(cd "$runtime" && find . -type d) | while read -r dir; do
		mkdir -p "$srcdir/$dir"
	done
	(cd "$runtime" && find . -type f) | while read -r file; do
		ln -sf "$repo/$runtime/${file#./}" "$srcdir/${file#./}"
	done
	echo "build-wasm: linked $runtime into $srcdir"
else
	tar -cf - -C "$runtime" . | tar -xf - -C "$srcdir"
	echo "build-wasm: copied $runtime into $srcdir"
fi

# The command list has to come from the command tree, so the helper is built
# inside the module and removed again; it is not part of what ships.
tooldir="$srcdir/cmd/internal/buildtools/commandlist"
mkdir -p "$tooldir"
cp scripts/commandlist/main.go "$tooldir/main.go"

if [ "$tree_only" = 1 ]; then
	rm -rf "$srcdir/cmd/internal/buildtools"
	cat >go.work <<-EOF
		go $(sed -n 's/^go \([0-9.]*\)$/\1/p' "$srcdir/go.mod" | head -1)

		use ./$srcdir
	EOF
	echo "build-wasm: wrote go.work for $srcdir"
	echo "build-wasm: tree only, stopping before the build"
	exit 0
fi

# ---------------------------------------------------------------------------
# 4. Build. The wasm binary and the JS shim that starts it are one interface
#    and must come from one toolchain, so both are taken from this GOROOT and
#    the shim's digest is recorded next to the binary's.
# ---------------------------------------------------------------------------

# The manifest records the toolchain, and CI re-links to compare, so the two
# hosts have to agree on the compiler. Reading it out of the materialized tree
# ties it to the pin: the compiler would move whenever Ptah's go.mod moves, and
# that rewrites the committed wasm_exec.js, which has to byte-match whatever
# linked the binary. The toolchain is this repository's decision, so
# .go-version declares it once and this script and the workflow both read it.
pinned_go=$(tr -d '[:space:]' <"$repo/.go-version")
go_version=$(go version | awk '{print $3}')
if [ "$go_version" != "go$pinned_go" ]; then
	die "this Go is $go_version; .go-version pins go$pinned_go. Install it or change the pin."
fi
goroot=$(go env GOROOT)
wasm_exec="$goroot/lib/wasm/wasm_exec.js"
[ -f "$wasm_exec" ] || wasm_exec="$goroot/misc/wasm/wasm_exec.js"
[ -f "$wasm_exec" ] || die "wasm_exec.js not found under $goroot"

echo "build-wasm: commands from the ptah command tree"
commands=$(cd "$srcdir" && go run ./cmd/internal/buildtools/commandlist)
rm -rf "$srcdir/cmd/internal/buildtools"

mkdir -p "$outdir"
echo "build-wasm: building ./cmd/ptah-wasm for js/wasm with $go_version"
(
	cd "$srcdir"
	GOOS=js GOARCH=wasm go build \
		-trimpath \
		-ldflags "-s -w \
-X ptah.run/internal/buildinfo.Version=$ptah_version \
-X ptah.run/internal/buildinfo.Commit=$pinned \
-X ptah.run/internal/buildinfo.Date=$ptah_date" \
		-o "$repo/$outdir/ptah.wasm" \
		./cmd/ptah-wasm
)

cp "$wasm_exec" "$outdir/wasm_exec.js"

# ---------------------------------------------------------------------------
# 5. Manifest. Everything a page needs to say what it is running, and
#    everything a bug report needs to say what it ran.
# ---------------------------------------------------------------------------

wasm_sha=$(sha256 "$outdir/ptah.wasm")
wasm_bytes=$(bytes "$outdir/ptah.wasm")
wasm_gzip=$(gzip -9 -c "$outdir/ptah.wasm" | wc -c | tr -d ' \t')
exec_sha=$(sha256 "$outdir/wasm_exec.js")
exec_bytes=$(bytes "$outdir/wasm_exec.js")

# SOURCE_DATE_EPOCH keeps the one non-deterministic field out of the way when a
# caller wants byte-identical output from two runs.
if [ -n "${SOURCE_DATE_EPOCH-}" ]; then
	built_at=$(date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
		date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
else
	built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi

{
	echo '{'
	printf '  "ptahVersion": "%s",\n' "$(json_string "$ptah_version")"
	printf '  "ptahCommit": "%s",\n' "$pinned"
	printf '  "ptahCommitDate": "%s",\n' "$(json_string "$ptah_date")"
	printf '  "goVersion": "%s",\n' "$(json_string "$go_version")"
	printf '  "builtAt": "%s",\n' "$built_at"
	echo '  "wasmExec": {'
	echo '    "file": "wasm_exec.js",'
	printf '    "sha256": "%s",\n' "$exec_sha"
	printf '    "bytes": %s\n' "$exec_bytes"
	echo '  },'
	echo '  "wasm": {'
	echo '    "file": "ptah.wasm",'
	printf '    "sha256": "%s",\n' "$wasm_sha"
	printf '    "bytes": %s,\n' "$wasm_bytes"
	printf '    "gzipBytes": %s\n' "$wasm_gzip"
	echo '  },'
	echo '  "commands": ['
	printf '%s\n' "$commands" | awk '
		{ list[NR] = $0 }
		END {
			for (i = 1; i <= NR; i++) {
				gsub(/\\/, "\\\\", list[i])
				gsub(/"/, "\\\"", list[i])
				printf "    \"%s\"%s\n", list[i], (i < NR ? "," : "")
			}
		}'
	echo '  ]'
	echo '}'
} >"$outdir/manifest.json"

command_count=$(printf '%s\n' "$commands" | wc -l | tr -d ' \t')

echo "build-wasm: ptah.wasm      $wasm_bytes bytes raw, $wasm_gzip bytes gzip -9"
echo "build-wasm: wasm_exec.js   $exec_bytes bytes, sha256 $exec_sha"
echo "build-wasm: ptah           $ptah_version ($(echo "$pinned" | cut -c1-12)), $command_count commands"
echo "build-wasm: wrote $outdir/{ptah.wasm,wasm_exec.js,manifest.json}"
