package tui

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

func formatNanoUSD(value *int64) string {
	if value == nil {
		return "n/a"
	}
	return formatNanoUSDValue(*value)
}

func formatNanoUSDValue(value int64) string {
	return fmt.Sprintf("$%.4f", float64(value)/1_000_000_000)
}

func formatCount(value int64) string {
	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}
	raw := strconv.FormatInt(value, 10)
	if len(raw) <= 3 {
		return sign + raw
	}
	var chunks []string
	for len(raw) > 3 {
		chunks = append([]string{raw[len(raw)-3:]}, chunks...)
		raw = raw[:len(raw)-3]
	}
	chunks = append([]string{raw}, chunks...)
	return sign + strings.Join(chunks, ",")
}

func shortID(value string, length int) string {
	if value == "" {
		return "-"
	}
	if len(value) <= length {
		return value
	}
	return value[:length]
}

func relativeTime(value string) string {
	if value == "" {
		return "-"
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	duration := time.Since(parsed)
	if duration < 0 {
		duration = -duration
		return "in " + compactDuration(duration)
	}
	if duration < time.Minute {
		return "just now"
	}
	return compactDuration(duration) + " ago"
}

func compactDuration(duration time.Duration) string {
	if duration < time.Minute {
		return fmt.Sprintf("%ds", int(duration.Seconds()))
	}
	if duration < time.Hour {
		return fmt.Sprintf("%dm", int(duration.Minutes()))
	}
	if duration < 24*time.Hour {
		return fmt.Sprintf("%dh", int(duration.Hours()))
	}
	return fmt.Sprintf("%dd", int(duration.Hours()/24))
}

func boolWord(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func max(a int, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampWidth(width int) int {
	if width <= 0 {
		return 80
	}
	return max(40, width)
}
