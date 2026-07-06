package tui

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/altagar-asaf/tirion/packages/tirion-tui/internal/agent"
)

type snapshotClient interface {
	FetchStatus(ctx context.Context) (*agent.Status, error)
	FetchSnapshot(ctx context.Context) agent.Snapshot
	ActivateRepository(ctx context.Context, path string) (agent.RepositoryActivation, error)
	RemoveRepository(ctx context.Context, scopeID string) (agent.RepositoryRemoval, error)
	ConfigureProvider(ctx context.Context, provider string) (agent.ProviderConfiguration, error)
	RestoreProvider(ctx context.Context, provider string) (agent.ProviderConfiguration, error)
	SetWebhookURL(ctx context.Context, destination string) (agent.WebhookStatus, error)
}

type Model struct {
	client           snapshotClient
	snapshot         agent.Snapshot
	fetchedAt        time.Time
	loading          bool
	tab              int
	selected         int
	width            int
	height           int
	mode             uiMode
	cwd              string
	enrollPath       string
	enrollActivating bool
	enrollResults    []activationOutcome
	enrollError      string
	removeTarget     *agent.RepositoryScope
	removeActive     bool
	removeResult     *repositoryRemovalOutcome
	removeError      string
	harnessTarget    *harnessRow
	harnessOperation harnessOperation
	harnessActive    bool
	harnessResult    *harnessOutcome
	harnessError     string
	webhookURL       string
	webhookActive    bool
	webhookResult    *webhookOutcome
	webhookError     string
}

type fetchedSnapshotMsg struct {
	snapshot agent.Snapshot
	at       time.Time
}

type fetchedStatusMsg struct {
	status *agent.Status
	err    error
	at     time.Time
}

type refreshTickMsg time.Time

type activationMsg struct {
	outcomes []activationOutcome
}

type activationOutcome struct {
	path   string
	result agent.RepositoryActivation
	err    error
}

type repositoryRemovalMsg struct {
	outcome repositoryRemovalOutcome
}

type repositoryRemovalOutcome struct {
	scopeID string
	label   string
	removed bool
	err     error
}

type harnessMsg struct {
	outcome harnessOutcome
}

type webhookMsg struct {
	outcome webhookOutcome
}

type harnessOutcome struct {
	provider  string
	name      string
	operation harnessOperation
	result    agent.ProviderConfiguration
	err       error
}

type webhookOutcome struct {
	url    string
	result agent.WebhookStatus
	err    error
}

type harnessOperation string

const (
	harnessConfigure harnessOperation = "configure"
	harnessRestore   harnessOperation = "restore"
)

type uiMode int

const (
	modeNormal uiMode = iota
	modeEnroll
	modeRemoveConfirm
	modeHarnessConfirm
	modeWebhookURL
)

var tabs = []string{"Overview", "Harnesses", "Repos", "Runs", "Attribution", "Webhook", "Diagnostics"}
var compactTabs = []string{"Ov", "Hrn", "Repos", "Runs", "Attr", "Hook", "Diag"}

