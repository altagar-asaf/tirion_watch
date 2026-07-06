package tui

import (
	"fmt"
	"strings"

	"github.com/altagar-asaf/tirion/packages/tirion-tui/internal/agent"
)

func (m Model) viewOverview() string {
	summaryRows := [][2]string{
		{"Agent", colorHealth(statusValue(m.snapshot.Status, func(s *agent.Status) string { return s.Health }))},
		{"Runtime warmup", colorHealth(statusValue(m.snapshot.Status, func(s *agent.Status) string { return s.RuntimeWarmupState }))},
		{"Runs measured", "0"},
		{"Tokens total", "0"},
		{"Estimated cost", "$0.0000"},
		{"Webhook URL", m.webhookURLOverviewValue()},
		{"Budget warnings", "0"},
	}
	if totals := m.snapshot.Totals; totals != nil {
		summaryRows[2][1] = formatCount(totals.RunCount)
		summaryRows[3][1] = formatCount(totals.TotalTokens)
		summaryRows[4][1] = formatNanoUSDValue(totals.EstimatedNanoUSD)
	}
	if budgets := m.snapshot.Budgets; budgets != nil {
		summaryRows[6][1] = formatCount(int64(len(budgets.Warnings)))
	}

	sections := []string{
		renderSection("Overview", renderKV(summaryRows)),
		renderSection("Attention", m.attentionList(3)),
		renderSection("Recent runs", m.runsTable(m.rowsThatFit(4, 12), -1)),
	}
	return strings.Join(sections, "\n\n")
}

func (m Model) viewHarnesses() string {
	harnesses := m.harnessRows()
	rows := make([][]string, 0, len(harnesses))
	for _, harness := range harnesses {
		rows = append(rows, []string{
			harness.name,
			colorHealth(harness.setup),
			colorHealth(harness.activity),
			emptyDash(harness.reason),
		})
	}
	table := renderTable([]Column{
		{"Harness", 14},
		{"Setup", 19},
		{"Activity", 10},
		{"Reason", 9},
	}, rows, m.selected)

	return strings.Join([]string{
		renderSection("Agentic coding harnesses", table),
		m.harnessActionPanel(harnesses),
	}, "\n\n")
}

func (m Model) viewRepositories() string {
	sourceRows := make([][]string, 0, len(m.snapshot.Sources))
	for _, source := range m.snapshot.Sources {
		sourceRows = append(sourceRows, []string{
			source.Provider,
			source.Runtime,
			colorHealth(source.Compatibility),
			source.EvidenceGrade,
		})
	}
	sourceTable := renderTable([]Column{
		{"Provider", 12},
		{"Runtime", 12},
		{"Compat", 10},
		{"Evidence", 22},
	}, sourceRows, -1)

	sections := []string{
		renderSection("Repository actions", m.repositoryActionPanel()),
		renderSection("Repository scopes", m.repositoriesTable(m.rowsThatFit(6, 8), m.selected)),
		renderSection("Telemetry sources", sourceTable),
	}
	return strings.Join(sections, "\n\n")
}

type harnessRow struct {
	name          string
	provider      string
	setup         string
	activity      string
	lastReceiptAt string
	reason        string
	configurable  bool
}

func (m Model) harnessRows() []harnessRow {
	return []harnessRow{
		m.providerHarness("Codex", "codex"),
		m.providerHarness("Claude Code", "claude-code"),
		m.providerHarness("Cursor", "cursor"),
		m.githubCopilotHarness(),
	}
}

func (m Model) providerHarness(name string, provider string) harnessRow {
	status := m.providerStatus(provider)
	if status == nil {
		return harnessRow{name: name, provider: provider, setup: "checking", activity: "checking", reason: "status_refreshing", configurable: true}
	}
	setup := providerSetup(status)
	reason := providerReason(status)
	if reason == "" && status.MeasurementState == "awaiting_receipts" {
		reason = "waiting_for_activity"
	}
	return harnessRow{
		name:          name,
		provider:      provider,
		setup:         setup,
		activity:      status.MeasurementState,
		lastReceiptAt: status.LastReceiptAt,
		reason:        reason,
		configurable:  true,
	}
}

