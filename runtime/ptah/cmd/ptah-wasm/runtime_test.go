//go:build js

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// recordingSink stands in for the JavaScript host. Every call is one crossing
// of the boundary, which is what the coalescing rules are counted against.
type recordingSink struct {
	chunks []string
}

func (r *recordingSink) write(_ int, _ stream, text string) {
	r.chunks = append(r.chunks, text)
}

func (r *recordingSink) joined() string { return strings.Join(r.chunks, "") }

func newTestWriter(limit int) (*hostWriter, *recordingSink, *budget) {
	sink := &recordingSink{}
	allowance := &budget{remaining: limit}
	return newHostWriter(sink, 1, streamOut, allowance), sink, allowance
}

// TestWriterFlushesBeforeAReadBlocks is the confirmation prompt.
//
// cmd/schema/apply.go writes "Apply these schema changes? Type 'YES' to
// confirm: " -- no newline -- and then blocks in fmt.Fscan on stdin. If the
// writer holds that text waiting for a line that is never coming, the person
// being asked sees nothing and the run deadlocks on an answer they were never
// prompted for. This is the wiring in runner.start, exercised directly.
func TestWriterFlushesBeforeAReadBlocks(t *testing.T) {
	writer, sink, _ := newTestWriter(defaultMaxOutputBytes)
	pipe := newStdinPipe(context.Background(), writer.Flush)

	const prompt = "Apply these schema changes? Type 'YES' to confirm: "
	fmt.Fprint(writer, prompt)
	if got := sink.joined(); got != "" {
		t.Fatalf("a partial line reached the host before anything asked for it: %q", got)
	}

	read := make(chan string, 1)
	go func() {
		var answer string
		_, _ = fmt.Fscan(pipe, &answer)
		read <- answer
	}()

	// The reader is blocking, so the prompt must already be out.
	deadline := time.After(2 * time.Second)
	for sink.joined() != prompt {
		select {
		case <-deadline:
			t.Fatalf("prompt never reached the host, got %q", sink.joined())
		default:
			time.Sleep(time.Millisecond)
		}
	}

	pipe.push("YES\n")
	select {
	case answer := <-read:
		if answer != "YES" {
			t.Fatalf("read %q, want YES", answer)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the reader never woke up")
	}
}

func TestWriterCoalescesLinesIntoFewerCalls(t *testing.T) {
	writer, sink, _ := newTestWriter(defaultMaxOutputBytes)
	// Written back to back, so they land inside one coalescing window.
	for i := range 200 {
		fmt.Fprintf(writer, "ALTER TABLE \"t%d\" ADD COLUMN \"c\" INTEGER;\n", i)
	}
	writer.Flush()

	if len(sink.chunks) >= 200 {
		t.Fatalf("no coalescing: %d lines produced %d host calls", 200, len(sink.chunks))
	}
	if strings.Count(sink.joined(), "\n") != 200 {
		t.Fatalf("lost lines: %d", strings.Count(sink.joined(), "\n"))
	}
}

func TestWriterNeverSplitsARune(t *testing.T) {
	writer, sink, _ := newTestWriter(defaultMaxOutputBytes)
	// Well past hardFlushBytes, of a rune whose encoding is three bytes, so
	// that no cut can land on a boundary by luck.
	const glyph = "⚠️"
	want := strings.Repeat(glyph, 20000)
	if _, err := io.WriteString(writer, want); err != nil {
		t.Fatal(err)
	}
	writer.Flush()

	if len(sink.chunks) < 2 {
		t.Fatalf("test wrote too little to force a mid-buffer cut: %d chunks", len(sink.chunks))
	}
	for i, chunk := range sink.chunks {
		if !utf8.ValidString(chunk) {
			t.Fatalf("chunk %d is not valid UTF-8", i)
		}
	}
	if got := sink.joined(); got != want {
		t.Fatalf("reassembled output differs: %d bytes, want %d", len(got), len(want))
	}
}

func TestBudgetStopsAtTheLimitAndAnnouncesItOnce(t *testing.T) {
	writer, sink, allowance := newTestWriter(64)
	announced := 0
	allowance.notify = func() { announced++ }

	for range 10 {
		fmt.Fprintln(writer, strings.Repeat("x", 40))
	}
	writer.Flush()

	if got := len(sink.joined()); got != 64 {
		t.Fatalf("delivered %d bytes, want the full 64-byte budget", got)
	}
	if announced != 1 {
		t.Fatalf("announced truncation %d times, want exactly 1", announced)
	}
}

func TestBudgetCutsOnARuneBoundary(t *testing.T) {
	// Three-byte runes against a budget that is not a multiple of three.
	writer, sink, _ := newTestWriter(10)
	fmt.Fprint(writer, strings.Repeat("⚠", 8))
	writer.Flush()

	got := sink.joined()
	if !utf8.ValidString(got) {
		t.Fatalf("truncated output is not valid UTF-8: %q", got)
	}
	if len(got) != 9 {
		t.Fatalf("kept %d bytes, want 9 (three whole runes inside a 10-byte budget)", len(got))
	}
}

func TestWriteAlwaysReportsAFullWrite(t *testing.T) {
	// A short write is an I/O error to fmt, and would change what a command
	// does. Truncation is the host's problem, not the program's.
	writer, _, _ := newTestWriter(4)
	payload := []byte(strings.Repeat("y", 100))
	n, err := writer.Write(payload)
	if err != nil || n != len(payload) {
		t.Fatalf("Write = %d, %v; want %d, nil", n, err, len(payload))
	}
}

func TestStdinPipeReportsEOFAfterTheHostClosesIt(t *testing.T) {
	pipe := newStdinPipe(context.Background(), nil)
	pipe.push("YES")
	pipe.closeWrite()

	got, err := io.ReadAll(pipe)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if string(got) != "YES" {
		t.Fatalf("read %q, want YES", got)
	}
}

func TestStdinPipeReportsCancelationRatherThanEOF(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	pipe := newStdinPipe(ctx, nil)

	failed := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(pipe)
		failed <- err
	}()

	cancel()
	select {
	case err := <-failed:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("read reported %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a canceled read never returned")
	}
}

