package tui

import (
	"context"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/altagar-asaf/tirion/packages/tirion-tui/internal/agent"
)

func TestViewFitsCompactTerminal(t *testing.T) {
	cost := int64(123456789)
	model := NewModel(nil)
	model.width = 64
	model.height = 14
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "healthy",
			AgentVersion:       "0.1.6",
			RuntimeWarmupState: "ready",
		},
		Totals: &agent.Totals{
			RunCount:         12,
			TotalTokens:      345678,
			EstimatedNanoUSD: cost,
		},
		Runs: []agent.Run{
			{RunID: "run_123456789", Provider: "codex", TotalTokens: 12345, EstimatedNanoUSD: &cost, StartedAt: "2026-06-29T09:00:00Z"},
			{RunID: "run_abcdefghi", Provider: "codex", TotalTokens: 23456, EstimatedNanoUSD: &cost, StartedAt: "2026-06-29T09:01:00Z"},
			{RunID: "run_jklmnopqr", Provider: "claude-code", TotalTokens: 34567, EstimatedNanoUSD: &cost, StartedAt: "2026-06-29T09:02:00Z"},
		},
	}

	view := model.View()
	lines := strings.Split(strings.TrimRight(view, "\n"), "\n")
	if len(lines) > model.height {
		t.Fatalf("view rendered %d lines, want <= %d:\n%s", len(lines), model.height, view)
	}
	for index, line := range lines {
		if visibleLen(line) > model.width {
			t.Fatalf("line %d width = %d, want <= %d: %q", index, visibleLen(line), model.width, line)
		}
	}
}

func TestStatusMessagePaintsOverviewBeforeFullSnapshot(t *testing.T) {
	model := NewModel(nil)
	updated, _ := model.Update(fetchedStatusMsg{
		status: &agent.Status{
			Health:             "healthy",
			AgentVersion:       "0.1.6",
			RuntimeWarmupState: "starting",
		},
		at: time.Now(),
	})
	model = updated.(Model)

	view := model.View()
	if !strings.Contains(view, "healthy") || !strings.Contains(view, "starting") {
		t.Fatalf("status did not paint immediately:\n%s", view)
	}
}

func TestEnrollmentSubmitsExplicitPath(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.tab = tabIndex("Repos")
	model.beginEnrollment("")

	updated, cmd := model.updateEnroll(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/tmp/repo")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("typing path returned command")
	}
	updated, cmd = model.updateEnroll(tea.KeyMsg{Type: tea.KeyEnter})
	model = updated.(Model)
	if cmd == nil {
		t.Fatalf("submit returned nil command")
	}

	message := cmd()
	updated, _ = model.Update(message)
	model = updated.(Model)

	if strings.Join(client.activatedPaths, ",") != "/tmp/repo" {
		t.Fatalf("activated paths = %#v", client.activatedPaths)
	}
	if model.mode != modeNormal {
		t.Fatalf("mode = %v", model.mode)
	}
	if len(model.enrollResults) != 1 || model.enrollResults[0].result.RepositoryScope.Label != "repo" {
		t.Fatalf("missing activation result: %#v", model.enrollResults)
	}
}

func TestEnrollmentSubmitsMultipleExplicitPaths(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.tab = tabIndex("Repos")
	model.beginEnrollment("")

	updated, cmd := model.updateEnroll(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/tmp/one, /tmp/two")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("typing paths returned command")
	}
	updated, cmd = model.updateEnroll(tea.KeyMsg{Type: tea.KeyEnter})
	model = updated.(Model)
	if cmd == nil {
		t.Fatalf("submit returned nil command")
	}

	message := cmd()
	updated, _ = model.Update(message)
	model = updated.(Model)

	if strings.Join(client.activatedPaths, ",") != "/tmp/one,/tmp/two" {
		t.Fatalf("activated paths = %#v", client.activatedPaths)
	}
	if len(model.enrollResults) != 2 {
		t.Fatalf("result count = %d", len(model.enrollResults))
	}
}

