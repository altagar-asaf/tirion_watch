package tui

import (
	"regexp"

	"github.com/charmbracelet/lipgloss"
)

var (
	titleStyle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39"))
	activeTabStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("15")).Background(lipgloss.Color("24"))
	mutedStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	successStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("35"))
	warningStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	dangerStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
)

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func colorHealth(value string) string {
	switch value {
	case "healthy", "ready", "active", "configured", "already_configured", "restored", "supported", "complete", "delivered":
		return successStyle.Render(value)
	case "degraded", "starting", "partial", "awaiting_receipts", "retry", "paused", "not_managed", "Restart to activate":
		return warningStyle.Render(value)
	case "stopping", "failed", "unavailable", "blocked", "conflict", "invalid", "not_configured", "unsupported":
		return dangerStyle.Render(value)
	default:
		if value == "" {
			return mutedStyle.Render("unknown")
		}
		return value
	}
}

func stripANSI(value string) string {
	return ansiPattern.ReplaceAllString(value, "")
}

func visibleLen(value string) int {
	return len(stripANSI(value))
}
