/**
 * The database catalog: what SQLite says is actually in the file.
 *
 * The rail, the structure pane and the data pane all render from this and
 * never from the editor buffer. That is the whole point of the product being
 * believable: the left rail claims `users` has a column called `active`
 * because `PRAGMA table_info` said so after the command finished, not because
 * the word appears in a text file the visitor just typed into.
 *
 * The desired side is read the same way. `readDesiredCatalog` loads the
 * schema file into a scratch database and reads *that* catalog with the same
 * queries, so the comparison is SQLite's parser against SQLite's parser. No
 * DDL is parsed in TypeScript here -- a hand-rolled parser would be a source
 * of quiet mismarking, and mismarking is the one thing a drift display cannot
 * afford.
 */

/** One row set, shaped exactly like the `sql` host event's payload. */
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

/** Runs one statement against a database and returns its rows. */
export type Query = (path: string, sql: string) => Promise<QueryResult>;

/** Runs statements for their effect. Used only for the scratch database. */
export type Exec = (path: string, sql: string) => Promise<void>;

export interface ColumnInfo {
  name: string;
  /** The declared type, verbatim. SQLite permits a column with no type. */
  type: string;
  notNull: boolean;
  /** The DEFAULT expression as SQLite stored it, or null when there is none. */
  defaultExpr: string | null;
  /** 0 when the column is not in the primary key, else its 1-based position. */
  pk: number;
}

export interface ForeignKeyInfo {
  column: string;
  table: string;
  /** null when the reference names no column, which means the target's PK. */
  toColumn: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  /** "c" = CREATE INDEX, "u" = a UNIQUE constraint, "pk" = the primary key. */
  origin: string;
}

export interface TableInfo {
  name: string;
  /** The CREATE statement SQLite stored, verbatim. Empty for a shadow table. */
  ddl: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  /** null until COUNT(*) has actually run. Never a guess. */
  rowCount: number | null;
}

export interface Catalog {
  /** The path the bridge keys on, e.g. "app.db" -- not the sqlite:// URL. */
  path: string;
  /** In definition order, which is how the rail and the panes list them. */
  tables: TableInfo[];
  /** When the read that produced this finished. Identifies a catalog vintage. */
  readAt: number;
}

// --------------------------------------------------------------------------
// Identifier and literal quoting
// --------------------------------------------------------------------------

/** Quotes an identifier for interpolation into generated SQL. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a string literal for interpolation into generated SQL. */
export function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

// --------------------------------------------------------------------------
// The reads
// --------------------------------------------------------------------------

/**
 * Everything the catalog needs, in five statements rather than four per table.
 *
 * The `pragma_*` table-valued functions do the join in SQLite. They are
 * present unless the build sets SQLITE_OMIT_INTROSPECTION_PRAGMAS, and the
 * vendored build (3.53.4, options recorded in vendor/sqlite) does not. If
 * that ever changes these queries fail loudly and the panes show the error,
 * which is the right outcome: a catalog that is quietly half-read would make
 * every marker on the page suspect.
 *
 * Ordering is by `sqlite_schema.rowid`, which is definition order. That is
 * what a person who wrote the schema file expects to see, and it is stable
 * across reads.
 */
export const CATALOG_SQL = {
  tables:
    "SELECT name, sql FROM sqlite_schema" +
    " WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
    " ORDER BY rowid",
  columns:
    "SELECT m.name AS tbl, c.cid, c.name, c.type, c.\"notnull\", c.dflt_value, c.pk" +
    " FROM sqlite_schema m JOIN pragma_table_info(m.name) c" +
    " WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
    " ORDER BY m.rowid, c.cid",
  foreignKeys:
    'SELECT m.name AS tbl, f."table", f."from", f."to", f.id, f.seq' +
    " FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f" +
    " WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
    " ORDER BY m.rowid, f.id, f.seq",
  indexes:
    'SELECT m.name AS tbl, i.name, i."unique", i.origin' +
    " FROM sqlite_schema m JOIN pragma_index_list(m.name) i" +
    " WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
    " ORDER BY m.rowid, i.seq",
  indexColumns:
    "SELECT m.name AS tbl, i.name AS idx, c.seqno, c.name" +
    " FROM sqlite_schema m" +
    " JOIN pragma_index_list(m.name) i" +
    " JOIN pragma_index_info(i.name) c" +
    " WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
    " ORDER BY m.rowid, i.seq, c.seqno",
} as const;