func TestAddRepositoryAvailableOutsideReposTab(t *testing.T) {
	model := NewModel(&fakeClient{})
	model.tab = 0

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("p")})
	model = updated.(Model)

	if cmd != nil {
		t.Fatalf("opening enrollment returned command")
	}
	if model.mode != modeEnroll {
		t.Fatalf("mode = %v", model.mode)
	}
	if model.tab != tabIndex("Repos") {
		t.Fatalf("tab = %d", model.tab)
	}
}

func TestRemoveRepositoryRequiresConfirmation(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.tab = tabIndex("Repos")
	model.snapshot.Repositories = []agent.RepositoryScope{{
		SchemaVersion: 1,
		ScopeID:       "scope_1",
		Label:         "repo",
		State:         "active",
	}}

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("d")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("opening remove confirmation returned command")
	}
	if model.mode != modeRemoveConfirm {
		t.Fatalf("mode = %v", model.mode)
	}

	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	model = updated.(Model)
	if cmd == nil {
		t.Fatalf("confirm returned nil command")
	}
	message := cmd()
	updated, _ = model.Update(message)
	model = updated.(Model)

	if client.removedScopeID != "scope_1" {
		t.Fatalf("removed scope = %q", client.removedScopeID)
	}
	if model.removeResult == nil || !model.removeResult.removed {
		t.Fatalf("remove result = %#v", model.removeResult)
	}
}

func TestHarnessViewShowsSetupAndActivity(t *testing.T) {
	model := NewModel(nil)
	model.width = 64
	model.height = 16
	model.tab = tabIndex("Harnesses")
	model.snapshot = agent.Snapshot{
		Doctor: &agent.Doctor{
			Facts: agent.DoctorFacts{
				SourceStatuses: []agent.ProviderSourceStatus{
					{Provider: "codex", ConfigurationState: "configured", MeasurementState: "complete", LastReceiptAt: "2026-06-29T09:00:00Z"},
					{Provider: "claude-code", ConfigurationState: "not_configured", MeasurementState: "unavailable", ReasonCodes: []string{"hooks_missing"}},
					{Provider: "cursor", ConfigurationState: "configured", MeasurementState: "awaiting_receipts", ReasonCodes: []string{"no_recent_receipt"}},
				},
			},
		},
		Sources: []agent.SourceCapability{{
			SourceID:      "github-copilot-spans",
			Provider:      "github-copilot",
			Compatibility: "supported",
		}},
		SourceTests: []agent.SourceTest{{
			SourceID:        "github-copilot-spans",
			RuntimeObserved: true,
			LastObservedAt:  "2026-06-29T09:01:00Z",
			Compatibility:   "supported",
		}},
	}

	view := model.View()
	for _, want := range []string{"Codex", "Claude Code", "Cursor", "GitHub Copilot"} {
		if !strings.Contains(view, want) {
			t.Fatalf("view missing %q:\n%s", want, view)
		}
	}
	rows := model.harnessRows()
	if rows[1].reason != "hooks_missing" {
		t.Fatalf("Claude reason = %q", rows[1].reason)
	}
	for index, line := range strings.Split(strings.TrimRight(view, "\n"), "\n") {
		if visibleLen(line) > model.width {
			t.Fatalf("line %d width = %d, want <= %d: %q", index, visibleLen(line), model.width, line)
		}
	}
}