func NewModel(client snapshotClient) Model {
	cwd, err := os.Getwd()
	if err != nil || cwd == "" {
		cwd = "."
	}
	return Model{
		client:  client,
		loading: true,
		width:   100,
		height:  30,
		cwd:     cwd,
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(fetchStatus(m.client), fetchSnapshot(m.client), tickRefresh())
}

func (m Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyMsg:
		if m.mode == modeEnroll {
			return m.updateEnroll(msg)
		}
		if m.mode == modeRemoveConfirm {
			return m.updateRemoveConfirm(msg)
		}
		if m.mode == modeHarnessConfirm {
			return m.updateHarnessConfirm(msg)
		}
		if m.mode == modeWebhookURL {
			return m.updateWebhookURL(msg)
		}
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "r":
			m.loading = true
			return m, tea.Batch(fetchStatus(m.client), fetchSnapshot(m.client))
		case "a":
			m.beginEnrollment(m.cwd)
			return m, nil
		case "p":
			m.beginEnrollment("")
			return m, nil
		case "d":
			if tabs[m.tab] != "Repos" {
				m.tab = tabIndex("Repos")
				m.selected = 0
				m.removeError = "select_repository"
				return m, nil
			}
			if m.selected < 0 || m.selected >= len(m.snapshot.Repositories) {
				m.removeError = "repository_required"
				return m, nil
			}
			m.beginRemoveConfirmation(m.snapshot.Repositories[m.selected])
			return m, nil
		case "c":
			if tabs[m.tab] == "Harnesses" {
				m.beginHarnessAction(harnessConfigure)
				return m, nil
			}
		case "u":
			if tabs[m.tab] == "Harnesses" {
				m.beginHarnessAction(harnessRestore)
				return m, nil
			}
		case "w":
			m.beginWebhookURL()
			return m, nil
		case "right", "tab":
			m.tab = (m.tab + 1) % len(tabs)
			m.selected = 0
			m.clearHarnessFeedback()
			return m, nil
		case "left", "shift+tab":
			m.tab = (m.tab + len(tabs) - 1) % len(tabs)
			m.selected = 0
			m.clearHarnessFeedback()
			return m, nil
		case "up":
			if m.selected > 0 {
				m.selected--
				if tabs[m.tab] == "Harnesses" {
					m.clearHarnessFeedback()
				}
			}
			return m, nil
		case "down":
			if m.selected < m.maxSelection()-1 {
				m.selected++
				if tabs[m.tab] == "Harnesses" {
					m.clearHarnessFeedback()
				}
			}
			return m, nil
		case "1", "2", "3", "4", "5", "6", "7":
			index := int(msg.String()[0] - '1')
			if index < len(tabs) {
				m.tab = index
				m.selected = 0
				m.clearHarnessFeedback()
				return m, nil
			}
		}
	case fetchedSnapshotMsg:
		m.snapshot = mergeSnapshot(m.snapshot, msg.snapshot)
		m.fetchedAt = msg.at
		m.loading = false
		if m.selected >= m.maxSelection() {
			m.selected = max(0, m.maxSelection()-1)
		}
		return m, nil
	case fetchedStatusMsg:
		if msg.err != nil {
			if m.snapshot.Status == nil {
				m.snapshot.Errors = []string{"status: " + msg.err.Error()}
			}
			m.loading = false
			return m, nil
		}
		if msg.status != nil {
			m.snapshot.Status = msg.status
			m.fetchedAt = msg.at
		}
		m.loading = false
		return m, nil
	case refreshTickMsg:
		m.loading = true
		return m, tea.Batch(fetchStatus(m.client), fetchSnapshot(m.client), tickRefresh())
	case activationMsg:
		m.enrollActivating = false
		m.enrollResults = msg.outcomes
		m.enrollError = activationSummaryError(msg.outcomes)
		m.mode = modeNormal
		m.loading = true
		return m, fetchSnapshot(m.client)
	case repositoryRemovalMsg:
		m.removeActive = false
		m.removeResult = &msg.outcome
		m.removeTarget = nil
		m.mode = modeNormal
		if msg.outcome.err != nil {
			m.removeError = msg.outcome.err.Error()
			return m, nil
		}
		m.removeError = ""
		m.loading = true
		return m, fetchSnapshot(m.client)
	case harnessMsg:
		m.harnessActive = false
		m.harnessResult = &msg.outcome
		m.harnessTarget = nil
		m.mode = modeNormal
		if msg.outcome.err != nil {
			m.harnessError = msg.outcome.err.Error()
			return m, nil
		}
		m.harnessError = ""
		m.loading = true
		return m, fetchSnapshot(m.client)
	case webhookMsg:
		m.webhookActive = false
		m.webhookResult = &msg.outcome
		m.mode = modeNormal
		if msg.outcome.err != nil {
			m.webhookError = msg.outcome.err.Error()
			return m, nil
		}
		m.webhookError = ""
		m.snapshot.Webhook = &msg.outcome.result
		m.loading = true
		return m, fetchSnapshot(m.client)
	}
	return m, nil
}

func mergeSnapshot(previous agent.Snapshot, next agent.Snapshot) agent.Snapshot {
	if previous.Status == nil {
		return next
	}
	if next.Status == nil && snapshotErrorsAreTransient(next.Errors) {
		previous.Errors = next.Errors
		return previous
	}
	if next.Status == nil {
		return next
	}

	merged := next
	if sectionFailed(next.Errors, "diagnostics") && merged.Diagnostics == nil {
		merged.Diagnostics = previous.Diagnostics
	}
	if sectionFailed(next.Errors, "doctor") && merged.Doctor == nil {
		merged.Doctor = previous.Doctor
	}
	if sectionFailed(next.Errors, "repositories") && len(merged.Repositories) == 0 {
		merged.Repositories = previous.Repositories
	}
	if sectionFailed(next.Errors, "sources") && len(merged.Sources) == 0 {
		merged.Sources = previous.Sources
	}
	if (sectionFailed(next.Errors, "sources") || sourceTestsFailed(next.Errors)) && len(merged.SourceTests) == 0 {
		merged.SourceTests = previous.SourceTests
	}
	if sectionFailed(next.Errors, "runs") && len(merged.Runs) == 0 {
		merged.Runs = previous.Runs
	}
	if sectionFailed(next.Errors, "totals") && merged.Totals == nil {
		merged.Totals = previous.Totals
	}
	if sectionFailed(next.Errors, "budgets") && merged.Budgets == nil {
		merged.Budgets = previous.Budgets
	}
	if sectionFailed(next.Errors, "attribution") && len(merged.Attributions) == 0 {
		merged.Attributions = previous.Attributions
	}
	if sectionFailed(next.Errors, "webhook") && merged.Webhook == nil {
		merged.Webhook = previous.Webhook
	}
	return merged
}

