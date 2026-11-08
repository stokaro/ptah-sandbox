/** Values exchanged by the DuckDB-Wasm bridge and the Go database/sql driver. */
export function duckDBOID(type: string): number {
  if (type === "Bool") return 16;
  if (/^U?Int/.test(type)) return 20;
  if (/^Float/.test(type)) return 701;
  if (type.startsWith("Date")) return 1082;
  if (type.startsWith("Timestamp")) return 1184;
  if (/^(Binary|FixedSizeBinary)/.test(type)) return 17;
  if (type.startsWith("List<")) return 1009;
  return 25;
}

export function duckDBCell(value: unknown, type: string): string | null {
  if (value === null || value === undefined) return null;
  // Arrow's row.toJSON() returns JavaScript milliseconds for both Date and
  // Timestamp, irrespective of the Arrow unit named in the field's type.
  if (type.startsWith("Date") && typeof value === "number") return new Date(value).toISOString().slice(0, 10);
  if (type.startsWith("Timestamp") && typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  if (type.startsWith("List<")) return JSON.stringify(Array.from(value as Iterable<unknown>));
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