func TestHarnessViewTreatsPrivacyClosedClaudeContentAsConfigured(t *testing.T) {
	model := NewModel(nil)
	model.width = 64
	model.height = 18
	model.tab = tabIndex("Harnesses")
	model.selected = 1
	model.snapshot = agent.Snapshot{
		Doctor: &agent.Doctor{
			Facts: agent.DoctorFacts{
				SourceStatuses: []agent.ProviderSourceStatus{
					{
						Provider:               "claude-code",
						ConfigurationState:     "partial",
						MeasurementState:       "awaiting_receipts",
						LogsEnabled:            true,
						TracesEnabled:          true,
						ToolDetailsEnabled:     true,
						ToolContentEnabled:     false,
						ResponseContentEnabled: false,
						ReasonCodes:            []string{"tool_content_disabled", "response_content_disabled", "no_recent_receipt"},
					},
				},
			},
		},
	}

	view := model.View()
	if !strings.Contains(view, "Claude Code") || !strings.Contains(view, "configured") {
		t.Fatalf("Claude setup was not shown as configured:\n%s", view)
	}
	if strings.Contains(view, "tool_content") || strings.Contains(view, "response_content") {
		t.Fatalf("privacy-closed content state shown as repair reason:\n%s", view)
	}
	if !strings.Contains(view, "Restart to activate") {
		t.Fatalf("restart setup state missing:\n%s", view)
	}
	if !strings.Contains(view, "restart harness, run task") {
		t.Fatalf("next action missing:\n%s", view)
	}
	if !strings.Contains(view, "exit Claude Code, run `claude`") {
		t.Fatalf("restart guidance missing:\n%s", view)
	}
	row, ok := model.selectedHarness()
	if !ok || row.reason != "no_recent_receipt" {
		t.Fatalf("selected harness reason = %#v, ok = %v", row.reason, ok)
	}
}

func TestHarnessViewFallsBackToRegisteredSourcesWhenDoctorUnavailable(t *testing.T) {
	model := NewModel(nil)
	model.tab = tabIndex("Harnesses")
	model.snapshot = agent.Snapshot{
		Sources: []agent.SourceCapability{
			{
				SourceID:      "otlp_codex_traces",
				Provider:      "codex",
				Compatibility: "supported",
			},
			{
				SourceID:      "otlp_claude_code_traces",
				Provider:      "claude-code",
				Compatibility: "supported",
			},
		},
		SourceTests: []agent.SourceTest{
			{
				SourceID:        "otlp_codex_traces",
				RuntimeObserved: true,
				LastObservedAt:  "2026-06-29T09:00:00Z",
				Compatibility:   "supported",
			},
			{
				SourceID:      "otlp_claude_code_traces",
				Compatibility: "supported",
			},
		},
	}

	rows := model.harnessRows()
	if rows[0].setup != "configured" || rows[0].activity != "complete" || rows[0].reason != "" {
		t.Fatalf("Codex fallback row = %#v", rows[0])
	}
	if rows[1].setup != "Restart to activate" || rows[1].activity != "awaiting_receipts" || rows[1].reason != "no_recent_receipt" {
		t.Fatalf("Claude fallback row = %#v", rows[1])
	}
	view := model.View()
	if strings.Contains(view, "doctor_u") {
		t.Fatalf("doctor unavailable leaked into harness view:\n%s", view)
	}
}

func TestHarnessViewShowsCheckingWhileSourceMetadataLoads(t *testing.T) {
	model := NewModel(nil)
	model.tab = tabIndex("Harnesses")
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "healthy",
			RuntimeWarmupState: "starting",
		},
	}

	rows := model.harnessRows()
	if rows[0].setup != "checking" || rows[0].activity != "checking" || rows[0].reason != "status_refreshing" {
		t.Fatalf("Codex loading row = %#v", rows[0])
	}
	if rows[1].setup != "checking" || rows[1].activity != "checking" || rows[1].reason != "status_refreshing" {
		t.Fatalf("Claude loading row = %#v", rows[1])
	}
	view := model.View()
	if strings.Contains(view, "doctor_u") {
		t.Fatalf("loading harness view looked unavailable:\n%s", view)
	}
}

func TestHarnessViewUsesRegisteredSourcesBeforeSourceTestsFinish(t *testing.T) {
	model := NewModel(nil)
	model.tab = tabIndex("Harnesses")
	model.snapshot = agent.Snapshot{
		Sources: []agent.SourceCapability{
			{
				SourceID:      "otlp_codex_traces",
				Provider:      "codex",
				Compatibility: "supported",
			},
		},
	}

	rows := model.harnessRows()
	if rows[0].setup != "configured" || rows[0].activity != "checking" || rows[0].reason != "" {
		t.Fatalf("Codex registered-source row = %#v", rows[0])
	}
}

