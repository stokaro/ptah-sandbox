#!/bin/sh
# Move the playground to another Ptah commit.
#
#   scripts/pin-ptah.sh              # master
#   scripts/pin-ptah.sh v0.7.0
#   scripts/pin-ptah.sh 127aa2477
#
# It resolves the ref against the mirror, records the commit, the version git
# describes it as, and its commit date, and leaves the build to scripts/
# build-wasm.sh. Nothing else in the repository holds a copy of that commit,
# so this file is the whole pin.
set -eu

LC_ALL=C
export LC_ALL

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"

die() {
	echo "pin-ptah: $*" >&2
	exit 1
}

. "$repo/scripts/ptah-git.sh"

ref=${1:-master}
[ $# -le 1 ] || die "usage: pin-ptah.sh [ref]"

mirror_ready
mirror_fetch

# The mirror is bare, so the remote's branches are its own heads: "master", not
# "origin/master". Accept either spelling rather than make the caller remember.
resolved=${ref#origin/}
commit=$(git -C "$PTAH_MIRROR" rev-parse --verify --quiet "$resolved^{commit}") ||
	die "$ref does not name a commit in $PTAH_REMOTE"

# --abbrev is pinned because git sizes the default from the repository's object
# count, so the same commit describes as g4c5825d4a153 in one clone and
# g4c5825d4 in another. Twelve is the width Go pseudo-versions use, and it
# makes the suffix the first twelve of the commit the pin records beside it.
version=$(git -C "$PTAH_MIRROR" describe --tags --always --abbrev=12 "$commit")
date=$(git -C "$PTAH_MIRROR" show -s --format=%cI "$commit")

previous=$(pin_field commit 2>/dev/null || true)

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# Keep the comment header and replace only the three data lines, so the file
# explains itself to the next reader without this script owning its prose.
awk -v commit="$commit" -v version="$version" -v date="$date" '
	$1 == "commit"  { print "commit " commit;   next }
	$1 == "version" { print "version " version; next }
	$1 == "date"    { print "date " date;       next }
	{ print }
' "$PTAH_PIN" >"$tmp"
cat "$tmp" >"$PTAH_PIN"

if [ "$previous" = "$commit" ]; then
	echo "pin-ptah: already at $version ($commit)"
else
	echo "pin-ptah: $version ($commit)"
	echo "pin-ptah: run 'make wasm' and commit $PTAH_PIN with web/vendor/ptah/manifest.json"
fi
