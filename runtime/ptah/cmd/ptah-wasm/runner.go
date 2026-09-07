//go:build js

package main

import (
	"context"
	"fmt"
	"io"
	"runtime/debug"
	"sync"
	"syscall/js"

	"ptah.run/cmd/root"
)

// runner owns Contract B's Go half: globalThis.__ptah.
//
// One command runs at a time. Not a policy choice -- a js/wasm instance is one
// goroutine scheduler over one linear memory, and two cobra trees writing the
// same in-memory filesystem and the same SQLite handle would race on state
// neither of them knows is shared. A second start while one is running is
// refused through that run's own done, so the host learns about it on the
// channel it is already listening to.
type runner struct {
	host *host

	mu     sync.Mutex
	active *activeRun
}

// activeRun is the state a running command needs from outside its goroutine:
// the host's cancel and pushStdin both address a run by id.
type activeRun struct {
	id     int
	cancel context.CancelFunc
	stdin  *stdinPipe
	stdout *hostWriter
	stderr *hostWriter
}

func newRunner(h *host) *runner {
	return &runner{host: h}
}

// install publishes globalThis.__ptah.
//
// The js.Func values are never released. They are the program's entire
// interface and the program never exits; releasing them would leave the host
// holding functions that throw.
func (r *runner) install() {
	js.Global().Set(runtimeGlobal, js.ValueOf(map[string]any{
		"start":     js.FuncOf(r.jsStart),
		"pushStdin": js.FuncOf(r.jsPushStdin),
		"cancel":    js.FuncOf(r.jsCancel),
	}))
}

// jsStart implements __ptah.start(runId, argv).
//
// It validates and returns. The command itself runs on a goroutine, because a
// js.FuncOf callback that blocks blocks JavaScript's event loop with it, and
// this command is going to block: on stdin at a confirmation prompt, and on
// every synchronous call into the SQLite module.
func (r *runner) jsStart(_ js.Value, args []js.Value) any {
	defer r.recoverCallback("start")

	runID, ok := argInt(args, 0)
	if !ok {
		// Without a usable run id there is no run to report a failure against.
		r.host.reportPanic("ptah-wasm: __ptah.start: the first argument must be a run id number")
		return nil
	}
	argv, err := argStrings(args, 1)
	if err != nil {
		r.refuse(runID, fmt.Sprintf("ptah-wasm: __ptah.start: %v\n", err))
		return nil
	}
	r.start(runID, normalizeArgv(argv))
	return nil
}

// jsPushStdin implements __ptah.pushStdin(runId, data). An empty string is
// end of input, which is what makes the native EOF behavior reachable: `ptah
// schema apply` with no answer fails to read its confirmation and exits 2.
func (r *runner) jsPushStdin(_ js.Value, args []js.Value) any {
	defer r.recoverCallback("pushStdin")

	runID, ok := argInt(args, 0)
	if !ok {
		return nil
	}
	data, ok := argString(args, 1)
	if !ok {
		// Reported rather than ignored: a command blocked on stdin that never
		// receives the answer the host thought it sent looks like a hang, and
		// the cause is invisible from the transcript.
		r.host.reportPanic(fmt.Sprintf(
			"ptah-wasm: %s.pushStdin: the second argument must be a string", runtimeGlobal))
		return nil
	}
	run := r.lookup(runID)
	if run == nil {
		// Input for a run that already finished. Silence is right: the host
		// cannot always know that the command stopped reading.
		return nil
	}
	if data == "" {
		run.stdin.closeWrite()
		return nil
	}
	run.stdin.push(data)
	return nil
}

// jsCancel implements __ptah.cancel(runId).
//
// Cancelation is cooperative and only that. It cancels the command's context,
// which Ptah threads into database calls and long loops, so it takes effect
// wherever Ptah checks -- and nowhere else. It cannot interrupt a synchronous
// call into the SQLite WebAssembly module: that call owns the thread until it
// returns, no Go goroutine runs during it, and the JavaScript event loop that
// would deliver a second message is not running either. A wall-clock deadline
// enforced from inside SQLite's progress handler is what covers that case; a
// watchdog on the main thread that terminates the worker covers the rest.
func (r *runner) jsCancel(_ js.Value, args []js.Value) any {
	defer r.recoverCallback("cancel")

	runID, ok := argInt(args, 0)
	if !ok {
		return nil
	}
	if run := r.lookup(runID); run != nil {
		run.cancel()
	}
	return nil
}