func TestHarnessViewPrefersSourcesOverTransientDoctorUnavailable(t *testing.T) {
	model := NewModel(nil)
	model.tab = tabIndex("Harnesses")
	model.snapshot = agent.Snapshot{
		Doctor: &agent.Doctor{
			Facts: agent.DoctorFacts{
				SourceStatuses: []agent.ProviderSourceStatus{
					{
						Provider:           "codex",
						ConfigurationState: "unavailable",
						OwnershipState:     "unavailable",
						MeasurementState:   "unavailable",
						ReasonCodes:        []string{"doctor_unavailable"},
					},
				},
			},
		},
		Sources: []agent.SourceCapability{
			{
				SourceID:      "otlp_codex_logs",
				Provider:      "codex",
				Compatibility: "supported",
			},
		},
		SourceTests: []agent.SourceTest{
			{
				SourceID:        "otlp_codex_logs",
				RuntimeObserved: true,
				LastObservedAt:  "2026-06-30T07:19:51Z",
				Compatibility:   "supported",
			},
		},
	}

	rows := model.harnessRows()
	if rows[0].setup != "configured" || rows[0].activity != "complete" || rows[0].reason != "" {
		t.Fatalf("Codex row used transient doctor status instead of sources: %#v", rows[0])
	}
	view := model.View()
	if strings.Contains(view, "doctor_u") {
		t.Fatalf("doctor unavailable leaked into harness view:\n%s", view)
	}
}

func TestHarnessConfigureRequiresConfirmation(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.tab = tabIndex("Harnesses")
	model.snapshot = harnessSnapshot()

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("opening harness confirmation returned command")
	}
	if model.mode != modeHarnessConfirm {
		t.Fatalf("mode = %v", model.mode)
	}

	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	model = updated.(Model)
	if cmd == nil {
		t.Fatalf("confirm returned nil command")
	}
	message := cmd()
	updated, fetchCmd := model.Update(message)
	model = updated.(Model)
	if fetchCmd == nil {
		t.Fatalf("harness action did not refresh snapshot")
	}

	if client.configuredProvider != "codex" {
		t.Fatalf("configured provider = %q", client.configuredProvider)
	}
	if model.harnessResult == nil || model.harnessResult.result.Status != "configured" {
		t.Fatalf("harness result = %#v", model.harnessResult)
	}
	view := model.View()
	if !strings.Contains(view, "restart harness, run task") || !strings.Contains(view, "exit Codex, run `codex`") {
		t.Fatalf("restart guidance missing after configure:\n%s", view)
	}
}

func TestCursorHarnessConfigureRequiresConfirmation(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.tab = tabIndex("Harnesses")
	model.selected = 2
	model.snapshot = harnessSnapshot()

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("opening Cursor harness confirmation returned command")
	}
	if model.mode != modeHarnessConfirm {
		t.Fatalf("mode = %v", model.mode)
	}

	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	model = updated.(Model)
	if cmd == nil {
		t.Fatalf("confirm returned nil command")
	}
	message := cmd()
	updated, fetchCmd := model.Update(message)
	model = updated.(Model)
	if fetchCmd == nil {
		t.Fatalf("harness action did not refresh snapshot")
	}

	if client.configuredProvider != "cursor" {
		t.Fatalf("configured provider = %q", client.configuredProvider)
	}
	if model.harnessResult == nil || model.harnessResult.result.Status != "configured" {
		t.Fatalf("harness result = %#v", model.harnessResult)
	}
	view := model.View()
	if !strings.Contains(view, "restart harness, run task") || !strings.Contains(view, "restart Cursor") {
		t.Fatalf("restart guidance missing after Cursor configure:\n%s", view)
	}
}