func (m Model) providerStatus(provider string) *agent.ProviderSourceStatus {
	sourceStatus := m.providerStatusFromSources(provider)
	if m.snapshot.Doctor != nil {
		for index := range m.snapshot.Doctor.Facts.SourceStatuses {
			status := &m.snapshot.Doctor.Facts.SourceStatuses[index]
			if status.Provider == provider {
				if transientProviderStatus(status) && sourceStatus != nil {
					return sourceStatus
				}
				return status
			}
		}
	}
	return sourceStatus
}

func transientProviderStatus(status *agent.ProviderSourceStatus) bool {
	if status.ConfigurationState == "unavailable" || status.OwnershipState == "unavailable" {
		return true
	}
	if status.MeasurementState != "unavailable" {
		return false
	}
	return containsText(status.ReasonCodes, "doctor_unavailable") ||
		containsText(status.ReasonCodes, "source_configuration_unavailable")
}

func (m Model) providerStatusFromSources(provider string) *agent.ProviderSourceStatus {
	sources := make([]agent.SourceCapability, 0)
	for _, source := range m.snapshot.Sources {
		if source.Provider == provider {
			sources = append(sources, source)
		}
	}
	if len(sources) == 0 {
		return nil
	}

	lastReceiptAt := ""
	observed := false
	tested := false
	compatibility := "supported"
	for _, source := range sources {
		if source.Compatibility != "" && source.Compatibility != "supported" {
			compatibility = source.Compatibility
		}
		for _, test := range m.snapshot.SourceTests {
			if test.SourceID == source.SourceID {
				tested = true
				observed = observed || test.RuntimeObserved
				lastReceiptAt = maxText(lastReceiptAt, test.LastObservedAt)
			}
		}
	}

	status := &agent.ProviderSourceStatus{
		SchemaVersion:        1,
		Provider:             provider,
		ConfigurationState:   "configured",
		OwnershipState:       "managed_current",
		LogsEnabled:          true,
		TracesEnabled:        true,
		ToolDetailsSupported: true,
		ToolDetailsEnabled:   true,
		LastReceiptAt:        lastReceiptAt,
		MeasurementState:     "complete",
	}
	if compatibility != "supported" {
		status.ConfigurationState = compatibility
		status.MeasurementState = "unavailable"
		status.ReasonCodes = []string{"source_" + compatibility}
		return status
	}
	if observed {
		return status
	}
	if tested {
		status.MeasurementState = "awaiting_receipts"
		status.ReasonCodes = []string{"no_recent_receipt"}
		return status
	}
	status.MeasurementState = "checking"
	return status
}

func (m Model) githubCopilotHarness() harnessRow {
	sources := make([]agent.SourceCapability, 0)
	for _, source := range m.snapshot.Sources {
		if source.Provider == "github-copilot" {
			sources = append(sources, source)
		}
	}
	if len(sources) == 0 {
		return harnessRow{name: "GitHub Copilot", provider: "github-copilot", setup: "not_configured", activity: "unavailable", reason: "source_missing"}
	}

	lastReceiptAt := ""
	observed := false
	compatibility := "configured"
	for _, source := range sources {
		if source.Compatibility != "supported" {
			compatibility = source.Compatibility
		}
		for _, test := range m.snapshot.SourceTests {
			if test.SourceID == source.SourceID {
				observed = observed || test.RuntimeObserved
				lastReceiptAt = maxText(lastReceiptAt, test.LastObservedAt)
			}
		}
	}
	activity := "awaiting_receipts"
	reason := "no_recent_receipt"
	if observed {
		activity = "complete"
		reason = ""
	}
	return harnessRow{
		name:          "GitHub Copilot",
		provider:      "github-copilot",
		setup:         compatibility,
		activity:      activity,
		lastReceiptAt: lastReceiptAt,
		reason:        reason,
	}
}

func (m Model) selectedHarness() (harnessRow, bool) {
	rows := m.harnessRows()
	if m.selected < 0 || m.selected >= len(rows) {
		return harnessRow{}, false
	}
	return rows[m.selected], true
}