// start accepts a run, or refuses it because one is already in flight.
func (r *runner) start(runID int, argv []string) {
	r.mu.Lock()
	if r.active != nil {
		busy := r.active.id
		r.mu.Unlock()
		r.refuse(runID, fmt.Sprintf(
			"ptah-wasm: run %d is still running; this runtime executes one command at a time\n", busy))
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	limit := &budget{remaining: r.host.maxOutputBytes}
	run := &activeRun{
		id:     runID,
		cancel: cancel,
		stdout: newHostWriter(r.host, runID, streamOut, limit),
		stderr: newHostWriter(r.host, runID, streamErr, limit),
	}
	limit.notify = func() { r.host.reportTruncated(runID) }
	run.stdin = newStdinPipe(ctx, func() {
		// Everything written so far has to be visible before the command waits
		// for an answer to it.
		run.stdout.Flush()
		run.stderr.Flush()
	})
	r.active = run
	r.mu.Unlock()

	r.spawn(func() { r.execute(ctx, run, argv) })
}

// spawn runs fn after the JavaScript call that asked for it has returned.
//
// A bare goroutine is not enough, and the difference is observable. Go's
// js/wasm scheduler runs every runnable goroutine before it hands control back
// to JavaScript, so a command started with `go run()` inside __ptah.start
// executes in full -- output, exit code, done -- before start returns to its
// caller. Measured: with `go`, done(runId) was delivered during start(runId)
// for every command, and a second start issued on the next line was accepted
// because the first run had already ended.
//
// setTimeout is what actually yields: the callback is a fresh macrotask, so
// the host's start() has returned and its own bookkeeping has run before the
// command produces its first byte. The goroutine inside the callback is still
// required, because fn blocks -- on stdin, and on every synchronous call into
// SQLite -- and a js.FuncOf callback that blocks blocks the event loop.
func (r *runner) spawn(fn func()) {
	var callback js.Func
	callback = js.FuncOf(func(js.Value, []js.Value) any {
		callback.Release()
		go func() {
			// The last resort. A panic on a goroutine nobody is recovering
			// takes the whole WebAssembly instance with it, and the host is
			// left with a runtime that answers nothing. Everything reachable
			// from here has its own recover; this one exists for what those
			// miss.
			defer func() {
				if recovered := recover(); recovered != nil {
					r.host.reportPanic(fmt.Sprintf("ptah-wasm: %v\n\n%s", recovered, debug.Stack()))
				}
			}()
			fn()
		}()
		return nil
	})
	js.Global().Call("setTimeout", callback, 0)
}

// refuse reports a start that was never accepted, through the same done the
// host is already waiting on.
//
// Deferred like an accepted run, so that a refusal and a completion reach the
// host the same way: after start has returned.
func (r *runner) refuse(runID int, message string) {
	r.spawn(func() {
		r.host.write(runID, streamErr, message)
		r.host.done(runID, 2)
	})
}

// execute runs one command to completion. It runs on its own goroutine: see
// [runner.jsStart].
func (r *runner) execute(ctx context.Context, run *activeRun, argv []string) {
	code := 2
	defer func() {
		if recovered := recover(); recovered != nil {
			// root.RunContext already recovers panics raised inside cobra
			// execution and turns them into exit code 2. Reaching here means
			// the fault was outside it -- in this package, or in the host
			// boundary -- so it is reported as a fault rather than as a
			// command that failed, and the run is still completed so the host
			// is not left waiting.
			code = 2
			safely(func() { fmt.Fprintf(run.stderr, "ptah-wasm: internal error: %v\n", recovered) })
			r.host.reportPanic(fmt.Sprintf("run %d: %v\n\n%s", run.id, recovered, debug.Stack()))
		}
		// Guarded, because everything below reaches into the host, and a host
		// that throws must not cost the run its completion: a done that never
		// arrives is a UI that waits forever.
		safely(func() {
			run.stdout.Flush()
			run.stderr.Flush()
		})
		run.cancel()

		// Cleared before done, so that a host which starts the next command
		// from inside its done handler is not refused by the run that just
		// ended.
		r.finish(run.id)
		safely(func() { r.host.done(run.id, code) })
	}()

	cmd := newBrowserRootCommand()
	cmd.SetOut(run.stdout)
	cmd.SetErr(run.stderr)
	cmd.SetIn(run.stdin)

	code = root.RunContext(ctx, cmd, argv...)
}

func (r *runner) lookup(runID int) *activeRun {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active == nil || r.active.id != runID {
		return nil
	}
	return r.active
}

func (r *runner) finish(runID int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active != nil && r.active.id == runID {
		r.active = nil
	}
}

// logSink returns the writer the log package -- and through it slog.Default(),
// which Ptah's library code logs warnings through -- should write to.
func (r *runner) logSink() io.Writer {
	return logSink{runner: r}
}

type logSink struct {
	runner *runner
}

func (s logSink) Write(p []byte) (int, error) {
	s.runner.mu.Lock()
	run := s.runner.active
	s.runner.mu.Unlock()
	if run == nil {
		// Nothing is running, so there is no transcript to write to. Reporting
		// a complete write keeps a stray log line from surfacing as an I/O
		// failure inside whatever emitted it.
		return len(p), nil
	}
	return run.stderr.Write(p)
}

// recoverCallback keeps a fault inside a JavaScript callback from taking down
// the WebAssembly instance.
//
// One case is not hypothetical: syscall/js cannot represent a JavaScript
// BigInt, and js.Value.Type() panics outright when handed one. A host that
// passes a BigInt run id gets a reported fault instead of a dead runtime.
func (r *runner) recoverCallback(method string) {
	if recovered := recover(); recovered != nil {
		r.host.reportPanic(fmt.Sprintf("ptah-wasm: %s.%s: %v", runtimeGlobal, method, recovered))
	}
}

// normalizeArgv drops one leading program name.
//
// Contract B calls the array argv, and a host whose transcript reads
// "$ ptah schema apply --dry-run" has every reason to send the words it
// printed. The command tree wants the arguments after the program name. No
// Ptah command is named "ptah", so removing one leading occurrence cannot
// swallow anything a user meant.
func normalizeArgv(argv []string) []string {
	if len(argv) > 0 && argv[0] == "ptah" {
		return argv[1:]
	}
	return argv
}

func argInt(args []js.Value, index int) (int, bool) {
	if index >= len(args) || args[index].Type() != js.TypeNumber {
		return 0, false
	}
	return args[index].Int(), true
}

func argString(args []js.Value, index int) (string, bool) {
	if index >= len(args) || args[index].Type() != js.TypeString {
		return "", false
	}
	return args[index].String(), true
}

func argStrings(args []js.Value, index int) ([]string, error) {
	if index >= len(args) {
		return nil, fmt.Errorf("argument %d is missing", index)
	}
	value := args[index]
	if !js.Global().Get("Array").Call("isArray", value).Bool() {
		return nil, fmt.Errorf("argument %d must be an array of strings", index)
	}
	out := make([]string, value.Length())
	for i := range out {
		element := value.Index(i)
		if element.Type() != js.TypeString {
			return nil, fmt.Errorf("argv[%d] must be a string, got %s", i, element.Type())
		}
		out[i] = element.String()
	}
	return out, nil
}

// safely runs fn and swallows a panic from it. Used only where the alternative
// is worse than the fault: a throw crossing back from the host during a run's
// teardown, where losing the fault costs a diagnostic and keeping it costs the
// instance.
func safely(fn func()) {
	defer func() { _ = recover() }()
	fn()
}
