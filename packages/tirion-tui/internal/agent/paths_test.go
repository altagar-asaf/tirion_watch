package agent

import (
	"path/filepath"
	"testing"
)

func TestResolvePathsHonorsSocketOverride(t *testing.T) {
	t.Setenv("TIRION_AGENT_STATE_DIR", filepath.Join("tmp", "state"))
	t.Setenv("TIRION_AGENT_RUNTIME_DIR", filepath.Join("tmp", "runtime"))
	t.Setenv("TIRION_AGENT_SOCKET", filepath.Join("tmp", "custom.sock"))

	paths, err := ResolvePaths()
	if err != nil {
		t.Fatalf("ResolvePaths() error = %v", err)
	}

	if paths.SocketPath != filepath.Join("tmp", "custom.sock") {
		t.Fatalf("SocketPath = %q", paths.SocketPath)
	}
	if paths.BootstrapTokenPath != filepath.Join("tmp", "state", "bootstrap.token") {
		t.Fatalf("BootstrapTokenPath = %q", paths.BootstrapTokenPath)
	}
}