/**
 * COUNT(*) for every table in one statement.
 *
 * A full scan per table, which is honest but not free; the row counts in the
 * rail are therefore refreshed when a command finishes, not on every keypress.
 */
export function rowCountSQL(tables: string[]): string | null {
  if (tables.length === 0) return null;
  return tables
    .map((t) => `SELECT ${quoteLiteral(t)} AS tbl, COUNT(*) AS n FROM ${quoteIdent(t)}`)
    .join(" UNION ALL ");
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return String(v);
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  // The bridge hands back an i64 that does not fit a double as a decimal
  // string. Number() then loses precision, which for a row count is a lie we
  // would rather not tell -- but a table with 2^53 rows is not reachable in a
  // browser tab, so the coercion is safe here and stated rather than hidden.
  if (typeof v === "string") return Number(v);
  return 0;
}

/** Indexes rows by the value of their first column. Preserves row order. */
function groupByFirst(result: QueryResult): Map<string, unknown[][]> {
  const out = new Map<string, unknown[][]>();
  for (const row of result.rows) {
    const key = str(row[0]);
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/**
 * Assembles a catalog from the six row sets. Pure, so the shape of every
 * marker the UI draws is testable without a database.
 */
export function buildCatalog(
  path: string,
  parts: {
    tables: QueryResult;
    columns: QueryResult;
    foreignKeys: QueryResult;
    indexes: QueryResult;
    indexColumns: QueryResult;
    rowCounts: QueryResult | null;
  },
  readAt: number,
): Catalog {
  const columnsBy = groupByFirst(parts.columns);
  const fkBy = groupByFirst(parts.foreignKeys);
  const indexBy = groupByFirst(parts.indexes);
  const indexColsBy = groupByFirst(parts.indexColumns);

  const counts = new Map<string, number>();
  if (parts.rowCounts) {
    for (const row of parts.rowCounts.rows) counts.set(str(row[0]), num(row[1]));
  }

  const tables: TableInfo[] = parts.tables.rows.map((row) => {
    const name = str(row[0]);

    const columns: ColumnInfo[] = (columnsBy.get(name) ?? []).map((c) => ({
      name: str(c[2]),
      type: str(c[3]),
      notNull: num(c[4]) !== 0,
      defaultExpr: c[5] === null || c[5] === undefined ? null : str(c[5]),
      pk: num(c[6]),
    }));

    const foreignKeys: ForeignKeyInfo[] = (fkBy.get(name) ?? []).map((f) => ({
      table: str(f[1]),
      column: str(f[2]),
      toColumn: f[3] === null || f[3] === undefined ? null : str(f[3]),
    }));

    const indexCols = new Map<string, string[]>();
    for (const ic of indexColsBy.get(name) ?? []) {
      const idx = str(ic[1]);
      const list = indexCols.get(idx);
      // A NULL name is an expression or the rowid; it has no column to show.
      const col = ic[3] === null || ic[3] === undefined ? null : str(ic[3]);
      if (col === null) continue;
      if (list) list.push(col);
      else indexCols.set(idx, [col]);
    }

    const indexes: IndexInfo[] = (indexBy.get(name) ?? []).map((i) => {
      const idxName = str(i[1]);
      return {
        name: idxName,
        columns: indexCols.get(idxName) ?? [],
        unique: num(i[2]) !== 0,
        origin: str(i[3]),
      };
    });

    return {
      name,
      ddl: str(row[1]),
      columns,
      foreignKeys,
      indexes,
      rowCount: counts.has(name) ? counts.get(name)! : null,
    };
  });

  return { path, tables, readAt };
}

/** Reads the whole catalog. Six round trips, regardless of table count. */
export async function readCatalog(path: string, query: Query, withCounts = true): Promise<Catalog> {
  const [tables, columns, foreignKeys, indexes, indexColumns] = await Promise.all([
    query(path, CATALOG_SQL.tables),
    query(path, CATALOG_SQL.columns),
    query(path, CATALOG_SQL.foreignKeys),
    query(path, CATALOG_SQL.indexes),
    query(path, CATALOG_SQL.indexColumns),
  ]);
  let rowCounts: QueryResult | null = null;
  if (withCounts) {
    const sql = rowCountSQL(tables.rows.map((r) => str(r[0])));
    if (sql) rowCounts = await query(path, sql);
  }
  return buildCatalog(
    path,
    { tables, columns, foreignKeys, indexes, indexColumns, rowCounts },
    Date.now(),
  );
}

/**
 * The scratch database the desired schema is read from.
 *
 * It is a real SQLite database that only ever holds the contents of the
 * schema file. Nothing in it is shown to the visitor and no command is ever
 * pointed at it.
 */
export const DESIRED_DB_PATH = "__desired.db";

/**
 * Loads the schema text into the scratch database and reads its catalog.
 *
 * Throws with SQLite's own message when the file does not parse. The caller
 * should show that message and mark nothing: with no desired side there is no
 * comparison, and the panes say so rather than implying the two agree.
 */
export async function readDesiredCatalog(
  schemaSql: string,
  exec: Exec,
  query: Query,
  path = DESIRED_DB_PATH,
): Promise<Catalog> {
  const existing = await query(
    path,
    "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid DESC",
  );
  const drops: string[] = [];
  for (const row of existing.rows) {
    const type = str(row[0]);
    const name = str(row[1]);
    // An index or trigger belonging to a dropped table is already gone, so
    // every DROP is guarded rather than ordered.
    if (type === "table") drops.push(`DROP TABLE IF EXISTS ${quoteIdent(name)};`);
    else if (type === "view") drops.push(`DROP VIEW IF EXISTS ${quoteIdent(name)};`);
    else if (type === "index") drops.push(`DROP INDEX IF EXISTS ${quoteIdent(name)};`);
    else if (type === "trigger") drops.push(`DROP TRIGGER IF EXISTS ${quoteIdent(name)};`);
  }
  if (drops.length > 0) await exec(path, drops.join("\n"));
  await exec(path, schemaSql);
  // The desired side has no rows by construction, so counting is skipped.
  return readCatalog(path, query, false);
}

// --------------------------------------------------------------------------
// Reading a catalog
// --------------------------------------------------------------------------

export function findTable(catalog: Catalog | null, name: string): TableInfo | null {
  if (!catalog) return null;
  return catalog.tables.find((t) => t.name === name) ?? null;
}

/**
 * The constraint text for one column, in the order SQLite writes it.
 *
 * Composite primary keys say so: `PRIMARY KEY` alone on two columns would
 * read as two separate keys.
 */
export function columnConstraint(table: TableInfo, column: ColumnInfo): string {
  const parts: string[] = [];
  if (column.pk > 0) {
    const width = table.columns.filter((c) => c.pk > 0).length;
    parts.push(width > 1 ? `PRIMARY KEY (${column.pk} of ${width})` : "PRIMARY KEY");
  }
  if (column.notNull) parts.push("NOT NULL");
  if (column.defaultExpr !== null) parts.push(`DEFAULT ${column.defaultExpr}`);
  return parts.join(" ");
}

export function foreignKeyFor(table: TableInfo, column: string): ForeignKeyInfo | null {
  return table.foreignKeys.find((f) => f.column === column) ?? null;
}

/**
 * `FK -> users.id`. When the reference names no column SQLite means the
 * target's primary key, so the label resolves it rather than saying nothing.
 */
export function foreignKeyLabel(catalog: Catalog | null, fk: ForeignKeyInfo): string {
  let target = fk.toColumn;
  if (target === null) {
    const other = findTable(catalog, fk.table);
    const pk = other?.columns.filter((c) => c.pk > 0) ?? [];
    target = pk.length === 1 ? pk[0]!.name : null;
  }
  return target === null ? `FK → ${fk.table}` : `FK → ${fk.table}.${target}`;
}

/** Every foreign key in the database that points at `name`. */
export function referencedBy(
  catalog: Catalog,
  name: string,
): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const table of catalog.tables) {
    for (const fk of table.foreignKeys) {
      if (fk.table !== name) continue;
      out.push({
        from: `${table.name}.${fk.column}`,
        to: foreignKeyLabel(catalog, fk).replace(/^FK → /, ""),
      });
    }
  }
  return out;
}

