//go:build js

package instances

// The browser driver uses this name to route separate in-memory databases to
// separate DuckDB-Wasm workers. Native DuckDB always opens :memory: instead.
func memoryPathFor(name string) string {
	if name == "" {
		return memoryPath + "app"
	}
	return memoryPath + name
}
