// Package browsercmd assembles the Ptah command tree the browser build runs.
//
// It is a package rather than part of cmd/ptah-wasm so that two consumers can
// share one definition: the wasm entry point, which executes the tree, and the
// build-time helper that writes the command list into the playground manifest.
// A manifest listing verbs the binary cannot run is worse than no manifest,
// and that is exactly what happens when the two are derived separately.
//
// It lives under cmd/internal because the root it assembles uses cmd/internal
// helpers -- banner, cmdflags, cmdutil -- that Go will not let a package
// outside cmd/ import. Nothing here touches syscall/js, so it builds on every
// platform.
package browsercmd

import (
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"ptah.run/internal/cli/db"
	"ptah.run/internal/cli/banner"
	"ptah.run/internal/cli/internal/cmdflags"
	"ptah.run/internal/cli/internal/cmdutil"
	"ptah.run/internal/cli/introspect"
	"ptah.run/internal/cli/migrations"
	"ptah.run/internal/cli/schema"
	sqlcmd "ptah.run/internal/cli/sql"
	"ptah.run/internal/cli/version"
	"ptah.run/internal/cli/viz"
	"ptah.run/internal/buildinfo"
)

// envPrefix is the environment-variable prefix every flag binds under. It is
// the native one: a person copying an invocation out of the playground into a
// terminal must not find that PTAH_DB_URL meant something else here.
const envPrefix = "PTAH"

// NewRootCommand returns a root command carrying the verbs that work
// with no network, no container runtime and no model provider.
//
// It is assembled here rather than by calling cmd/root.NewRootCommand and
// removing what does not apply, because the cost avoided is a link-time one:
// assist, inference, mcp and oci reach model providers, an MCP server and an
// OCI registry, and referencing their constructors puts all of that in the
// WebAssembly module whether or not the browser can ever call it. Removing the
// commands afterwards would remove them from the help text and from nothing
// else.
//
// Everything else is deliberately identical to the native root -- the
// descriptions, the version template, cmdutil.ConfigureCommandArgs and
// cmdflags.InstallEnvBinding -- so that help output, flag parsing and error
// behavior match the binary this playground claims to be running. When
// cmd/root/root.go changes, this changes with it.
//
// A caller gets a fresh tree every time. Cobra stores parsed flag values on
// the command objects, so a reused tree would carry --dry-run from one run
// into the next.
func NewRootCommand() *cobra.Command {
	info := buildinfo.Resolve()
	cmd := &cobra.Command{
		Use:     "ptah",
		Short:   rootShortDescription,
		Long:    rootLongDescription,
		Version: info.Version,
		RunE: func(cmd *cobra.Command, _ []string) error {
			banner.Print(cmd.OutOrStdout(), "ptah", info.Version)
			return cmd.Help()
		},
	}
	cmd.SetVersionTemplate(versionTemplate(info))
	cmdutil.ConfigureCommandArgs(cmd, nil)

	cmd.AddCommand(introspect.NewIntrospectCommand())
	cmd.AddCommand(schema.NewSchemaCommand())
	cmd.AddCommand(db.NewDBCommand())
	cmd.AddCommand(migrations.NewMigrationsCommand())
	cmd.AddCommand(sqlcmd.NewSQLCommand())
	cmd.AddCommand(viz.NewCommand())
	cmd.AddCommand(version.NewVersionCommand())

	cmdflags.InstallEnvBinding(envPrefix, cmd)

	return cmd
}

// versionTemplate renders build metadata in the format the `version`
// subcommand prints, so that `ptah version`, `ptah --version` and `ptah -v`
// emit identical bytes. Copied from cmd/root/root.go, including the escaping:
// cobra parses the string as a text/template, so braces arriving from a build
// stamp must not be read as template actions.
func versionTemplate(info buildinfo.Info) string {
	var block strings.Builder
	buildinfo.Write(&block, info)
	return strings.ReplaceAll(block.String(), "{{", `{{"{{"}}`)
}

// CommandPaths lists every command a host can invoke, as the words a user
// would type after `ptah`.
//
// Walked from the tree rather than written down, so the playground's command
// list cannot claim a verb this build does not have, or miss one it does. The
// two commands cobra adds for itself are materialized first, because a user
// can type `ptah help schema` whether or not the tree was executed.
func CommandPaths(root *cobra.Command) []string {
	root.InitDefaultHelpCmd()
	root.InitDefaultCompletionCmd()

	var paths []string
	var walk func(cmd *cobra.Command, prefix []string)
	walk = func(cmd *cobra.Command, prefix []string) {
		for _, child := range cmd.Commands() {
			if child.Hidden || child.Deprecated != "" {
				continue
			}
			path := append(append([]string(nil), prefix...), child.Name())
			paths = append(paths, strings.Join(path, " "))
			walk(child, path)
		}
	}
	walk(root, nil)
	sort.Strings(paths)
	return paths
}

// rootShortDescription and rootLongDescription are the native root's own text,
// copied verbatim from cmd/root/root.go because the constants there are
// unexported and importing that package would drag the command graph this
// build exists to avoid. They are product copy, not behavior, and the
// playground must not paraphrase the product.
const rootShortDescription = "Ptah manages database change across schemas and " +
	"persistent inference state"

const rootLongDescription = `Ptah manages database change across schemas and
persistent inference state.

For schemas, it compares a desired schema with a live database and either writes
versioned migrations or applies an approved plan directly. Use either route, or
both, across supported databases.

For inference state, it builds a candidate embedding generation beside the
active one, calls an external embedding endpoint, verifies the result, and
switches consumers with a rollback path.

Run "ptah db capabilities --db-url <url>" to see what Ptah resolves for a
specific server. Scripts written for the Atlas CLI can use the separate
ptah-compat binary, which presents an Atlas-compatible command surface.`
