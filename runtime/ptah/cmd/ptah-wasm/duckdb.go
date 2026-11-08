//go:build js

package main

import (
	"errors"
	"syscall/js"

	"github.com/stokaro/ptah-duckdb-plugin/browser"
	"github.com/stokaro/ptah/provider-sdk/runtime"
)

// The browser provider's artifact is the exact wasm module containing it.
// The worker gets this digest from the manifest before starting Go.
func installDuckDB() error {
	digest := js.Global().Get("__ptahWasmSHA")
	if digest.Type() != js.TypeString || len(digest.String()) != 64 {
		return errors.New("browser provider has no wasm artifact digest")
	}
	runtime.RegisterBrowserProvider("github.com/stokaro/ptah-duckdb-plugin", "/browser/ptah-duckdb-plugin", digest.String(), browser.Server)
	return nil
}
