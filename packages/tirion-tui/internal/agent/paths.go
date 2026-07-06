package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

type Paths struct {
	StateDir           string
	BootstrapTokenPath string
	SocketPath         string
}

func ResolvePaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}

	stateDir := os.Getenv("TIRION_AGENT_STATE_DIR")
	if stateDir == "" {
		if runtime.GOOS == "darwin" {
			stateDir = filepath.Join(home, "Library", "Application Support", "Tirion", "agent")
		} else {
			stateDir = filepath.Join(home, ".local", "state", "tirion", "agent")
		}
	}

	runtimeDir := os.Getenv("TIRION_AGENT_RUNTIME_DIR")
	if runtimeDir == "" {
		runtimeDir = filepath.Join(os.TempDir(), "tirion-"+strconv.Itoa(os.Getuid()))
	}

	socketPath := os.Getenv("TIRION_AGENT_SOCKET")
	if socketPath == "" {
		socketPath = filepath.Join(runtimeDir, "agent.sock")
	}

	return Paths{
		StateDir:           stateDir,
		BootstrapTokenPath: filepath.Join(stateDir, "bootstrap.token"),
		SocketPath:         socketPath,
	}, nil
}
