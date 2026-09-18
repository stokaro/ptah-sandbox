# upstream-patch

Changes to files that already exist in Ptah go here, as patches, in the shape
they will be proposed in. The directory is empty, which is the goal state.

Both patches that lived here have merged as
[stokaro/ptah#3046](https://github.com/stokaro/ptah/pull/3046): the `js/wasm`
build profile with its shared runner, and the conditional rename
`internal/fsdurable` needs on a platform with no `renameat(2)`.
`third_party/ptah.pin` names a commit that carries them, so
`scripts/build-wasm.sh` applies nothing.

Put a patch back only when the browser needs something that cannot be done
from `runtime/ptah/` — and take it out again when it merges. A patch that
lingers here is a change nobody has proposed upstream yet.
