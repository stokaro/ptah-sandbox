/** UI catalog read from the DuckDB instance the plugin uses. */
import { buildCatalog, quoteIdent, quoteLiteral, rowCountSQL, type Catalog, type Query } from "./catalog.ts";

export const DUCKDB_CATALOG_SQL = {
  tables: "SELECT table_name, sql FROM duckdb_tables() WHERE schema_name='main' AND NOT internal ORDER BY table_oid",
  columns: `SELECT c.table_name, c.column_index-1, c.column_name, c.data_type,
    CASE WHEN c.is_nullable THEN 0 ELSE 1 END, c.column_default,
    COALESCE((SELECT list_position(k.constraint_column_names, c.column_name)
      FROM duckdb_constraints() k WHERE k.schema_name=c.schema_name AND k.table_name=c.table_name
      AND k.constraint_type='PRIMARY KEY' LIMIT 1), 0)
    FROM duckdb_columns() c WHERE c.schema_name='main' AND NOT c.internal
    ORDER BY c.table_oid, c.column_index`,
  foreignKeys: `SELECT c.table_name, c.referenced_table,
    unnest(c.constraint_column_names), unnest(c.referenced_column_names)
    FROM duckdb_constraints() c WHERE c.schema_name='main' AND c.constraint_type='FOREIGN KEY'
    ORDER BY c.table_oid, c.constraint_index`,
  indexes: `SELECT table_name, constraint_name, 1,
    CASE WHEN constraint_type='PRIMARY KEY' THEN 'pk' ELSE 'u' END
    FROM duckdb_constraints() WHERE schema_name='main' AND constraint_type IN ('PRIMARY KEY','UNIQUE')
    UNION ALL SELECT table_name, index_name, CASE WHEN is_unique THEN 1 ELSE 0 END, 'c'
    FROM duckdb_indexes() WHERE schema_name='main'`,
  indexColumns: `SELECT table_name, constraint_name, 0, unnest(constraint_column_names)
    FROM duckdb_constraints() WHERE schema_name='main' AND constraint_type IN ('PRIMARY KEY','UNIQUE')
    UNION ALL SELECT table_name, index_name, 0, expressions
    FROM duckdb_indexes() WHERE schema_name='main'`,
} as const;

export async function readDuckDBCatalog(path: string, query: Query, withCounts = true): Promise<Catalog> {
  const [tables, columns, foreignKeys, indexes, indexColumns] = await Promise.all(
    Object.values(DUCKDB_CATALOG_SQL).map(sql => query(path, sql)),
  );
  const countSQL = rowCountSQL(tables.rows.map(row => String(row[0])));
  const rowCounts = withCounts && countSQL ? await query(path, countSQL) : null;
  return { ...buildCatalog(path, { tables, columns, foreignKeys, indexes, indexColumns, rowCounts }, Date.now()), engine: "duckdb" };
}

export const duckdbTableNames = "SELECT table_name FROM duckdb_tables() WHERE schema_name='main' AND NOT internal";
export const duckdbIndexNames = "SELECT index_name FROM duckdb_indexes() WHERE schema_name='main'";
export function duckdbColumnNames(table: string): string {
  return `SELECT column_name FROM duckdb_columns() WHERE schema_name='main' AND table_name=${quoteLiteral(table)} ORDER BY column_index`;
}
export function duckdbRows(catalog: Catalog, name: string, limit: number) {
  const pk = catalog.tables.find(table => table.name === name)?.columns.filter(column => column.pk > 0).sort((a,b) => a.pk-b.pk) ?? [];
  return { sql: `SELECT * FROM ${quoteIdent(name)}${pk.length ? ` ORDER BY ${pk.map(column => quoteIdent(column.name)).join(", ")}` : ""} LIMIT ${limit+1}`,
    order: pk.length ? "ordered by primary key" : "database order · no primary key" };
}