func (m Model) harnessActionPanel(rows []harnessRow) string {
	if m.mode == modeHarnessConfirm {
		state := "confirm"
		if m.harnessActive {
			state = "applying"
		}
		name := "-"
		operation := string(m.harnessOperation)
		if m.harnessTarget != nil {
			name = m.harnessTarget.name
		}
		return renderKV([][2]string{
			{"Action", operation + " " + name},
			{"Privacy", "content capture off"},
			{"Confirm", "y / enter"},
			{"State", state},
		})
	}
	if m.harnessResult != nil {
		outcome := m.harnessResult
		if outcome.err != nil {
			return dangerStyle.Render("Harness action failed: " + outcome.err.Error())
		}
		next := "run a fresh task in an enrolled repo"
		if outcome.result.RestartRequired {
			return renderKV([][2]string{
				{"Action", string(outcome.operation) + " " + outcome.name},
				{"Next", "restart harness, run task"},
				{"How", restartInstruction(outcome.provider, outcome.name)},
			})
		}
		return renderKV([][2]string{
			{"Action", string(outcome.operation) + " " + outcome.name},
			{"Status", colorHealth(outcome.result.Status)},
			{"Restart", boolWord(outcome.result.RestartRequired)},
			{"Next", next},
		})
	}
	if m.harnessError != "" {
		return dangerStyle.Render("Harness action unavailable: " + m.harnessError)
	}
	row, ok := m.selectedHarness()
	if !ok {
		return mutedStyle.Render("select a harness")
	}
	next := "c configure | u restore"
	if !row.configurable {
		next = "configure with provider-specific setup"
	}
	if row.setup == "configured" && row.activity == "complete" {
		next = "ready"
	} else if row.setup == "Restart to activate" {
		return renderKV([][2]string{
			{"Selected", row.name},
			{"Next", "restart harness, run task"},
			{"How", restartInstruction(row.provider, row.name)},
		})
	}
	return renderKV([][2]string{
		{"Selected", row.name},
		{"Next", next},
		{"Privacy", "prompt/tool/response content off"},
	})
}

func restartInstruction(provider string, name string) string {
	switch provider {
	case "claude-code":
		return "exit Claude Code, run `claude`"
	case "codex":
		return "exit Codex, run `codex`"
	case "cursor":
		return "restart Cursor"
	default:
		return "exit " + name + ", start it again"
	}
}

func (m Model) harnessReadinessSummary(rows []harnessRow) string {
	ready := 0
	awaiting := 0
	blocked := 0
	lastReceiptAt := ""
	for _, row := range rows {
		lastReceiptAt = maxText(lastReceiptAt, row.lastReceiptAt)
		if row.setup == "configured" || row.setup == "supported" {
			if row.activity == "complete" {
				ready++
			} else {
				awaiting++
			}
			continue
		}
		blocked++
	}
	return renderKV([][2]string{
		{"Receiving", formatCount(int64(ready))},
		{"Awaiting activity", formatCount(int64(awaiting))},
		{"Needs setup", formatCount(int64(blocked))},
		{"Last receipt", relativeTime(lastReceiptAt)},
	})
}

func (m Model) viewRuns() string {
	detail := mutedStyle.Render("(select a run)")
	if m.selected >= 0 && m.selected < len(m.snapshot.Runs) {
		run := m.snapshot.Runs[m.selected]
		detail = renderKV([][2]string{
			{"Run ID", emptyDash(run.RunID)},
			{"Provider", emptyDash(run.Provider)},
			{"Model", emptyDash(run.Model)},
			{"Started", relativeTime(run.StartedAt)},
			{"Ended", relativeTime(run.EndedAt)},
			{"Tokens", formatCount(run.TotalTokens)},
			{"Breakdown", fmt.Sprintf("%s in / %s out / %s cache / %s reason",
				formatCount(run.InputTokens),
				formatCount(run.OutputTokens),
				formatCount(run.CacheReadInputTokens+run.CacheCreationInputTokens),
				formatCount(run.ReasoningOutputTokens),
			)},
			{"Estimated cost", formatNanoUSD(run.EstimatedNanoUSD)},
		})
	}

	return strings.Join([]string{
		renderSection("Recent runs", m.runsTable(m.rowsThatFit(8, 12), m.selected)),
		renderSection("Selected run", detail),
	}, "\n\n")
}

