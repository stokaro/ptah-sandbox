//go:build js

package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"

	protocol "github.com/stokaro/ptah/provider-sdk/protocol/experimental"
	"github.com/stokaro/ptah/provider-sdk/provider"
	"google.golang.org/protobuf/proto"
)

type browserRegistration struct {
	id, executable, sha256 string
	factory                func() Server
}

var browserProvider *browserRegistration

// RegisterBrowserProvider exposes the provider compiled into this wasm module.
// It must be called once at startup, before any command can run.
func RegisterBrowserProvider(id, executable, sha256 string, factory func() Server) {
	if browserProvider != nil || id == "" || executable == "" || len(sha256) != 64 || factory == nil {
		panic("invalid browser provider registration")
	}
	browserProvider = &browserRegistration{id: id, executable: executable, sha256: strings.ToLower(sha256), factory: factory}
}

func BrowserProviderIdentity() (id, executable, sha256 string, found bool) {
	if browserProvider == nil {
		return "", "", "", false
	}
	return browserProvider.id, browserProvider.executable, browserProvider.sha256, true
}

func BrowserProviderAvailable(id, executable, sha256 string) bool {
	return browserProvider != nil && browserProvider.id == id && browserProvider.executable == executable && strings.EqualFold(browserProvider.sha256, sha256)
}

func browserStart(ctx context.Context, options Options) (*Client, bool, error) {
	if browserProvider == nil || options.Executable != browserProvider.executable {
		return nil, false, nil
	}
	if !BrowserProviderAvailable(options.ProviderID, options.Executable, options.SHA256) {
		return nil, true, fmt.Errorf("%w: browser provider identity differs from the compiled registration", provider.ErrProtocol)
	}
	if err := ctx.Err(); err != nil {
		return nil, true, err
	}
	rpc, stop, err := ServeInMemory(browserProvider.factory())
	if err != nil {
		return nil, true, fmt.Errorf("%w: %w", ErrStartup, err)
	}
	client := &Client{rpc: rpc, stop: stop}
	request := &protocol.DescribeRequest{Revision: provider.Revision, RequiredFeatures: options.RequiredFeatures,
		HostContract: provider.Contract(), HostFeatures: options.HostFeatures}
	description, err := rpc.Describe(ctx, request)
	if err != nil {
		client.Close()
		return nil, true, remoteError(ctx, nil, "negotiate", err)
	}
	description, err = negotiate(description, options)
	if err != nil {
		client.Close()
		return nil, true, err
	}
	if description.GetProviderId() != options.ProviderID {
		client.Close()
		return nil, true, fmt.Errorf("%w: browser provider identity differs from the registered owner", provider.ErrProtocol)
	}
	client.description = proto.CloneOf(description)
	if err := ctx.Err(); err != nil {
		client.Close()
		return nil, true, errors.Join(ErrStartup, err)
	}
	return client, true, nil
}