func TestHarnessResultClearsWhenSelectingAnotherHarness(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.tab = tabIndex("Harnesses")
	model.snapshot = harnessSnapshot()

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})
	model = updated.(Model)
	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	model = updated.(Model)
	message := cmd()
	updated, _ = model.Update(message)
	model = updated.(Model)
	if model.harnessResult == nil {
		t.Fatalf("expected harness result")
	}

	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyDown})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("moving selection returned command")
	}
	if model.selected != 1 {
		t.Fatalf("selected = %d", model.selected)
	}
	if model.harnessResult != nil {
		t.Fatalf("harness result was not cleared: %#v", model.harnessResult)
	}
	view := model.View()
	if strings.Contains(view, "configure Codex") {
		t.Fatalf("stale Codex action remains visible:\n%s", view)
	}
	if !strings.Contains(view, "Selected") || !strings.Contains(view, "Claude Code") {
		t.Fatalf("Claude Code selection not visible:\n%s", view)
	}

	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})
	model = updated.(Model)
	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	model = updated.(Model)
	message = cmd()
	updated, _ = model.Update(message)
	model = updated.(Model)
	if client.configuredProvider != "claude-code" {
		t.Fatalf("configured provider = %q", client.configuredProvider)
	}
}

func TestHarnessRestoreRequiresConfirmation(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.tab = tabIndex("Harnesses")
	model.selected = 1
	model.snapshot = harnessSnapshot()

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("u")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("opening harness restore returned command")
	}
	if model.mode != modeHarnessConfirm {
		t.Fatalf("mode = %v", model.mode)
	}

	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	model = updated.(Model)
	if cmd == nil {
		t.Fatalf("confirm returned nil command")
	}
	message := cmd()
	updated, _ = model.Update(message)
	model = updated.(Model)

	if client.restoredProvider != "claude-code" {
		t.Fatalf("restored provider = %q", client.restoredProvider)
	}
	if model.harnessResult == nil || model.harnessResult.result.Status != "restored" {
		t.Fatalf("harness result = %#v", model.harnessResult)
	}
}

func TestOverviewShowsWebhookURLAndMissingURLCommand(t *testing.T) {
	model := NewModel(nil)
	model.width = 72
	model.height = 18
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "healthy",
			RuntimeWarmupState: "ready",
		},
		Webhook: &agent.WebhookStatus{
			SchemaVersion: 1,
			URL:           "https://hooks.example.test/tirion",
		},
	}

	view := model.View()
	if !strings.Contains(view, "https://hooks.example.test/tirion") {
		t.Fatalf("overview did not show webhook URL:\n%s", view)
	}

	model.snapshot.Webhook.URL = ""
	view = model.View()
	if !strings.Contains(view, "not configured") || !strings.Contains(view, "press w") {
		t.Fatalf("overview did not guide webhook URL setup:\n%s", view)
	}
}

func TestWebhookURLCommandSubmitsDestination(t *testing.T) {
	client := &fakeClient{}
	model := NewModel(client)
	model.snapshot.Webhook = &agent.WebhookStatus{SchemaVersion: 1}

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("opening webhook URL entry returned command")
	}
	if model.mode != modeWebhookURL || model.tab != tabIndex("Webhook") {
		t.Fatalf("mode = %v tab = %d", model.mode, model.tab)
	}

	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("https://hooks.example.test/tirion")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("typing webhook URL returned command")
	}
	updated, cmd = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	model = updated.(Model)
	if cmd == nil {
		t.Fatalf("saving webhook URL returned nil command")
	}

	message := cmd()
	updated, fetchCmd := model.Update(message)
	model = updated.(Model)
	if fetchCmd == nil {
		t.Fatalf("webhook URL update did not refresh snapshot")
	}
	if client.webhookURL != "https://hooks.example.test/tirion" {
		t.Fatalf("webhook URL = %q", client.webhookURL)
	}
	if model.webhookResult == nil || model.webhookResult.result.URL != client.webhookURL {
		t.Fatalf("webhook result = %#v", model.webhookResult)
	}
}

