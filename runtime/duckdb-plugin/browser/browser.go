package browser

import (
	"github.com/stokaro/ptah-duckdb-plugin/internal/backend"
	"github.com/stokaro/ptah/provider-sdk/runtime"
)

func Server() runtime.Server { return backend.Server() }