/** Indexes the schema created explicitly, as opposed to constraint indexes. */
export function explicitIndexes(table: TableInfo): IndexInfo[] {
  return table.indexes.filter((i) => i.origin === "c");
}

/**
 * True when the table has no rowid to order a read by.
 *
 * Read off the stored DDL, which is the only place SQLite records it. The
 * test is deliberately narrow -- the clause can only appear after the closing
 * parenthesis -- and a false negative costs nothing but an ORDER BY that the
 * query planner then rejects, which surfaces as a visible pane error rather
 * than as silently misordered rows.
 */
export function isWithoutRowid(table: TableInfo): boolean {
  return /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(table.ddl);
}

// --------------------------------------------------------------------------
// Desired minus actual
// --------------------------------------------------------------------------

/**
 * What one column's presence means, comparing the live catalog with the
 * catalog SQLite built from the schema file.
 *
 * `only-in-database` is the drift story: the column is in the database and
 * the schema file does not mention it. It is the one value that earns amber.
 * `only-in-schema` is the ordinary state between an edit and an apply, so it
 * stays quiet.
 */
export type ColumnMark = "in-both" | "only-in-database" | "only-in-schema";

export interface SchemaDiff {
  /** Column name to mark, for the table asked about. */
  columns: Map<string, ColumnMark>;
  /** True when at least one column is in the database but not in the file. */
  hasDrift: boolean;
  /** Table names present in the database but not in the schema file. */
  extraTables: string[];
  /** Table names in the schema file that the database does not have yet. */
  missingTables: string[];
}

