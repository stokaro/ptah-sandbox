# Shared by scripts/build-wasm.sh and scripts/pin-ptah.sh: the pin file and
# the local mirror of the Ptah repository.
#
# The mirror is a blobless bare clone. It carries the whole commit graph and
# every tag, which is what `git describe` needs to produce a version string,
# and it fetches file contents only when `git archive` asks for them. A full
# clone of Ptah is 88 MB; the mirror is 6.5 MB before the first build, and
# about 20 MB after it.

# shellcheck shell=sh
# repo and die() come from the script that sources this one.
# shellcheck disable=SC2154

PTAH_REMOTE=${PTAH_REMOTE:-https://github.com/stokaro/ptah.git}
PTAH_PIN=third_party/ptah.pin
PTAH_MIRROR=${PTAH_MIRROR:-build/ptah-git}

# pin_field reads one field of the pin file. A missing field is an error: the
# file is small enough that a partial one means it was edited by hand.
pin_field() {
	value=$(awk -v key="$1" '$1 == key { $1 = ""; sub(/^ /, ""); print; exit }' "$repo/$PTAH_PIN")
	[ -n "$value" ] || die "$PTAH_PIN has no $1 line"
	printf '%s' "$value"
}

# mirror_ready creates the mirror if it is absent and points it at the remote.
# An existing mirror is reused, so a rebuild costs no network beyond the
# objects it does not already hold.
mirror_ready() {
	if [ ! -d "$repo/$PTAH_MIRROR" ]; then
		mkdir -p "$(dirname "$repo/$PTAH_MIRROR")"
		echo "ptah-git: cloning $PTAH_REMOTE into $PTAH_MIRROR"
		git clone --quiet --filter=blob:none --bare "$PTAH_REMOTE" "$repo/$PTAH_MIRROR" ||
			die "could not clone $PTAH_REMOTE"
	fi
	git -C "$repo/$PTAH_MIRROR" remote set-url origin "$PTAH_REMOTE"
}

# mirror_has reports whether the mirror already holds a commit.
mirror_has() {
	git -C "$repo/$PTAH_MIRROR" cat-file -e "$1^{commit}" 2>/dev/null
}

# mirror_fetch brings the mirror up to date, tags included, so that a pin
# written after the last fetch resolves and describes.
mirror_fetch() {
	git -C "$repo/$PTAH_MIRROR" fetch --quiet --tags --force origin \
		'+refs/heads/*:refs/heads/*' || die "could not fetch from $PTAH_REMOTE"
}