func (m Model) viewAttribution() string {
	limit := m.rowsThatFit(8, 10)
	start := windowStart(m.selected, len(m.snapshot.Attributions), limit)
	rows := make([][]string, 0, limit)
	for index := start; index < len(m.snapshot.Attributions); index++ {
		if index >= start+limit {
			break
		}
		attribution := m.snapshot.Attributions[index]
		rows = append(rows, []string{
			shortID(attribution.CommitHash, 10),
			shortID(attribution.RepoKey, 18),
			formatCount(int64(len(attribution.RunIDs))),
			formatNanoUSD(attribution.EstimatedNanoUSD),
			attribution.CostCoverage,
			colorHealth(attribution.Status),
		})
	}
	table := renderTable([]Column{
		{"Commit", 10},
		{"Repo", 12},
		{"Runs", 4},
		{"Cost", 9},
		{"Coverage", 10},
		{"Status", 10},
	}, rows, m.selected-start)

	detail := mutedStyle.Render("(select an attribution)")
	if m.selected >= 0 && m.selected < len(m.snapshot.Attributions) {
		attribution := m.snapshot.Attributions[m.selected]
		detail = renderKV([][2]string{
			{"Commit", emptyDash(attribution.CommitHash)},
			{"Decision", emptyDash(attribution.Decision)},
			{"Proof", strings.Join(attribution.ProofKinds, ", ")},
			{"Runs", strings.Join(shortList(attribution.RunIDs, 4), ", ")},
			{"Providers", providerCostSummary(attribution.ProviderCosts)},
			{"Meaning", "Estimated AI run cost conservatively attributed to commit"},
		})
	}

	return strings.Join([]string{
		renderSection("Commit cost attribution", table),
		renderSection("Selected attribution", detail),
	}, "\n\n")
}

func (m Model) viewWebhook() string {
	if m.snapshot.Webhook == nil {
		return strings.Join([]string{
			renderSection("Destination", m.webhookActionPanel()),
			renderSection("Webhook", mutedStyle.Render("(webhook status unavailable)")),
		}, "\n\n")
	}
	webhook := m.snapshot.Webhook
	config := renderKV([][2]string{
		{"URL", m.webhookURLDisplay(webhook.URL, 17)},
		{"run.ended", enabledWord(webhook.RunEndedEnabled)},
		{"commit.attributed", colorHealth("always on")},
		{"Bearer token", configuredWord(webhook.BearerTokenConfigured)},
		{"HMAC secret", configuredWord(webhook.HMACSecretConfigured)},
	})
	delivery := renderKV([][2]string{
		{"Queued", formatCount(webhook.QueuedCount)},
		{"Blocked", formatCount(webhook.BlockedCount)},
		{"Delivered", formatCount(webhook.DeliveredCount)},
		{"Oldest queued", relativeTime(webhook.OldestQueuedAt)},
		{"Last delivered", relativeTime(webhook.LastDeliveredAt)},
		{"Last error", emptyDash(webhook.LastErrorCode)},
	})

	rows := make([][]string, 0, len(webhook.BlockedItems)+len(webhook.QueuedItems))
	for _, item := range webhook.BlockedItems {
		rows = append(rows, webhookItemRow(item))
	}
	for _, item := range webhook.QueuedItems {
		rows = append(rows, webhookItemRow(item))
	}
	queue := renderTable([]Column{
		{"Event", 16},
		{"Subject", 12},
		{"State", 10},
		{"Tries", 6},
		{"Queued", 10},
	}, rows, -1)

	return strings.Join([]string{
		renderSection("Destination", m.webhookActionPanel()),
		renderSection("Configuration", config),
		renderSection("Delivery", delivery),
		renderSection("Queued and blocked items", queue),
	}, "\n\n")
}

