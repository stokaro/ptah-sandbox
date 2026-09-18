#!/bin/sh
# Smoke-test a deployed playground over the network.
#
# This runs against the real origin after a deploy, because the two things it
# measures cannot be measured anywhere else:
#
#   1. Whether the CDN in front of GitHub Pages compresses a 125 MB asset.
#      Nobody has tested Pages with a file this size. If it does, a cold visit
#      transfers ~23 MB; if it does not, it transfers ~125 MB, the load takes
#      five times as long as the design assumes, and the 100 GB/month Pages
#      bandwidth allowance is gone in a few hundred visits. The script reports
#      the measured number either way, and warns loudly on the bad one.
#
#   2. Whether the bytes a visitor receives are the bytes that were built. The
#      body is hashed and compared against the sha256 in the manifest the same
#      origin served, so artifact packing, CDN rewriting or a truncated upload
#      show up here rather than as a WebAssembly compile error in a stranger's
#      browser.
#
# Usage:
#   web/scripts/smoke.sh https://play.ptah.run/ [expected-ptah-commit]
#
# Exit status is 1 for a broken deploy. A missing content-encoding is a
# warning, not a failure: the site works, it is just expensive.
set -eu

base=${1:-https://play.ptah.run/}
expect_commit=${2:-}
case "$base" in
*/) ;;
*) base="$base/" ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
warnings=0

note() {
	printf '%s\n' "$*"
}

problem() {
	failures=$((failures + 1))
	printf 'smoke: FAIL %s\n' "$*" >&2
	if [ -n "${GITHUB_ACTIONS-}" ]; then
		printf '::error::%s\n' "$*"
	fi
}

warn() {
	warnings=$((warnings + 1))
	printf 'smoke: WARN %s\n' "$*" >&2
	if [ -n "${GITHUB_ACTIONS-}" ]; then
		printf '::warning::%s\n' "$*"
	fi
}