func TestAttentionNamesWarmupInsteadOfRawAgentUnavailable(t *testing.T) {
	model := NewModel(nil)
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "healthy",
			RuntimeWarmupState: "starting",
		},
		Errors: []string{
			"repositories: agent_unavailable",
			"sources: agent_unavailable",
			"runs: agent_unavailable",
		},
	}

	view := model.View()
	if !strings.Contains(view, "ok no active attention items") {
		t.Fatalf("warmup should not create attention:\n%s", view)
	}
	if strings.Contains(view, "agent_unavailable") {
		t.Fatalf("raw agent_unavailable was shown:\n%s", view)
	}
	if strings.Contains(view, "! repositories") || strings.Contains(view, "! sources") || strings.Contains(view, "! runs") {
		t.Fatalf("warmup was rendered as an alert:\n%s", view)
	}
}

func TestAttentionNamesStartupWhenStatusIsStarting(t *testing.T) {
	model := NewModel(nil)
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "starting",
			RuntimeWarmupState: "starting",
		},
		Errors: []string{"runs: agent_unavailable"},
	}

	view := model.View()
	if !strings.Contains(view, "ok no active attention items") {
		t.Fatalf("startup should not create attention:\n%s", view)
	}
	if strings.Contains(view, "! runs") {
		t.Fatalf("startup was rendered as an alert:\n%s", view)
	}
}

func TestAttentionTreatsDiagnosticsTimeoutAsDeferred(t *testing.T) {
	model := NewModel(nil)
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "healthy",
			RuntimeWarmupState: "starting",
		},
		Errors: []string{"diagnostics: context deadline exceeded (Client.Timeout or context cancellation while reading body)"},
	}

	view := model.View()
	if !strings.Contains(view, "ok no active attention items") {
		t.Fatalf("deferred diagnostics should not create attention:\n%s", view)
	}
	if strings.Contains(view, "! diagnostics") {
		t.Fatalf("diagnostics timeout was rendered as an alert:\n%s", view)
	}
}

func TestRefreshKeepsLastGoodSnapshotThroughTransientStatusMiss(t *testing.T) {
	model := NewModel(nil)
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "healthy",
			AgentVersion:       "0.1.6",
			RuntimeWarmupState: "starting",
		},
		Totals: &agent.Totals{
			RunCount:    78,
			TotalTokens: 55311265,
		},
	}

	updated, _ := model.Update(fetchedSnapshotMsg{
		snapshot: agent.Snapshot{
			Errors: []string{"status: agent_unavailable"},
		},
		at: time.Now(),
	})
	model = updated.(Model)

	view := model.View()
	if !strings.Contains(view, "55,311,265") || strings.Contains(view, "unknown") || strings.Contains(view, "! status") {
		t.Fatalf("transient status miss replaced stable snapshot:\n%s", view)
	}
}

func TestRefreshKeepsHarnessSourcesThroughPartialTimeout(t *testing.T) {
	model := NewModel(nil)
	model.tab = tabIndex("Harnesses")
	model.snapshot = agent.Snapshot{
		Status: &agent.Status{
			Health:             "healthy",
			AgentVersion:       "0.1.6",
			RuntimeWarmupState: "starting",
		},
		Sources: []agent.SourceCapability{
			{
				SourceID:      "otlp_codex_logs",
				Provider:      "codex",
				Compatibility: "supported",
			},
		},
		SourceTests: []agent.SourceTest{
			{
				SourceID:        "otlp_codex_logs",
				RuntimeObserved: true,
				LastObservedAt:  "2026-06-30T07:19:51Z",
				Compatibility:   "supported",
			},
		},
	}

	updated, _ := model.Update(fetchedSnapshotMsg{
		snapshot: agent.Snapshot{
			Status: &agent.Status{
				Health:             "healthy",
				AgentVersion:       "0.1.6",
				RuntimeWarmupState: "starting",
			},
			Errors: []string{
				"doctor: context deadline exceeded",
				"sources: context deadline exceeded",
			},
		},
		at: time.Now(),
	})
	model = updated.(Model)

	rows := model.harnessRows()
	if rows[0].setup != "configured" || rows[0].activity != "complete" || rows[0].reason != "" {
		t.Fatalf("Codex row lost cached source state after partial timeout: %#v", rows[0])
	}
	view := model.View()
	if strings.Contains(view, "doctor_u") {
		t.Fatalf("partial timeout leaked unavailable harness state:\n%s", view)
	}
}