func (m Model) viewDiagnostics() string {
	diagnostics := m.snapshot.Diagnostics
	if diagnostics == nil {
		return renderSection("Diagnostics", mutedStyle.Render("(diagnostics unavailable)"))
	}
	counters := renderKV([][2]string{
		{"Health", colorHealth(diagnostics.Health)},
		{"Execution", diagnostics.ExecutionEnvironment},
		{"Sources", formatCount(diagnostics.SourceCount)},
		{"Safe observations", formatCount(diagnostics.SafeObservationCount)},
		{"Journal overflows", formatCount(diagnostics.JournalOverflowCount)},
		{"Production runs", formatCount(diagnostics.ProductionRunCount)},
		{"Priced runs", formatCount(diagnostics.PricedRunCount)},
		{"Unpriced runs", formatCount(diagnostics.UnpricedRunCount)},
		{"Repository scopes", formatCount(diagnostics.RepositoryScopeCount)},
		{"Verified attributions", formatCount(diagnostics.VerifiedAttributionCount)},
		{"Budget warnings", formatCount(diagnostics.BudgetWarningCount)},
	})

	eventRows := make([][]string, 0, len(diagnostics.RecentEvents))
	for index, event := range diagnostics.RecentEvents {
		if index >= m.rowsThatFit(6, 13) {
			break
		}
		eventRows = append(eventRows, []string{
			relativeTime(event.ObservedAt),
			event.Severity,
			event.Code,
		})
	}
	events := renderTable([]Column{
		{"Observed", 10},
		{"Level", 8},
		{"Code", 30},
	}, eventRows, m.selected)

	constructRows := make([][]string, 0, min(10, len(diagnostics.ConstructStates)))
	for index, construct := range diagnostics.ConstructStates {
		if index >= 10 {
			break
		}
		constructRows = append(constructRows, []string{
			construct.Construct,
			construct.State,
			colorHealth(construct.Health),
			emptyDash(construct.LastErrorCode),
		})
	}
	constructs := renderTable([]Column{
		{"Construct", 22},
		{"State", 14},
		{"Health", 10},
		{"Error", 12},
	}, constructRows, -1)

	return strings.Join([]string{
		renderSection("Counters", counters),
		renderSection("Recent events", events),
		renderSection("Construct states", constructs),
	}, "\n\n")
}

func (m Model) repositoriesTable(limit int, selected int) string {
	start := windowStart(selected, len(m.snapshot.Repositories), limit)
	rows := make([][]string, 0, min(limit, len(m.snapshot.Repositories)))
	for index := start; index < len(m.snapshot.Repositories); index++ {
		if limit > 0 && index >= start+limit {
			break
		}
		scope := m.snapshot.Repositories[index]
		rows = append(rows, []string{
			scope.Label,
			colorHealth(scope.State),
			emptyDash(scope.Provider),
			relativeTime(scope.LastObservedAt),
			shortID(scope.ScopeID, 12),
		})
	}
	return renderTable([]Column{
		{"Repository", 20},
		{"State", 8},
		{"Provider", 10},
		{"Observed", 10},
	}, rows, selected-start)
}

func (m Model) runsTable(limit int, selected int) string {
	start := windowStart(selected, len(m.snapshot.Runs), limit)
	rows := make([][]string, 0, min(limit, len(m.snapshot.Runs)))
	for index := start; index < len(m.snapshot.Runs); index++ {
		if limit > 0 && index >= start+limit {
			break
		}
		run := m.snapshot.Runs[index]
		rows = append(rows, []string{
			shortID(run.RunID, 10),
			emptyDash(run.Provider),
			formatCount(run.TotalTokens),
			formatNanoUSD(run.EstimatedNanoUSD),
			relativeTime(run.StartedAt),
		})
	}
	return renderTable([]Column{
		{"Run", 10},
		{"Provider", 10},
		{"Tokens", 10},
		{"Cost", 9},
		{"Started", 10},
	}, rows, selected-start)
}

