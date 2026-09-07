// Command commandlist prints every command the browser build's tree
// registers, one command path per line, in the same form __ptahHost.ready()
// reports: the words a user types after `ptah`.
//
// It lives in ptah-sandbox and is copied into the materialized ptah tree by
// scripts/build-wasm.sh, because the only trustworthy source for the command
// list is the command tree itself. Reading it out of the source with a grep
// would go stale the first time a verb moved.
//
// It walks ptah.run/cmd/internal/browsercmd, not ptah.run/cmd/root: the manifest
// describes what the wasm binary can run, and the browser tree deliberately
// omits the verbs that need a network, a container runtime or a model
// provider. A manifest built from the full root tree advertises 42 commands
// this build does not carry.
package main

import (
	"fmt"
	"os"

	"ptah.run/cmd/internal/browsercmd"
)

func main() {
	for _, path := range browsercmd.CommandPaths(browsercmd.NewRootCommand()) {
		fmt.Fprintln(os.Stdout, path)
	}
}