func TestCopilotHarnessRequiresProviderSpecificSetup(t *testing.T) {
	model := NewModel(&fakeClient{})
	model.tab = tabIndex("Harnesses")
	model.selected = 3
	model.snapshot = harnessSnapshot()

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})
	model = updated.(Model)
	if cmd != nil {
		t.Fatalf("copilot configure returned command")
	}
	if model.mode != modeNormal {
		t.Fatalf("mode = %v", model.mode)
	}
	if model.harnessError != "configure_with_provider_specific_setup" {
		t.Fatalf("harness error = %q", model.harnessError)
	}
}

func harnessSnapshot() agent.Snapshot {
	return agent.Snapshot{
		Doctor: &agent.Doctor{
			Facts: agent.DoctorFacts{
				SourceStatuses: []agent.ProviderSourceStatus{
					{Provider: "codex", ConfigurationState: "not_configured", MeasurementState: "unavailable", ReasonCodes: []string{"logs_missing"}},
					{Provider: "claude-code", ConfigurationState: "partial", MeasurementState: "awaiting_receipts", ReasonCodes: []string{"tool_details_disabled"}},
					{Provider: "cursor", ConfigurationState: "not_configured", MeasurementState: "unavailable", ReasonCodes: []string{"hooks_missing"}},
				},
			},
		},
		Sources: []agent.SourceCapability{{
			SourceID:      "github-copilot-spans",
			Provider:      "github-copilot",
			Compatibility: "supported",
		}},
		SourceTests: []agent.SourceTest{{
			SourceID:        "github-copilot-spans",
			RuntimeObserved: true,
			LastObservedAt:  "2026-06-29T09:01:00Z",
			Compatibility:   "supported",
		}},
	}
}

type fakeClient struct {
	activatedPaths     []string
	removedScopeID     string
	configuredProvider string
	restoredProvider   string
	webhookURL         string
}

func (f *fakeClient) FetchStatus(ctx context.Context) (*agent.Status, error) {
	return &agent.Status{Health: "healthy", RuntimeWarmupState: "ready"}, nil
}

func (f *fakeClient) FetchSnapshot(ctx context.Context) agent.Snapshot {
	return agent.Snapshot{}
}

func (f *fakeClient) ActivateRepository(ctx context.Context, path string) (agent.RepositoryActivation, error) {
	f.activatedPaths = append(f.activatedPaths, path)
	return agent.RepositoryActivation{
		SchemaVersion:   1,
		ActivationState: "ready",
		RepositoryScope: agent.RepositoryScope{
			SchemaVersion: 1,
			ScopeID:       "scope_1",
			Label:         "repo",
			State:         "active",
		},
		Provider: "codex",
	}, nil
}

func (f *fakeClient) RemoveRepository(ctx context.Context, scopeID string) (agent.RepositoryRemoval, error) {
	f.removedScopeID = scopeID
	return agent.RepositoryRemoval{SchemaVersion: 1, Removed: true}, nil
}

func (f *fakeClient) ConfigureProvider(ctx context.Context, provider string) (agent.ProviderConfiguration, error) {
	f.configuredProvider = provider
	return agent.ProviderConfiguration{SchemaVersion: 1, Provider: provider, Status: "configured", RestartRequired: true}, nil
}

func (f *fakeClient) RestoreProvider(ctx context.Context, provider string) (agent.ProviderConfiguration, error) {
	f.restoredProvider = provider
	return agent.ProviderConfiguration{SchemaVersion: 1, Provider: provider, Status: "restored"}, nil
}

func (f *fakeClient) SetWebhookURL(ctx context.Context, destination string) (agent.WebhookStatus, error) {
	f.webhookURL = destination
	return agent.WebhookStatus{
		SchemaVersion:           1,
		URL:                     destination,
		RunEndedEnabled:         true,
		CommitAttributedEnabled: true,
	}, nil
}
