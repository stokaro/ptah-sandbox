//go:build js

package main

import (
	"bytes"
	"time"
	"unicode/utf8"
)

// stream names one of Contract B's two output methods.
type stream string

const (
	streamOut stream = "stdout"
	streamErr stream = "stderr"
)

const (
	// hardFlushBytes is the size at which a buffer is handed over whether or
	// not it holds a complete line. A command that writes a megabyte without a
	// newline -- a rendered diagram, a serialized plan -- must still reach the
	// host in pieces.
	hardFlushBytes = 16 << 10

	// softFlushBytes is the size at which a completed line stops waiting for
	// the coalescing window.
	softFlushBytes = 4 << 10

	// coalesceWindow is how long completed lines are allowed to accumulate
	// before one call carries them all.
	//
	// Every call crosses the Go/JavaScript boundary and, in the worker, turns
	// into a postMessage; a per-line call makes a thousand-statement plan a
	// thousand messages. The window is short enough that a person watching a
	// command run cannot see it, and it never delays the two moments that
	// matter -- see [hostWriter.Flush].
	coalesceWindow = 4 * time.Millisecond
)

// budget is the output allowance a run's two streams share.
//
// Shared rather than per-stream because what it protects is the transcript,
// and the transcript is one thing: a command that fills stdout has already
// spent the tab's memory whether or not stderr is quiet.
type budget struct {
	remaining int
	exhausted bool

	// notify is called once, the first time bytes are dropped.
	notify func()
}

// take reports how much of p fits in the budget, cutting on a rune boundary so
// that a truncated transcript still decodes.
//
// It records exhaustion but does not announce it. The announcement belongs
// after the last surviving bytes have been handed to the host, and only the
// caller knows when that has happened.
func (b *budget) take(p []byte) []byte {
	if b.remaining >= len(p) {
		b.remaining -= len(p)
		return p
	}
	kept := p[:runeBoundary(p, b.remaining)]
	b.remaining = 0
	b.exhausted = true
	return kept
}

// outputSink is the half of the host boundary a writer uses. It is an
// interface so that the chunking rules can be exercised without a JavaScript
// runtime underneath them.
type outputSink interface {
	write(runID int, target stream, text string)
}

// hostWriter is the io.Writer a command's stdout or stderr is bound to.
//
// It exists for three reasons. It coalesces, because the boundary it writes
// across is expensive. It never splits a rune, because the far side is a
// JavaScript string and a half-decoded sequence there is a replacement
// character that no longer round-trips. And it enforces the run's byte budget
// while still reporting a complete write to the command, because a short write
// is an I/O error to fmt and would change what the command does -- truncation
// is the host's problem, not the program's.
type hostWriter struct {
	sink   outputSink
	runID  int
	target stream
	budget *budget

	buf       []byte
	lastFlush time.Time
}

func newHostWriter(sink outputSink, runID int, target stream, limit *budget) *hostWriter {
	return &hostWriter{sink: sink, runID: runID, target: target, budget: limit, lastFlush: time.Now()}
}

// Write always reports the full length: see [hostWriter].
func (w *hostWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	w.maybeFlush()
	return len(p), nil
}

// maybeFlush hands over as much as is worth one call.
func (w *hostWriter) maybeFlush() {
	if len(w.buf) >= hardFlushBytes {
		w.emit(runeBoundary(w.buf, hardFlushBytes))
		return
	}
	lineEnd := bytes.LastIndexByte(w.buf, '\n')
	if lineEnd < 0 {
		return
	}
	if len(w.buf) >= softFlushBytes || time.Since(w.lastFlush) >= coalesceWindow {
		w.emit(lineEnd + 1)
	}
}

// Flush hands over everything buffered, complete line or not.
//
// It is called at the two points where waiting would be a bug rather than an
// optimization: before the run blocks reading stdin, because a prompt written
// without a trailing newline is exactly what the reader is waiting to see
// (cmd/schema/apply.go writes "Type 'YES' to confirm: " and then blocks), and
// before the run reports done, because there is nothing after that.
func (w *hostWriter) Flush() {
	w.emit(len(w.buf))
}

func (w *hostWriter) emit(n int) {
	if n > len(w.buf) {
		n = len(w.buf)
	}
	if n <= 0 {
		return
	}
	// The string is built before the buffer is compacted: compaction copies
	// over the bytes being handed out.
	wasExhausted := w.budget.exhausted
	text := string(w.budget.take(w.buf[:n]))
	w.buf = append(w.buf[:0], w.buf[n:]...)
	w.lastFlush = time.Now()
	if text != "" {
		w.sink.write(w.runID, w.target, text)
	}
	if !wasExhausted && w.budget.exhausted && w.budget.notify != nil {
		w.budget.notify()
	}
}

// runeBoundary returns the largest index at or below n where p can be cut
// without splitting a UTF-8 sequence.
func runeBoundary(p []byte, n int) int {
	if n >= len(p) {
		return len(p)
	}
	if n <= 0 {
		return 0
	}
	// Walk back to the byte that starts the rune byte n belongs to. A
	// continuation byte is 10xxxxxx; at most three of them can precede a lead.
	start := n
	for start > 0 && start > n-utf8.UTFMax && p[start]&0xC0 == 0x80 {
		start--
	}
	if _, size := utf8.DecodeRune(p[start:]); start+size <= n {
		return n
	}
	return start
}
