# The experience we are building

play.ptah.run has one job: a person who has never installed Ptah understands, in
about ninety seconds, what declarative schema management actually does to a real
database — and believes it, because nothing on the page was staged.

Everything below is a constraint on the build, not decoration.

## The moment that has to land

Not "the tool ran". The moment is:

> I added `active INTEGER NOT NULL DEFAULT 1` to a text file, Ptah told me the
> exact SQL it would run, I approved it, and my three rows are still there —
> with the new column filled in.

Every design decision is scored against whether it sharpens that moment or blurs
it.

## Principles

**Nothing is staged.** The plan pane shows what the real planner produced. The
data pane shows rows read back out of SQLite after the command finished. The
exit code is the process's exit code. If a command fails, the failure stays on
screen. A guided step never substitutes a prepared success for a real result.

**The page is useful before the runtime is.** The shell, the files, the schema
text and the seeded table list render from a fixture the moment the HTML lands.
The WebAssembly download is a strip at the top with honest phases — downloading,
compiling, initializing, seeding — and real byte counts. Only *running a command*
waits for it. A person reads the schema and looks around while it loads.

**The route helps; it does not drive.** `Explore → Edit schema → Preview SQL →
Apply → Verify` is a suggestion with a real argv attached. Steps advance because
the state assertion passed — the column exists in the actual catalog — never
because a button was pressed. Going off-script is normal: the strip says the
workspace no longer matches the suggested edit and keeps working.

**Show the difference, not the noun.** Ptah's value is desired-state minus
actual-state. So the plan is the hero pane, statements are individually
readable and individually annotated, and the structure pane marks what came from
the schema file versus what is only in the database. When the schema buffer or
the catalog changes, the plan is marked stale immediately and apply re-plans.

**Data survival is made visible.** After an apply, the data pane refreshes
itself, the new column is marked as new, and the row count is stated. That is
the payoff; it should not require the visitor to go looking for it.

**The terminal is a terminal.** Real prompt, real echo, stderr distinguishable
from stdout, history on ↑, completion over the real command tree, Ctrl+C that
actually cancels, and the native confirmation prompt reading a real stdin. It is
not a shell: no pipes, no redirects, no `$( )`. Unsupported syntax gets an
explanation, never a silently mis-tokenized argv.

**Honesty is a feature.** The status bar states the version and commit of the
WebAssembly that is actually running and the SQLite build, and About adds what
this profile cannot do. "Runs entirely in your browser" is a claim we test with the network
switched off, not a slogan.

**There is a door out.** Export downloads a workspace that opens in the
installed CLI, with the commands to continue. A playground visit should end at
an install, not at a closed tab.

## Deliberately not in the first version

Sharing links, collaborative editing, accounts, cloud storage, network
databases, Docker, an ER diagram, a visual schema builder. Each of them costs
attention that the ninety seconds do not have.