func (m Model) attentionList(limit int) string {
	var lines []string
	if len(m.snapshot.Errors) > 0 {
		for _, err := range m.snapshot.Errors {
			if m.isNonActionableSnapshotError(err) {
				continue
			}
			lines = append(lines, dangerStyle.Render("! "+m.displaySnapshotError(err)))
		}
	}
	if budgets := m.snapshot.Budgets; budgets != nil && len(budgets.Warnings) > 0 {
		lines = append(lines, warningStyle.Render(fmt.Sprintf("! %d budget warning(s)", len(budgets.Warnings))))
	}
	if totals := m.snapshot.Totals; totals != nil && totals.UnpricedRunCount > 0 {
		lines = append(lines, warningStyle.Render(fmt.Sprintf("! %s unpriced run(s)", formatCount(totals.UnpricedRunCount))))
	}
	if webhook := m.snapshot.Webhook; webhook != nil {
		if strings.TrimSpace(webhook.URL) == "" {
			lines = append(lines, warningStyle.Render("! webhook URL not configured (press w)"))
		}
		if webhook.BlockedCount > 0 {
			lines = append(lines, dangerStyle.Render(fmt.Sprintf("! %s blocked webhook delivery item(s)", formatCount(webhook.BlockedCount))))
		} else if webhook.QueuedCount == 0 && strings.TrimSpace(webhook.URL) != "" {
			lines = append(lines, successStyle.Render("ok webhook queue is clear"))
		}
	}
	if len(lines) == 0 {
		lines = append(lines, successStyle.Render("ok no active attention items"))
	}
	if limit > 0 && len(lines) > limit {
		lines = append(lines[:limit], mutedStyle.Render(fmt.Sprintf("+%d more", len(lines)-limit)))
	}
	return strings.Join(lines, "\n")
}

func (m Model) webhookURLOverviewValue() string {
	if m.snapshot.Webhook == nil {
		return "-"
	}
	if strings.TrimSpace(m.snapshot.Webhook.URL) == "" {
		return warningStyle.Render("not configured (w set)")
	}
	return m.webhookURLDisplay(m.snapshot.Webhook.URL, 15)
}

func (m Model) webhookURLDisplay(destination string, labelWidth int) string {
	destination = strings.TrimSpace(destination)
	if destination == "" {
		return mutedStyle.Render("not configured")
	}
	return m.fitKVValue(destination, labelWidth)
}

func (m Model) fitKVValue(value string, labelWidth int) string {
	limit := clampWidth(m.width) - labelWidth - 2
	if limit < 8 {
		limit = 8
	}
	return truncateVisible(value, limit)
}

func (m Model) isNonActionableSnapshotError(message string) bool {
	if isStatusUnavailableMessage(message) {
		return true
	}
	if !isTimeoutSnapshotMessage(message) {
		return false
	}
	return m.snapshot.Status == nil ||
		m.snapshot.Status.Health == "healthy" ||
		m.snapshot.Status.Health == "starting"
}

func (m Model) displaySnapshotError(message string) string {
	if !strings.HasSuffix(message, ": agent_unavailable") {
		if message == "agent_unavailable" {
			return "agent loading or unavailable"
		}
		return message
	}

	section := strings.TrimSuffix(message, ": agent_unavailable")
	if m.snapshot.Status == nil {
		return section + ": agent loading or unavailable"
	}
	if m.snapshot.Status.Health == "starting" {
		return section + ": agent loading (startup in progress)"
	}
	if m.snapshot.Status.RuntimeWarmupState == "starting" {
		return section + ": agent warming up (runtime warmup starting)"
	}
	if m.snapshot.Status.RuntimeWarmupState == "failed" {
		return section + ": agent warmup failed"
	}
	return message
}

func isStatusUnavailableMessage(message string) bool {
	return message == "agent_unavailable" || strings.HasSuffix(message, ": agent_unavailable")
}

func isTimeoutSnapshotMessage(message string) bool {
	return strings.Contains(message, "context deadline exceeded") ||
		strings.Contains(message, "Client.Timeout") ||
		strings.Contains(message, "context cancellation")
}