/**
 * Compares one table across the two catalogs.
 *
 * With no desired catalog the answer is "everything is in both", not
 * "everything drifted": absence of a comparison is not evidence of a
 * difference, and the panes say the comparison is unavailable instead.
 */
export function diffTable(
  actual: Catalog | null,
  desired: Catalog | null,
  name: string,
): SchemaDiff {
  const columns = new Map<string, ColumnMark>();
  const actualTable = findTable(actual, name);
  const desiredTable = findTable(desired, name);

  if (!desired || !desiredTable) {
    for (const c of actualTable?.columns ?? []) columns.set(c.name, "in-both");
    return { columns, hasDrift: false, extraTables: [], missingTables: [] };
  }

  const desiredNames = new Set(desiredTable.columns.map((c) => c.name));
  const actualNames = new Set((actualTable?.columns ?? []).map((c) => c.name));
  let hasDrift = false;
  for (const c of actualTable?.columns ?? []) {
    const mark = desiredNames.has(c.name) ? "in-both" : "only-in-database";
    if (mark === "only-in-database") hasDrift = true;
    columns.set(c.name, mark);
  }
  for (const c of desiredTable.columns) {
    if (!actualNames.has(c.name)) columns.set(c.name, "only-in-schema");
  }
  return { columns, hasDrift, extraTables: [], missingTables: [] };
}

/** The same comparison across the whole database. */
export function diffCatalogs(actual: Catalog | null, desired: Catalog | null): SchemaDiff {
  const columns = new Map<string, ColumnMark>();
  if (!actual || !desired) {
    return { columns, hasDrift: false, extraTables: [], missingTables: [] };
  }
  const desiredNames = new Set(desired.tables.map((t) => t.name));
  const actualNames = new Set(actual.tables.map((t) => t.name));
  let hasDrift = false;
  for (const table of actual.tables) {
    const per = diffTable(actual, desired, table.name);
    for (const [column, mark] of per.columns) columns.set(`${table.name}.${column}`, mark);
    if (per.hasDrift) hasDrift = true;
  }
  const extraTables = actual.tables.map((t) => t.name).filter((n) => !desiredNames.has(n));
  const missingTables = desired.tables.map((t) => t.name).filter((n) => !actualNames.has(n));
  return { columns, hasDrift: hasDrift || extraTables.length > 0, extraTables, missingTables };
}

/**
 * Column names that appeared between two catalog reads.
 *
 * This is how the data pane knows to mark `active` as new after an apply. It
 * compares two things the database said about itself at two moments, so it
 * cannot mark a column the apply did not actually create.
 */
export function columnsAddedBetween(
  before: Catalog | null,
  after: Catalog | null,
  table: string,
): string[] {
  const b = findTable(before, table);
  const a = findTable(after, table);
  if (!b || !a) return [];
  const had = new Set(b.columns.map((c) => c.name));
  return a.columns.filter((c) => !had.has(c.name)).map((c) => c.name);
}