func snapshotErrorsAreTransient(errors []string) bool {
	if len(errors) == 0 {
		return false
	}
	for _, err := range errors {
		if !isStatusUnavailableMessage(err) && !isTimeoutSnapshotMessage(err) {
			return false
		}
	}
	return true
}

func sectionFailed(errors []string, section string) bool {
	prefix := section + ": "
	for _, err := range errors {
		if strings.HasPrefix(err, prefix) {
			return true
		}
	}
	return false
}

func sourceTestsFailed(errors []string) bool {
	for _, err := range errors {
		if strings.HasPrefix(err, "source test ") {
			return true
		}
	}
	return false
}

func (m *Model) beginEnrollment(path string) {
	m.tab = tabIndex("Repos")
	m.mode = modeEnroll
	m.enrollPath = path
	m.enrollActivating = false
	m.enrollError = ""
	m.enrollResults = nil
	m.removeError = ""
	m.removeResult = nil
	m.harnessError = ""
	m.harnessResult = nil
}

func (m Model) updateEnroll(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeNormal
		m.enrollError = ""
		return m, nil
	case "enter":
		paths := splitEnrollmentPaths(m.enrollPath)
		if len(paths) == 0 {
			m.enrollError = "path_required"
			return m, nil
		}
		m.enrollActivating = true
		m.enrollError = ""
		return m, activateRepositories(m.client, paths)
	case "backspace", "ctrl+h":
		if len(m.enrollPath) > 0 {
			runes := []rune(m.enrollPath)
			m.enrollPath = string(runes[:len(runes)-1])
		}
		return m, nil
	case "ctrl+u":
		m.enrollPath = ""
		return m, nil
	}
	if len(msg.Runes) > 0 {
		m.enrollPath += string(msg.Runes)
	}
	return m, nil
}

func (m *Model) beginHarnessAction(operation harnessOperation) {
	m.tab = tabIndex("Harnesses")
	row, ok := m.selectedHarness()
	if !ok {
		m.harnessError = "harness_required"
		return
	}
	if !row.configurable {
		m.harnessError = "configure_with_provider_specific_setup"
		return
	}
	m.mode = modeHarnessConfirm
	m.harnessTarget = &row
	m.harnessOperation = operation
	m.harnessActive = false
	m.harnessError = ""
	m.harnessResult = nil
}

func (m *Model) clearHarnessFeedback() {
	if m.mode == modeHarnessConfirm || m.harnessActive {
		return
	}
	m.harnessError = ""
	m.harnessResult = nil
	m.harnessTarget = nil
}

func (m Model) updateHarnessConfirm(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "n":
		m.mode = modeNormal
		m.harnessTarget = nil
		m.harnessActive = false
		return m, nil
	case "y", "enter":
		if m.harnessTarget == nil {
			m.mode = modeNormal
			m.harnessError = "harness_required"
			return m, nil
		}
		m.harnessActive = true
		return m, applyHarnessAction(m.client, *m.harnessTarget, m.harnessOperation)
	}
	return m, nil
}

func (m *Model) beginWebhookURL() {
	m.tab = tabIndex("Webhook")
	m.mode = modeWebhookURL
	m.webhookURL = ""
	if m.snapshot.Webhook != nil {
		m.webhookURL = m.snapshot.Webhook.URL
	}
	m.webhookActive = false
	m.webhookError = ""
	m.webhookResult = nil
}