func (m Model) repositoryActionPanel() string {
	if m.mode == modeEnroll {
		state := "ready"
		if m.enrollActivating {
			state = "submitting"
		}
		rows := [][2]string{
			{"Paths", m.enrollPath + cursorSuffix(m.enrollActivating)},
			{"Provider", "auto"},
			{"Content capture", "off"},
			{"Separator", "comma"},
			{"State", state},
		}
		if m.enrollError != "" {
			rows = append(rows, [2]string{"Error", dangerStyle.Render(m.enrollError)})
		}
		return renderKV(rows)
	}
	if m.mode == modeRemoveConfirm {
		state := "confirm"
		if m.removeActive {
			state = "removing"
		}
		label := "-"
		scopeID := "-"
		if m.removeTarget != nil {
			label = m.removeTarget.Label
			scopeID = m.removeTarget.ScopeID
		}
		return renderKV([][2]string{
			{"Remove", label},
			{"Scope", shortID(scopeID, 14)},
			{"State", state},
			{"Confirm", "y / enter"},
		})
	}
	if len(m.enrollResults) > 0 {
		return m.activationResultsPanel()
	}
	if m.removeResult != nil {
		state := "removed"
		if !m.removeResult.removed {
			state = "not removed"
		}
		return renderKV([][2]string{
			{"Removal", colorHealth(state)},
			{"Repository", emptyDash(m.removeResult.label)},
			{"Scope", shortID(m.removeResult.scopeID, 14)},
		})
	}
	if m.removeError != "" {
		return dangerStyle.Render("Remove failed: " + m.removeError)
	}
	if m.enrollError != "" {
		return dangerStyle.Render("Enrollment failed: " + m.enrollError)
	}
	return mutedStyle.Render("a enroll cwd | p enroll paths | d remove selected")
}

func (m Model) webhookActionPanel() string {
	if m.mode == modeWebhookURL {
		state := "editing"
		if m.webhookActive {
			state = "saving"
		}
		rows := [][2]string{
			{"Destination", m.fitKVValue(m.webhookURL+cursorSuffix(m.webhookActive), 11)},
			{"Submit", "enter"},
			{"State", state},
		}
		if m.webhookError != "" {
			rows = append(rows, [2]string{"Error", dangerStyle.Render(m.webhookError)})
		}
		return renderKV(rows)
	}
	if m.webhookResult != nil {
		outcome := m.webhookResult
		if outcome.err != nil {
			return dangerStyle.Render("Webhook URL update failed: " + outcome.err.Error())
		}
		destination := outcome.result.URL
		if strings.TrimSpace(destination) == "" {
			destination = outcome.url
		}
		return renderKV([][2]string{
			{"Destination", m.webhookURLDisplay(destination, 11)},
			{"Status", colorHealth("configured")},
		})
	}
	if m.webhookError != "" {
		return dangerStyle.Render("Webhook URL unavailable: " + m.webhookError)
	}
	if m.snapshot.Webhook == nil {
		return mutedStyle.Render("w set webhook URL")
	}
	if strings.TrimSpace(m.snapshot.Webhook.URL) == "" {
		return renderKV([][2]string{
			{"Destination", mutedStyle.Render("not configured")},
			{"Next", "w set webhook URL"},
		})
	}
	return renderKV([][2]string{
		{"Destination", m.webhookURLDisplay(m.snapshot.Webhook.URL, 11)},
		{"Next", "w edit webhook URL"},
	})
}

func (m Model) activationResultsPanel() string {
	successes := 0
	failures := 0
	var lastSuccess *activationOutcome
	for index := range m.enrollResults {
		outcome := &m.enrollResults[index]
		if outcome.err != nil {
			failures++
			continue
		}
		successes++
		lastSuccess = outcome
	}
	rows := [][2]string{
		{"Activated", fmt.Sprintf("%d/%d", successes, len(m.enrollResults))},
		{"Failed", formatCount(int64(failures))},
	}
	if lastSuccess != nil {
		result := lastSuccess.result
		rows := [][2]string{
			{"Activated", fmt.Sprintf("%d/%d", successes, len(m.enrollResults))},
			{"Failed", formatCount(int64(failures))},
			{"Last state", colorHealth(result.ActivationState)},
			{"Repository", emptyDash(result.RepositoryScope.Label)},
			{"Provider", emptyDash(result.Provider)},
			{"Telemetry", sourceMeasurementState(result.SourceStatus)},
			{"Restart", boolWord(result.RestartRequired)},
		}
		if len(result.ReasonCodes) > 0 {
			rows = append(rows, [2]string{"Reason", strings.Join(shortList(result.ReasonCodes, 3), ", ")})
		}
		return renderKV(rows)
	}
	for _, outcome := range m.enrollResults {
		if outcome.err != nil {
			rows = append(rows, [2]string{"Error", dangerStyle.Render(outcome.err.Error())})
			break
		}
	}
	return renderKV(rows)
}

