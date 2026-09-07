//go:build !js

// This file exists so that the package compiles on every platform, not only
// the one it is for. Every other file here is js-only, and a package whose
// files are all excluded by build constraints is an error the moment anything
// names it directly -- `go build ./cmd/ptah-wasm`, `go vet` on the package,
// gopls opening a file in it. See runtime/ptah/README.md.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "ptah-wasm: this command exists only for js/wasm; build it with GOOS=js GOARCH=wasm")
	os.Exit(2) //revive:disable-line:deep-exit a stub main owns its own exit
}
