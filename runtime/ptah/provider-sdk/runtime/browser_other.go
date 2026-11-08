//go:build !js

package runtime

import "context"

// Browser registrations do not exist in native builds.
func BrowserProviderIdentity() (string, string, string, bool)      { return "", "", "", false }
func BrowserProviderAvailable(string, string, string) bool         { return false }
func browserStart(context.Context, Options) (*Client, bool, error) { return nil, false, nil }