func TestRuneBoundary(t *testing.T) {
	// "a⚠b": 1 + 3 + 1 bytes. Only 0, 1, 4 and 5 are boundaries.
	p := []byte("a⚠b")
	for cut, want := range map[int]int{0: 0, 1: 1, 2: 1, 3: 1, 4: 4, 5: 5, 9: 5} {
		if got := runeBoundary(p, cut); got != want {
			t.Errorf("runeBoundary(%q, %d) = %d, want %d", p, cut, got, want)
		}
	}
}

func TestNormalizeArgvDropsOneLeadingProgramName(t *testing.T) {
	for _, test := range []struct {
		in, want []string
	}{
		{in: []string{"version"}, want: []string{"version"}},
		{in: []string{"ptah", "version"}, want: []string{"version"}},
		{in: []string{"ptah", "ptah"}, want: []string{"ptah"}},
		{in: nil, want: nil},
	} {
		if got := normalizeArgv(test.in); !slices.Equal(got, test.want) {
			t.Errorf("normalizeArgv(%q) = %q, want %q", test.in, got, test.want)
		}
	}
}

// TestCommandPathsCoverTheBrowserTree pins the shape of the capability
// announcement: real paths walked from the tree, and none of the four groups
// this build deliberately leaves out.
func TestCommandPathsCoverTheBrowserTree(t *testing.T) {
	paths := commandPaths(newBrowserRootCommand())

	for _, want := range []string{"schema", "schema apply", "migrations up", "sql lint", "version", "db capabilities", "viz", "introspect"} {
		if !slices.Contains(paths, want) {
			t.Errorf("command list is missing %q", want)
		}
	}
	for _, unwanted := range []string{"assist", "inference", "mcp", "oci", "project", "seed", "license"} {
		if slices.Contains(paths, unwanted) {
			t.Errorf("command list contains %q, which this build does not carry", unwanted)
		}
	}
	if !slices.IsSorted(paths) {
		t.Error("command list is not sorted")
	}
}

// TestLogSinkReachesTheRunningCommand covers the path Ptah's library code
// takes when it logs through the package-level slog functions: slog.Default()
// writes via the log package, which on a native build lands on the process
// stderr. There is no process stderr here, and dropping those records would
// lose warnings that are returned as no error at all -- circular foreign keys,
// a dev database that would not close.
func TestLogSinkReachesTheRunningCommand(t *testing.T) {
	sink := &recordingSink{}
	allowance := &budget{remaining: defaultMaxOutputBytes}
	stderr := newHostWriter(sink, 7, streamErr, allowance)
	r := &runner{}

	if n, err := r.logSink().Write([]byte("dropped\n")); err != nil || n != 8 {
		t.Fatalf("write with no run active = %d, %v; want 8, nil", n, err)
	}
	if got := sink.joined(); got != "" {
		t.Fatalf("a log line reached the host with no run active: %q", got)
	}

	r.active = &activeRun{id: 7, stderr: stderr}
	if _, err := r.logSink().Write([]byte("WARN circular foreign key\n")); err != nil {
		t.Fatal(err)
	}
	stderr.Flush()
	if got := sink.joined(); got != "WARN circular foreign key\n" {
		t.Fatalf("log line arrived as %q", got)
	}
}
