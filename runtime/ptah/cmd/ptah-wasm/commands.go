//go:build js

package main

import (
	"github.com/spf13/cobra"

	"ptah.run/cmd/internal/browsercmd"
)

// The command tree lives in ptah.run/cmd/internal/browsercmd so that the build
// script's manifest helper can walk the same tree this binary executes.
// Deriving the two separately is how a manifest ends up advertising verbs the
// binary does not carry.

func newBrowserRootCommand() *cobra.Command { return browsercmd.NewRootCommand() }

func commandPaths(root *cobra.Command) []string { return browsercmd.CommandPaths(root) }
