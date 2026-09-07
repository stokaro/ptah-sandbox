//go:build js

package main

import (
	"context"
	"io"
	"sync"
)

// stdinPipe is the io.Reader a command's standard input is bound to.
//
// It is what makes Ptah's confirmation prompts work unchanged. `ptah schema
// apply` calls fmt.Fscan(cmd.InOrStdin(), &confirmation) and compares the word
// it reads to "YES" (cmd/schema/apply.go:582-599); there is no terminal check
// anywhere in that path, so a reader that blocks until the host pushes an
// answer is all the browser needs to reproduce the native behavior exactly,
// including the EOF case that exits 2.
//
// Blocking here is correct on js/wasm even though blocking inside a JavaScript
// callback is not. The callbacks -- push and closeWrite -- never block; only
// Read does, and it runs on the goroutine the run was started on. When every
// goroutine is blocked the Go scheduler returns control to the JavaScript
// event loop, which is what delivers the next pushStdin.
type stdinPipe struct {
	mu     sync.Mutex
	buf    []byte
	closed bool

	// wake carries no value: it only says that buf or closed changed. Capacity
	// one and a non-blocking send, so that a host pushing faster than the
	// command reads can never block a JavaScript callback.
	wake chan struct{}

	// ctx is the run's context. A waiting Read reports its cancelation rather
	// than waiting for input that is not coming.
	ctx context.Context

	// beforeBlock is called before Read waits. It flushes the run's output, so
	// that a prompt written without a trailing newline reaches the reader who
	// is being asked to answer it.
	beforeBlock func()
}

func newStdinPipe(ctx context.Context, beforeBlock func()) *stdinPipe {
	return &stdinPipe{
		wake:        make(chan struct{}, 1),
		ctx:         ctx,
		beforeBlock: beforeBlock,
	}
}

// push appends host-supplied bytes. It never blocks.
func (p *stdinPipe) push(data string) {
	p.mu.Lock()
	if !p.closed {
		p.buf = append(p.buf, data...)
	}
	p.mu.Unlock()
	p.signal()
}

// closeWrite makes every subsequent Read that drains the buffer report EOF.
func (p *stdinPipe) closeWrite() {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	p.signal()
}

func (p *stdinPipe) signal() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *stdinPipe) Read(dst []byte) (int, error) {
	for {
		p.mu.Lock()
		if len(p.buf) > 0 {
			n := copy(dst, p.buf)
			p.buf = p.buf[n:]
			p.mu.Unlock()
			return n, nil
		}
		closed := p.closed
		p.mu.Unlock()
		if closed {
			return 0, io.EOF
		}

		if p.beforeBlock != nil {
			p.beforeBlock()
		}
		select {
		case <-p.wake:
		case <-p.ctx.Done():
			// The cancelation itself, not EOF. Every reader here -- fmt.Fscan,
			// io.ReadAll, bufio -- returns a non-EOF error to its caller
			// unchanged, and cmdutil.NormalizeCommandError turns an error
			// carrying context.Canceled into Ptah's own "canceled" diagnostic
			// and exit code. Reporting EOF instead would tell the operator
			// their input ended when what actually happened is that they
			// stopped the command.
			return 0, p.ctx.Err()
		}
	}
}
