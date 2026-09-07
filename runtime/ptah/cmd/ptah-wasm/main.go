//go:build js

// Command ptah-wasm is the Ptah CLI compiled for a browser.
//
// It is the real command tree, not a reimplementation: the same cobra
// commands, the same flag parsing, the same exit-code contract. What differs
// is everything around the command -- there is no process to exit, no terminal
// to write to, and no operating system underneath -- so this package supplies
// the four things a process would have given it.
//
//   - A host boundary. JavaScript installs globalThis.__ptahHost before the Go
//     program starts; Go installs globalThis.__ptah once it is running. See
//     host.go and runner.go.
//   - A command tree limited to the verbs that can work with no network and no
//     model provider. See commands.go.
//   - A SQLite driver backed by the SQLite build compiled to WebAssembly
//     beside this one. See sqlite.go.
//   - An environment: a working directory, a temporary directory and a home,
//     all inside the in-memory filesystem the host installed as globalThis.fs.
//
// The program never exits. main installs the boundary and then blocks forever,
// because a js/wasm instance whose main returns is torn down, taking the
// command tree with it.
package main

import (
	"fmt"
	"log"
	"os"
)

// The directories the browser filesystem shim is expected to provide. They are
// created here rather than assumed, so that a host which installed an empty
// filesystem still gets a working program.
const (
	workspaceDir = "/workspace"
	temporaryDir = "/tmp"
	homeDir      = "/home/play"
)

func main() {
	host, err := connectHost()
	if err != nil {
		// Nothing to report the failure through: the host boundary is the
		// failure. fd 2 is the only channel left, and returning from main ends
		// the instance without ever calling ready(), which is what tells the
		// host that initialization failed.
		fmt.Fprintf(os.Stderr, "ptah-wasm: %v\n", err)
		return
	}

	if err := prepareEnvironment(); err != nil {
		host.reportPanic(fmt.Sprintf("ptah-wasm: %v", err))
		return
	}

	installSQLite()

	runner := newRunner(host)

	// slog.Default() writes through the log package, and Ptah's library code
	// logs through it (see cmd/internal/cliobs/cliobs.go:51-83). On a native
	// build those records land on the process stderr, interleaved with the
	// command's own diagnostics. Pointing the log package at the running
	// command's stderr reproduces that; leaving it alone would send them to
	// fd 2, where they are out of band and out of order.
	log.SetOutput(runner.logSink())

	runner.install()
	host.ready(readyInfo())

	// A js/wasm main that returns ends the instance. Everything from here on
	// happens in the goroutines the JavaScript callbacks start.
	select {}
}

// prepareEnvironment gives the command tree the directories and environment
// variables a process would have been started with.
//
// Set here rather than in wasm_exec.js's go.env because both work and only one
// of them is checkable: os.Setenv writes the same table os.Getenv, os.TempDir
// and os.UserHomeDir read on this platform, so a value set here is the value
// every consumer sees. A host is still free to pass go.env -- these
// assignments are the floor, not an override of anything meaningful, and the
// working directory in particular has to be set from Go because the JavaScript
// side has no way to know it must exist first.
func prepareEnvironment() error {
	environment := []struct{ name, value string }{
		{"TMPDIR", temporaryDir},
		{"HOME", homeDir},
		{"PWD", workspaceDir},
	}
	for _, variable := range environment {
		if err := os.Setenv(variable.name, variable.value); err != nil {
			return fmt.Errorf("set %s: %w", variable.name, err)
		}
	}
	for _, dir := range []string{temporaryDir, homeDir, workspaceDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}
	if err := os.Chdir(workspaceDir); err != nil {
		return fmt.Errorf("change directory to %s: %w", workspaceDir, err)
	}
	return nil
}
