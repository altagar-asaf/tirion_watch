package tui

import (
	"strings"
)

type Column struct {
	Title string
	Width int
}

func renderTable(columns []Column, rows [][]string, selected int) string {
	var lines []string
	lines = append(lines, renderRow(columns, titles(columns), false))
	lines = append(lines, renderRule(columns))
	if len(rows) == 0 {
		lines = append(lines, mutedStyle.Render("  (none)"))
		return strings.Join(lines, "\n")
	}
	for index, row := range rows {
		lines = append(lines, renderRow(columns, row, index == selected))
	}
	return strings.Join(lines, "\n")
}

func renderKV(rows [][2]string) string {
	width := 0
	for _, row := range rows {
		width = max(width, len(row[0]))
	}
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		lines = append(lines, pad(row[0], width)+"  "+row[1])
	}
	return strings.Join(lines, "\n")
}

func renderSection(title string, body string) string {
	if strings.TrimSpace(body) == "" {
		body = mutedStyle.Render("(empty)")
	}
	return titleStyle.Render(title) + "\n" + body
}

func renderRow(columns []Column, row []string, selected bool) string {
	cells := make([]string, len(columns))
	for index, column := range columns {
		value := ""
		if index < len(row) {
			value = row[index]
		}
		cells[index] = padVisible(truncateCell(value, column.Width), column.Width)
	}
	line := "  " + strings.Join(cells, "  ")
	if selected {
		return activeTabStyle.Render("> " + strings.Join(cells, "  "))
	}
	return line
}

func renderRule(columns []Column) string {
	parts := make([]string, len(columns))
	for index, column := range columns {
		parts[index] = strings.Repeat("-", column.Width)
	}
	return mutedStyle.Render("  " + strings.Join(parts, "  "))
}

func titles(columns []Column) []string {
	out := make([]string, len(columns))
	for index, column := range columns {
		out[index] = column.Title
	}
	return out
}

func truncate(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if len(value) <= width {
		return value
	}
	if width <= 1 {
		return value[:width]
	}
	return value[:width-1] + "."
}

func truncateVisible(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if visibleLen(value) <= width {
		return value
	}
	return truncate(stripANSI(value), width)
}

func truncateCell(value string, width int) string {
	if visibleLen(value) <= width {
		return value
	}
	return truncateVisible(value, width)
}

func pad(value string, width int) string {
	if len(value) >= width {
		return value
	}
	return value + strings.Repeat(" ", width-len(value))
}

func padVisible(value string, width int) string {
	if visibleLen(value) >= width {
		return value
	}
	return value + strings.Repeat(" ", width-visibleLen(value))
}