summary() {
	if [ -n "${GITHUB_STEP_SUMMARY-}" ]; then
		printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
	fi
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

mib() {
	awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'
}

# header NAME FILE -- the last value of a header, lowercased, CR stripped.
# The last one, because -L leaves one header block per hop in the file.
header() {
	tr -d '\r' <"$2" | awk -v want="$1" '
		index(tolower($0), want ":") == 1 {
			sub(/^[^:]*:[ \t]*/, "")
			value = $0
		}
		END { print tolower(value) }'
}

# get URL OUTFILE [HEADERFILE] -- prints the status code, never fails the shell.
get() {
	_url=$1
	_out=$2
	_hdr=${3:-/dev/null}
	_code=$(curl -sS -o "$_out" -D "$_hdr" -w '%{http_code}' --max-time 60 "$_url" || true)
	[ -n "$_code" ] || _code=000
	printf '%s' "$_code"
}

# ---------------------------------------------------------------------------
# 1. The root answers. A first deployment plus a first DNS answer can take a
#    minute to become visible, so this one is retried; nothing else is.
# ---------------------------------------------------------------------------

note "smoke: $base"
code=000
attempt=1
attempts=12
while [ "$attempt" -le "$attempts" ]; do
	code=$(get "$base" "$work/index.html")
	[ "$code" = "200" ] && break
	if [ "$attempt" -lt "$attempts" ]; then
		note "smoke: attempt $attempt/$attempts: HTTP $code, retrying in 15s"
		sleep 15
	fi
	attempt=$((attempt + 1))
done

if [ "$code" = "200" ]; then
	note "smoke: OK  GET / -> 200, $(wc -c <"$work/index.html" | tr -d ' ') bytes"
	# A 200 on the wrong document is the failure a status check cannot see:
	# a Pages placeholder, or the parent site, answers 200 just as happily.
	if ! grep -qi 'ptah' "$work/index.html"; then
		problem "the document at $base does not mention Ptah; something else is being served"
	fi
else
	problem "GET $base returned $code after $attempts attempts"
fi

# ---------------------------------------------------------------------------
# 2. An unknown address gets our 404 page, not a Pages default.
# ---------------------------------------------------------------------------

miss="${base}this-address-does-not-exist-$(date +%s)/"
code=$(get "$miss" "$work/404.html")
if [ "$code" = "404" ]; then
	if grep -q 'HTTP 404' "$work/404.html"; then
		note "smoke: OK  unknown address -> 404, served by web/404.html"
	else
		warn "an unknown address returns 404 but not the site's own 404 page"
	fi
else
	problem "an unknown address returned $code, expected 404"
fi

# ---------------------------------------------------------------------------
# 3. The manifest. Everything below is measured against the numbers this file
#    publishes, because that is what the page itself quotes to the visitor.
# ---------------------------------------------------------------------------

manifest_url="${base}vendor/ptah/manifest.json"
code=$(get "$manifest_url" "$work/manifest.json")
if [ "$code" != "200" ]; then
	problem "GET $manifest_url returned $code; the page cannot state what it is running"
	printf 'smoke: %s failure(s), %s warning(s)\n' "$failures" "$warnings" >&2
	exit 1
fi

if command -v jq >/dev/null 2>&1; then
	json() { jq -r "$1" <"$work/manifest.json"; }
elif command -v node >/dev/null 2>&1; then
	json() {
		node -e '
			const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
			let v = j;
			for (const k of process.argv[2].split(".")) v = v[k];
			console.log(v);
		' "$work/manifest.json" "$1"
	}
else
	echo "smoke: neither jq nor node is available to read the manifest" >&2
	exit 2
fi

served_commit=$(json '.ptahCommit')
served_version=$(json '.ptahVersion')
wasm_sha=$(json '.wasm.sha256')
wasm_bytes=$(json '.wasm.bytes')
wasm_gzip=$(json '.wasm.gzipBytes')

note "smoke: OK  manifest: $served_version ($(printf '%s' "$served_commit" | cut -c1-12))"

# The deploy passes the pin it built from. If the origin serves a different
# one, what went out is not this commit's build.
if [ -n "$expect_commit" ] && [ "$served_commit" != "$expect_commit" ]; then
	problem "the origin serves ptahCommit $served_commit, this run deployed $expect_commit"
fi

# ---------------------------------------------------------------------------
# 4. ptah.wasm: status, type, transfer size, and the bytes themselves.
#
#    Accept-Encoding is set by hand rather than with --compressed, because
#    --compressed makes curl decompress and then report the decoded size. Set
#    as a plain header, curl writes the wire bytes to the file and
#    %{size_download} is what a visitor's connection actually carries.
# ---------------------------------------------------------------------------

wasm_url="${base}vendor/ptah/ptah.wasm"
note "smoke: downloading $wasm_url -- measuring the wire size is the point of this test"
measured=$(
	curl -sS -L --max-time 900 \
		-H 'Accept-Encoding: gzip' \
		-D "$work/wasm.head" \
		-o "$work/ptah.wasm.body" \
		-w '%{http_code} %{size_download} %{time_total}' \
		"$wasm_url" || true
)

# Splitting the three fields curl wrote is the point.
# shellcheck disable=SC2086
set -- $measured
wasm_code=${1:-000}
wire=${2:-0}
seconds=${3:-0}

if [ "$wasm_code" != "200" ]; then
	problem "GET $wasm_url returned $wasm_code"
else
	ctype=$(header content-type "$work/wasm.head")
	cenc=$(header content-encoding "$work/wasm.head")

	# The runtime hands compileStreaming its own Response with an explicit
	# content-type, so a wrong one here does not break the page. It is still
	# wrong: it is what every other WebAssembly consumer keys off, and on some
	# CDNs it is what decides whether the asset is compressed at all.
	case "$ctype" in
	application/wasm*) note "smoke: OK  content-type: $ctype" ;;
	"") problem "$wasm_url is served with no content-type; expected application/wasm" ;;
	*) problem "$wasm_url is served as '$ctype', expected application/wasm" ;;
	esac

	# The bytes a visitor receives must be the bytes that were built.
	if [ "$cenc" = "gzip" ]; then
		gzip -dc <"$work/ptah.wasm.body" >"$work/ptah.wasm" 2>/dev/null ||
			problem "the gzip body did not decompress"
	else
		mv "$work/ptah.wasm.body" "$work/ptah.wasm"
	fi

	if [ -s "$work/ptah.wasm" ]; then
		got_sha=$(sha256_of "$work/ptah.wasm")
		got_bytes=$(wc -c <"$work/ptah.wasm" | tr -d ' ')
		if [ "$got_sha" = "$wasm_sha" ]; then
			note "smoke: OK  sha256 of the served binary matches the manifest"
		else
			problem "the served ptah.wasm hashes to $got_sha, the manifest says $wasm_sha"
		fi
		if [ "$got_bytes" != "$wasm_bytes" ]; then
			problem "the served ptah.wasm is $got_bytes bytes decoded, the manifest says $wasm_bytes"
		fi
	else
		problem "the served ptah.wasm body is empty"
	fi

	# ---- the number nobody has measured before ----
	ratio=$(awk -v w="$wire" -v r="$wasm_bytes" 'BEGIN { if (r > 0) printf "%.1f", w * 100 / r; else print "0" }')
	visits=$(awk -v w="$wire" 'BEGIN { if (w > 0) printf "%d", 100 * 1073741824 / w; else print 0 }')

	note "smoke: transfer  wire $(mib "$wire") MiB, decoded $(mib "$wasm_bytes") MiB, ${ratio}% of raw, ${seconds}s"
	note "smoke: expected  $(mib "$wasm_gzip") MiB if the CDN applies gzip -9"

	summary "### play.ptah.run -- ptah.wasm transfer"
	summary ""
	summary "| | bytes | MiB |"
	summary "|---|---:|---:|"
	summary "| on the wire | $wire | $(mib "$wire") |"
	summary "| decoded | $wasm_bytes | $(mib "$wasm_bytes") |"
	summary "| gzip -9 at build time | $wasm_gzip | $(mib "$wasm_gzip") |"
	summary ""
	summary "\`content-encoding: ${cenc:-none}\` &middot; \`content-type: ${ctype:-none}\` &middot; ${seconds}s from the runner"
	summary ""
	summary "At $(mib "$wire") MiB per cold visit, the 100 GB/month GitHub Pages allowance covers about **$visits cold visits**."

	case "$cenc" in
	gzip | br | zstd)
		note "smoke: OK  content-encoding: $cenc, the transfer is ${ratio}% of the raw size"
		summary ""
		summary "Compression is applied. The transfer budget holds."
		;;
	*)
		warn "ptah.wasm is served UNCOMPRESSED: content-encoding is '${cenc:-none}', $wire bytes ($(mib "$wire") MiB) on the wire against $wasm_gzip bytes ($(mib "$wasm_gzip") MiB) for gzip -9. That is ${ratio}% of the raw size instead of about 18 percent, roughly 5.5x the intended transfer, and it puts the 100 GB/month Pages allowance at about $visits cold visits. Serving the binary from a CDN that compresses it, or shipping a pre-compressed copy, is the fix."
		summary ""
		summary "**Compression is NOT applied.** The transfer is ${ratio}% of the raw size instead of about 18 percent. This is the budget the design assumed; see the deployment notes in the README."
		;;
	esac
fi

# ---------------------------------------------------------------------------
# 5. SQLite. Small, but the same content-type question, and it is on the
#    critical path for the first command.
# ---------------------------------------------------------------------------

sqlite_url="${base}vendor/sqlite/sqlite3.wasm"
code=$(get "$sqlite_url" /dev/null "$work/sqlite.head")
if [ "$code" = "200" ]; then
	sqtype=$(header content-type "$work/sqlite.head")
	case "$sqtype" in
	application/wasm*) note "smoke: OK  sqlite3.wasm content-type: $sqtype" ;;
	*) warn "sqlite3.wasm is served as '${sqtype:-none}', expected application/wasm" ;;
	esac
else
	problem "GET $sqlite_url returned $code"
fi

# ---------------------------------------------------------------------------

printf 'smoke: %s failure(s), %s warning(s)\n' "$failures" "$warnings" >&2
[ "$failures" -eq 0 ] || exit 1
