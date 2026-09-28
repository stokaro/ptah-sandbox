/** UI catalog read directly from PostgreSQL's public schema. */
import { buildCatalog, quoteIdent, quoteLiteral, rowCountSQL, type Catalog, type Query } from "./catalog.ts";

export const POSTGRES_CATALOG_SQL = {
 tables: "SELECT c.relname, '' FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.oid",
 columns: `SELECT c.relname, a.attnum-1, a.attname, format_type(a.atttypid,a.atttypmod), a.attnotnull::int,
 pg_get_expr(d.adbin,d.adrelid), COALESCE(array_position(i.indkey::smallint[],a.attnum)+1,0)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary
 WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.oid,a.attnum`,
 foreignKeys: `SELECT c.relname, target.relname, a.attname, b.attname FROM pg_constraint f
 JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_class target ON target.oid=f.confrelid
 JOIN LATERAL unnest(f.conkey,f.confkey) AS keys(src,dst) ON true
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=keys.src
 JOIN pg_attribute b ON b.attrelid=target.oid AND b.attnum=keys.dst
 WHERE n.nspname='public' AND f.contype='f' ORDER BY c.oid,f.oid`,
 indexes: `SELECT c.relname, x.relname, i.indisunique::int,
 CASE WHEN i.indisprimary THEN 'pk' WHEN EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=x.oid) THEN 'u' ELSE 'c' END
 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.oid,x.oid`,
 indexColumns: `SELECT c.relname,x.relname,k.ordinality-1,pg_get_indexdef(x.oid,k.ordinality::int,true)
 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) ON true
 WHERE n.nspname='public' AND k.ordinality<=i.indnkeyatts ORDER BY c.oid,x.oid,k.ordinality`,
};

export async function readPostgresCatalog(path: string, query: Query, withCounts = true): Promise<Catalog> {
 const [tables,columns,foreignKeys,indexes,indexColumns] = await Promise.all(
  Object.values(POSTGRES_CATALOG_SQL).map(sql => query(path,sql)),
 );
 const countSQL = rowCountSQL(tables.rows.map(row => String(row[0])));
 const rowCounts = withCounts && countSQL ? await query(path,countSQL) : null;
 return { ...buildCatalog(path,{tables,columns,foreignKeys,indexes,indexColumns,rowCounts},Date.now()), engine:"postgres" };
}

export const postgresTableNames = "SELECT tablename FROM pg_tables WHERE schemaname='public'";
export const postgresIndexNames = "SELECT indexname FROM pg_indexes WHERE schemaname='public'";
export function postgresColumnNames(table: string): string {
 return `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${quoteLiteral(table)} ORDER BY ordinal_position`;
}
export function postgresRows(catalog: Catalog, name: string, limit: number) {
 const pk = catalog.tables.find(t => t.name === name)?.columns.filter(c => c.pk > 0).sort((a,b) => a.pk-b.pk) ?? [];
 return {sql:`SELECT * FROM ${quoteIdent(name)}${pk.length ? ` ORDER BY ${pk.map(c => quoteIdent(c.name)).join(", ")}` : ""} LIMIT ${limit+1}`,
 order:pk.length ? "ordered by primary key" : "database order · no primary key"};
}
