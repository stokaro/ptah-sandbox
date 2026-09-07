//go:build js

package main

import (
	"errors"
	"fmt"
	"syscall/js"

	"ptah.run/internal/buildinfo"
)

// hostGlobal is the object JavaScript installs before starting Go. Contract B
// requires it to exist by the time main runs; there is no way to install it
// afterwards, because Go has no way to wait for it without blocking the event
// loop that would deliver it.
const hostGlobal = "__ptahHost"

// runtimeGlobal is the object Go installs once it is running.
const runtimeGlobal = "__ptah"

// requiredHostMethods is Contract B's host half. Every one is checked at
// startup rather than at the first call, so a host that forgot one learns
// about it before a command has produced output nobody will see.
var requiredHostMethods = []string{"stdout", "stderr", "done", "ready", "panic"}

// defaultMaxOutputBytes is the transcript budget one run may spend across both
// of its streams.
//
// A browser tab holds the Go linear memory, the SQLite heap, the workspace
// filesystem and the transcript at once, and a command that prints without
// bound -- `ptah schema inspect` over a large database, a migration that logs
// per statement -- is the cheapest way to lose the tab. One mebibyte is the
// per-command transcript limit the playground states; a host that wants a
// different one sets maxOutputBytes on the host object before starting Go.
const defaultMaxOutputBytes = 1 << 20

// host is the JavaScript side of Contract B.
//
// The object is resolved once and held, rather than looked up per call: the
// host installs it before Go starts and replacing it afterwards would swap the
// destination of a run's output halfway through, which no host has a reason to
// do and no reader could make sense of.
type host struct {
	object js.Value

	// maxOutputBytes is the per-run transcript budget. See [budget].
	maxOutputBytes int

	// hasTruncated records whether the host offers the out-of-band truncation
	// signal. See [host.reportTruncated].
	hasTruncated bool
}

// connectHost resolves and validates the host object.
func connectHost() (*host, error) {
	object := js.Global().Get(hostGlobal)
	if object.Type() != js.TypeObject {
		return nil, fmt.Errorf("globalThis.%s is %s, want an object installed before the Go program starts",
			hostGlobal, object.Type())
	}
	var missing []error
	for _, method := range requiredHostMethods {
		if object.Get(method).Type() != js.TypeFunction {
			missing = append(missing, fmt.Errorf("%s.%s is not a function", hostGlobal, method))
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("incomplete host boundary: %w", errors.Join(missing...))
	}

	resolved := &host{
		object:         object,
		maxOutputBytes: defaultMaxOutputBytes,
		hasTruncated:   object.Get("truncated").Type() == js.TypeFunction,
	}
	if limit := object.Get("maxOutputBytes"); limit.Type() == js.TypeNumber && limit.Int() > 0 {
		resolved.maxOutputBytes = limit.Int()
	}
	return resolved, nil
}

// write delivers one chunk of a run's output. The chunk is always whole UTF-8:
// see [hostWriter].
func (h *host) write(runID int, target stream, text string) {
	h.object.Call(string(target), runID, text)
}

// done reports the status the command would have exited the process with.
func (h *host) done(runID, code int) {
	h.object.Call("done", runID, code)
}

// ready announces what this build can do, once, before any run is accepted.
func (h *host) ready(info map[string]any) {
	h.object.Call("ready", info)
}

// reportPanic hands the host a failure that is not a command's exit status.
//
// It swallows a throw from the host itself. This is the last channel a failure
// has, and a host whose panic handler throws would otherwise turn one fault
// into an unrecoverable one inside a deferred recover.
func (h *host) reportPanic(message string) {
	defer func() { _ = recover() }()
	h.object.Call("panic", message)
}

// reportTruncated says that a run's output stopped being complete.
//
// Contract B has no method for this, so the signal is optional: a host that
// defines truncated(runId, limitBytes) gets it out of band, and one that does
// not gets a single line on stderr. Silence is not an option -- a transcript
// that simply stops reads as a command that simply stopped.
func (h *host) reportTruncated(runID int) {
	if h.hasTruncated {
		h.object.Call("truncated", runID, h.maxOutputBytes)
		return
	}
	h.write(runID, streamErr, fmt.Sprintf(
		"\nptah-wasm: output limit of %d bytes reached; the rest of this command's output was dropped\n",
		h.maxOutputBytes))
}

// readyInfo is the capability announcement of Contract B.
//
// The version and commit come from the build stamp of this binary, so the
// playground reports the Ptah that is actually running rather than whatever
// release the site was built beside. The command list is walked from the cobra
// tree for the same reason: a hand-maintained list is a list that is wrong.
func readyInfo() map[string]any {
	info := buildinfo.Resolve()
	commands := commandPaths(newBrowserRootCommand())
	paths := make([]any, len(commands))
	for i, path := range commands {
		paths[i] = path
	}
	return map[string]any{
		"version":   info.Version,
		"commit":    info.Commit,
		"goVersion": info.Go,
		"commands":  paths,
	}
}
