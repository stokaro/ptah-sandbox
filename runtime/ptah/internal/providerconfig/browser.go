package providerconfig

import (
	providerruntime "github.com/stokaro/ptah/provider-sdk/runtime"
	"ptah.run/internal/providerhost"
)

// BrowserConfiguration names the provider compiled into the playground's wasm
// artifact. No external executable is selected by this implicit configuration.
func BrowserConfiguration() Configuration {
	id, executable, sha256, found := providerruntime.BrowserProviderIdentity()
	if !found {
		return Configuration{}
	}
	return Configuration{FormatVersion: FormatVersion, Providers: []Installation{{
		Spec:    providerhost.Spec{ProviderID: id, Executable: executable, SHA256: sha256},
		Engines: []Engine{{ID: "duckdb"}},
	}}}
}