func cursorSuffix(disabled bool) string {
	if disabled {
		return ""
	}
	return "_"
}

func sourceMeasurementState(status *agent.ProviderSourceStatus) string {
	if status == nil {
		return "-"
	}
	return colorHealth(status.MeasurementState)
}

func (m Model) rowsThatFit(maxRows int, reservedLines int) int {
	available := m.bodyLineBudget() - reservedLines
	if available < 1 {
		available = 1
	}
	return min(maxRows, available)
}

func windowStart(selected int, total int, limit int) int {
	if limit <= 0 || total <= limit || selected < limit {
		return 0
	}
	start := selected - limit + 1
	return min(start, max(0, total-limit))
}

func statusValue(status *agent.Status, pick func(*agent.Status) string) string {
	if status == nil {
		return "-"
	}
	return emptyDash(pick(status))
}

func otlpValue(status *agent.Status) string {
	if status == nil || status.OTLP == nil {
		return "-"
	}
	return fmt.Sprintf("%s:%d", status.OTLP.Host, status.OTLP.Port)
}

func emptyDash(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}

func providerSetup(status *agent.ProviderSourceStatus) string {
	if status.ConfigurationState == "partial" &&
		status.LogsEnabled &&
		status.TracesEnabled &&
		status.ToolDetailsEnabled &&
		onlyNonBlockingProviderReasons(status.ReasonCodes) {
		if status.MeasurementState == "awaiting_receipts" && containsText(status.ReasonCodes, "no_recent_receipt") {
			return "Restart to activate"
		}
		return "configured"
	}
	if status.ConfigurationState == "configured" &&
		status.MeasurementState == "awaiting_receipts" &&
		containsText(status.ReasonCodes, "no_recent_receipt") {
		return "Restart to activate"
	}
	return status.ConfigurationState
}

func providerReason(status *agent.ProviderSourceStatus) string {
	for _, reason := range status.ReasonCodes {
		if !nonBlockingProviderReason(reason) {
			return reason
		}
	}
	if containsText(status.ReasonCodes, "no_recent_receipt") {
		return "no_recent_receipt"
	}
	return ""
}

func onlyNonBlockingProviderReasons(reasons []string) bool {
	if len(reasons) == 0 {
		return false
	}
	for _, reason := range reasons {
		if !nonBlockingProviderReason(reason) {
			return false
		}
	}
	return true
}

func nonBlockingProviderReason(reason string) bool {
	switch reason {
	case "tool_content_disabled", "response_content_disabled", "no_recent_receipt":
		return true
	default:
		return false
	}
}

func containsText(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func maxText(left string, right string) string {
	if right > left {
		return right
	}
	return left
}

func enabledWord(value bool) string {
	if value {
		return colorHealth("enabled")
	}
	return mutedStyle.Render("disabled")
}

func configuredWord(value bool) string {
	if value {
		return colorHealth("configured")
	}
	return mutedStyle.Render("not configured")
}

func webhookItemRow(item agent.WebhookDeliveryItem) []string {
	return []string{
		item.EventType,
		shortID(item.SubjectID, 12),
		colorHealth(item.DeliveryState),
		formatCount(item.Attempts),
		relativeTime(item.QueuedAt),
	}
}

func providerCostSummary(costs []agent.ProviderCost) string {
	if len(costs) == 0 {
		return "n/a"
	}
	parts := make([]string, 0, len(costs))
	for _, cost := range costs {
		parts = append(parts, fmt.Sprintf("%s: %s (%s query)", cost.Provider, formatNanoUSD(cost.EstimatedNanoUSD), formatCount(cost.QueryCount)))
	}
	return strings.Join(parts, ", ")
}

func shortList(values []string, limit int) []string {
	if len(values) == 0 {
		return []string{"-"}
	}
	out := make([]string, 0, min(limit, len(values))+1)
	for index, value := range values {
		if index >= limit {
			out = append(out, fmt.Sprintf("+%d more", len(values)-limit))
			break
		}
		out = append(out, shortID(value, 12))
	}
	return out
}