func (m Model) updateWebhookURL(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeNormal
		m.webhookActive = false
		return m, nil
	case "enter":
		destination := strings.TrimSpace(m.webhookURL)
		if destination == "" {
			m.webhookError = "url_required"
			return m, nil
		}
		m.webhookURL = destination
		m.webhookActive = true
		m.webhookError = ""
		return m, setWebhookURL(m.client, destination)
	case "backspace", "ctrl+h":
		if len(m.webhookURL) > 0 {
			runes := []rune(m.webhookURL)
			m.webhookURL = string(runes[:len(runes)-1])
		}
		return m, nil
	case "ctrl+u":
		m.webhookURL = ""
		return m, nil
	}
	if len(msg.Runes) > 0 {
		m.webhookURL += string(msg.Runes)
	}
	return m, nil
}

func (m *Model) beginRemoveConfirmation(scope agent.RepositoryScope) {
	m.tab = tabIndex("Repos")
	m.mode = modeRemoveConfirm
	m.removeTarget = &scope
	m.removeActive = false
	m.removeError = ""
	m.removeResult = nil
}

func (m Model) updateRemoveConfirm(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "n":
		m.mode = modeNormal
		m.removeTarget = nil
		m.removeActive = false
		return m, nil
	case "y", "enter":
		if m.removeTarget == nil {
			m.mode = modeNormal
			m.removeError = "repository_required"
			return m, nil
		}
		m.removeActive = true
		return m, removeRepository(m.client, *m.removeTarget)
	}
	return m, nil
}

func (m Model) View() string {
	var body string
	switch tabs[m.tab] {
	case "Overview":
		body = m.viewOverview()
	case "Harnesses":
		body = m.viewHarnesses()
	case "Repos":
		body = m.viewRepositories()
	case "Runs":
		body = m.viewRuns()
	case "Attribution":
		body = m.viewAttribution()
	case "Webhook":
		body = m.viewWebhook()
	case "Diagnostics":
		body = m.viewDiagnostics()
	}

	parts := []string{
		m.header(),
		m.tabBar(),
		m.fitBody(body),
		m.footer(),
	}
	return strings.Join(parts, "\n")
}

func tabIndex(name string) int {
	for index, tab := range tabs {
		if tab == name {
			return index
		}
	}
	return 0
}

func fetchSnapshot(client snapshotClient) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return fetchedSnapshotMsg{snapshot: client.FetchSnapshot(ctx), at: time.Now()}
	}
}

func fetchStatus(client snapshotClient) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return fetchedStatusMsg{err: fmt.Errorf("agent_unavailable"), at: time.Now()}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		status, err := client.FetchStatus(ctx)
		return fetchedStatusMsg{status: status, err: err, at: time.Now()}
	}
}

func activateRepositories(client snapshotClient, paths []string) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return activationMsg{outcomes: []activationOutcome{{err: fmt.Errorf("agent_unavailable")}}}
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(max(15, len(paths)*15))*time.Second)
		defer cancel()
		outcomes := make([]activationOutcome, 0, len(paths))
		for _, path := range paths {
			result, err := client.ActivateRepository(ctx, path)
			outcomes = append(outcomes, activationOutcome{path: path, result: result, err: err})
		}
		return activationMsg{outcomes: outcomes}
	}
}

func removeRepository(client snapshotClient, scope agent.RepositoryScope) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return repositoryRemovalMsg{outcome: repositoryRemovalOutcome{scopeID: scope.ScopeID, label: scope.Label, err: fmt.Errorf("agent_unavailable")}}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		result, err := client.RemoveRepository(ctx, scope.ScopeID)
		return repositoryRemovalMsg{outcome: repositoryRemovalOutcome{
			scopeID: scope.ScopeID,
			label:   scope.Label,
			removed: result.Removed,
			err:     err,
		}}
	}
}

func applyHarnessAction(client snapshotClient, row harnessRow, operation harnessOperation) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return harnessMsg{outcome: harnessOutcome{provider: row.provider, name: row.name, operation: operation, err: fmt.Errorf("agent_unavailable")}}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		var (
			result agent.ProviderConfiguration
			err    error
		)
		if operation == harnessRestore {
			result, err = client.RestoreProvider(ctx, row.provider)
		} else {
			result, err = client.ConfigureProvider(ctx, row.provider)
		}
		return harnessMsg{outcome: harnessOutcome{
			provider:  row.provider,
			name:      row.name,
			operation: operation,
			result:    result,
			err:       err,
		}}
	}
}

func setWebhookURL(client snapshotClient, destination string) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return webhookMsg{outcome: webhookOutcome{url: destination, err: fmt.Errorf("agent_unavailable")}}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		result, err := client.SetWebhookURL(ctx, destination)
		return webhookMsg{outcome: webhookOutcome{
			url:    destination,
			result: result,
			err:    err,
		}}
	}
}

