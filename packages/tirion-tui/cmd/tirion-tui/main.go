package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/altagar-asaf/tirion/packages/tirion-tui/internal/agent"
	"github.com/altagar-asaf/tirion/packages/tirion-tui/internal/tui"
)

func main() {
	client, err := agent.NewClientFromEnvironment()
	if err != nil {
		fmt.Fprintf(os.Stderr, "tirion-tui: %v\n", err)
		os.Exit(1)
	}

	program := tea.NewProgram(tui.NewModel(client), tea.WithAltScreen())
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "tirion-tui: %v\n", err)
		os.Exit(1)
	}
}