func splitEnrollmentPaths(input string) []string {
	parts := strings.Split(input, ",")
	paths := make([]string, 0, len(parts))
	for _, part := range parts {
		path := strings.TrimSpace(part)
		if path != "" {
			paths = append(paths, path)
		}
	}
	return paths
}

func activationSummaryError(outcomes []activationOutcome) string {
	failures := 0
	for _, outcome := range outcomes {
		if outcome.err != nil {
			failures++
		}
	}
	if failures == 0 {
		return ""
	}
	return fmt.Sprintf("%d activation failure(s)", failures)
}

func tickRefresh() tea.Cmd {
	return tea.Tick(10*time.Second, func(t time.Time) tea.Msg {
		return refreshTickMsg(t)
	})
}

func (m Model) maxSelection() int {
	switch tabs[m.tab] {
	case "Harnesses":
		return len(m.harnessRows())
	case "Repos":
		return len(m.snapshot.Repositories)
	case "Runs":
		return len(m.snapshot.Runs)
	case "Attribution":
		return len(m.snapshot.Attributions)
	case "Diagnostics":
		return len(diagnosticsEvents(m.snapshot))
	default:
		return 0
	}
}

func (m Model) header() string {
	width := clampWidth(m.width)
	health := "unknown"
	version := ""
	if m.snapshot.Status != nil {
		health = m.snapshot.Status.Health
		version = m.snapshot.Status.AgentVersion
	}
	right := strings.TrimSpace(fmt.Sprintf("%s %s", colorHealth(health), version))
	left := titleStyle.Render("Tirion")
	gap := max(1, width-visibleLen(left)-visibleLen(stripANSI(right)))
	line := left + strings.Repeat(" ", gap) + right
	return truncateVisible(line, width)
}

func (m Model) tabBar() string {
	items := make([]string, 0, len(tabs))
	for index := range tabs {
		label := fmt.Sprintf("%d %s", index+1, compactTabs[index])
		if index == m.tab {
			items = append(items, activeTabStyle.Render("["+label+"]"))
		} else {
			items = append(items, mutedStyle.Render(" "+label+" "))
		}
	}
	return truncateVisible(strings.Join(items, " "), clampWidth(m.width))
}

func (m Model) footer() string {
	state := "ready"
	if m.loading {
		state = "refreshing"
	}
	if m.enrollActivating {
		state = "enrolling"
	}
	if m.harnessActive {
		state = string(m.harnessOperation)
	}
	if m.webhookActive {
		state = "setting webhook"
	}
	when := "never"
	if !m.fetchedAt.IsZero() {
		when = m.fetchedAt.Format("15:04:05")
	}
	controls := "r refresh | arrows | q quit"
	if m.mode == modeEnroll {
		controls = "enter enroll | esc cancel"
	} else if m.mode == modeRemoveConfirm {
		controls = "y remove | n cancel | esc cancel"
	} else if m.mode == modeHarnessConfirm {
		controls = "y confirm | n cancel | esc cancel"
	} else if m.mode == modeWebhookURL {
		controls = "enter save URL | esc cancel"
	} else if tabs[m.tab] == "Harnesses" {
		controls = "c configure | u restore | r refresh | q quit"
	} else if tabs[m.tab] == "Repos" {
		controls = "a cwd | p paths | d remove | r refresh | q quit"
	} else if tabs[m.tab] == "Webhook" || (tabs[m.tab] == "Overview" && !m.webhookURLConfigured()) {
		controls = "w webhook URL | r refresh | q quit"
	} else {
		controls = "a cwd | p paths | r refresh | q quit"
	}
	return mutedStyle.Render(truncateVisible(fmt.Sprintf("%s | %s | %s", state, when, controls), clampWidth(m.width)))
}

func (m Model) webhookURLConfigured() bool {
	return m.snapshot.Webhook != nil && strings.TrimSpace(m.snapshot.Webhook.URL) != ""
}

func (m Model) fitBody(body string) string {
	limit := m.bodyLineBudget()
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if len(lines) <= limit {
		return strings.Join(lines, "\n")
	}
	if limit <= 1 {
		return mutedStyle.Render("more below")
	}
	return strings.Join(append(lines[:limit-1], mutedStyle.Render("more below; use tabs or resize for details")), "\n")
}

func (m Model) bodyLineBudget() int {
	if m.height <= 0 {
		return 18
	}
	return max(4, m.height-4)
}

func diagnosticsEvents(snapshot agent.Snapshot) []agent.DiagnosticEvent {
	if snapshot.Diagnostics == nil {
		return nil
	}
	return snapshot.Diagnostics.RecentEvents
}
