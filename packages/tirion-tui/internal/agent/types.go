package agent

type Snapshot struct {
	Status       *Status
	Doctor       *Doctor
	Diagnostics  *Diagnostics
	Repositories []RepositoryScope
	Sources      []SourceCapability
	SourceTests  []SourceTest
	Runs         []Run
	Totals       *Totals
	Budgets      *BudgetSnapshot
	Attributions []Attribution
	Webhook      *WebhookStatus
	Errors       []string
}

type Status struct {
	SchemaVersion                         int      `json:"schemaVersion"`
	Health                                string   `json:"health"`
	AgentVersion                          string   `json:"agentVersion"`
	RuntimeVersion                        string   `json:"runtimeVersion"`
	InstallationID                        string   `json:"installationId"`
	EnvironmentID                         string   `json:"environmentId"`
	OwnershipState                        string   `json:"ownershipState"`
	DatabaseSchemaVersion                 int      `json:"databaseSchemaVersion"`
	StartedAt                             string   `json:"startedAt"`
	PID                                   int      `json:"pid"`
	RuntimeWarmupState                    string   `json:"runtimeWarmupState"`
	RuntimeWarmupLastErrorCode            string   `json:"runtimeWarmupLastErrorCode"`
	FullOwnerBootstrapState               string   `json:"fullOwnerBootstrapState"`
	FullOwnerBootstrapLastErrorCode       string   `json:"fullOwnerBootstrapLastErrorCode"`
	HistoricalReconciliationState         string   `json:"historicalReconciliationState"`
	HistoricalReconciliationLastErrorCode string   `json:"historicalReconciliationLastErrorCode"`
	Protocol                              Protocol `json:"protocol"`
	OTLP                                  *OTLP    `json:"otlp"`
}

type Protocol struct {
	Major int `json:"major"`
	Minor int `json:"minor"`
}

type OTLP struct {
	Host  string   `json:"host"`
	Port  int      `json:"port"`
	Paths []string `json:"paths"`
}

type RepositoryScope struct {
	SchemaVersion  int    `json:"schemaVersion"`
	ScopeID        string `json:"scopeId"`
	Kind           string `json:"kind"`
	Label          string `json:"label"`
	State          string `json:"state"`
	EnvironmentID  string `json:"environmentId"`
	Provider       string `json:"provider"`
	AddedAt        string `json:"addedAt"`
	UpdatedAt      string `json:"updatedAt"`
	LastObservedAt string `json:"lastObservedAt"`
}

type ProviderSourceStatus struct {
	SchemaVersion            int      `json:"schemaVersion"`
	Provider                 string   `json:"provider"`
	ProfileVersion           string   `json:"profileVersion"`
	ConfigurationState       string   `json:"configurationState"`
	OwnershipState           string   `json:"ownershipState"`
	PromptCaptureEnabled     bool     `json:"promptCaptureEnabled"`
	LogsEnabled              bool     `json:"logsEnabled"`
	TracesEnabled            bool     `json:"tracesEnabled"`
	ToolDetailsSupported     bool     `json:"toolDetailsSupported"`
	ToolDetailsEnabled       bool     `json:"toolDetailsEnabled"`
	ToolContentSupported     bool     `json:"toolContentSupported"`
	ToolContentEnabled       bool     `json:"toolContentEnabled"`
	ResponseContentSupported bool     `json:"responseContentSupported"`
	ResponseContentEnabled   bool     `json:"responseContentEnabled"`
	LastReceiptAt            string   `json:"lastReceiptAt"`
	MeasurementState         string   `json:"measurementState"`
	ReasonCodes              []string `json:"reasonCodes"`
}

type ProviderConfiguration struct {
	SchemaVersion            int      `json:"schemaVersion"`
	Provider                 string   `json:"provider"`
	Status                   string   `json:"status"`
	ProfileVersion           string   `json:"profileVersion"`
	OwnershipState           string   `json:"ownershipState"`
	PromptCaptureEnabled     bool     `json:"promptCaptureEnabled"`
	LogsEnabled              bool     `json:"logsEnabled"`
	TracesEnabled            bool     `json:"tracesEnabled"`
	ToolDetailsSupported     bool     `json:"toolDetailsSupported"`
	ToolDetailsEnabled       bool     `json:"toolDetailsEnabled"`
	ToolContentSupported     bool     `json:"toolContentSupported"`
	ToolContentEnabled       bool     `json:"toolContentEnabled"`
	ResponseContentSupported bool     `json:"responseContentSupported"`
	ResponseContentEnabled   bool     `json:"responseContentEnabled"`
	RestartRequired          bool     `json:"restartRequired"`
	ReasonCodes              []string `json:"reasonCodes"`
}

type RepositoryActivation struct {
	SchemaVersion   int                   `json:"schemaVersion"`
	ActivationState string                `json:"activationState"`
	RepositoryScope RepositoryScope       `json:"repositoryScope"`
	Provider        string                `json:"provider"`
	SourceStatus    *ProviderSourceStatus `json:"sourceStatus"`
	RestartRequired bool                  `json:"restartRequired"`
	ReasonCodes     []string              `json:"reasonCodes"`
}

type RepositoryRemoval struct {
	SchemaVersion int  `json:"schemaVersion"`
	Removed       bool `json:"removed"`
}

type repositoriesResponse struct {
	SchemaVersion int               `json:"schemaVersion"`
	Scopes        []RepositoryScope `json:"scopes"`
}

type SourceCapability struct {
	SchemaVersion   int      `json:"schemaVersion"`
	SourceID        string   `json:"sourceId"`
	SourceKind      string   `json:"sourceKind"`
	Provider        string   `json:"provider"`
	Runtime         string   `json:"runtime"`
	Granularity     []string `json:"granularity"`
	TokenDimensions []string `json:"tokenDimensions"`
	Durability      string   `json:"durability"`
	ContentRisk     string   `json:"contentRisk"`
	Compatibility   string   `json:"compatibility"`
	EvidenceGrade   string   `json:"evidenceGrade"`
}

type sourcesResponse struct {
	SchemaVersion int                `json:"schemaVersion"`
	Sources       []SourceCapability `json:"sources"`
}

type SourceTest struct {
	SchemaVersion    int    `json:"schemaVersion"`
	SourceID         string `json:"sourceId"`
	Registered       bool   `json:"registered"`
	EnvironmentMatch bool   `json:"environmentMatch"`
	RuntimeObserved  bool   `json:"runtimeObserved"`
	LastObservedAt   string `json:"lastObservedAt"`
	Compatibility    string `json:"compatibility"`
	EvidenceGrade    string `json:"evidenceGrade"`
}

type Run struct {
	SchemaVersion            int            `json:"schemaVersion"`
	Production               bool           `json:"production"`
	RunID                    string         `json:"runId"`
	Provider                 string         `json:"provider"`
	Model                    string         `json:"model"`
	StartedAt                string         `json:"startedAt"`
	EndedAt                  string         `json:"endedAt"`
	InputTokens              int64          `json:"inputTokens"`
	OutputTokens             int64          `json:"outputTokens"`
	CacheReadInputTokens     int64          `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64          `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64          `json:"reasoningOutputTokens"`
	TotalTokens              int64          `json:"totalTokens"`
	EstimatedNanoUSD         *int64         `json:"estimatedNanoUsd"`
	Breakdown                []RunBreakdown `json:"breakdown"`
}

type RunBreakdown struct {
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	TotalTokens      int64  `json:"totalTokens"`
	EstimatedNanoUSD *int64 `json:"estimatedNanoUsd"`
}

type runsResponse struct {
	SchemaVersion int   `json:"schemaVersion"`
	Production    bool  `json:"production"`
	Current       bool  `json:"current"`
	Runs          []Run `json:"runs"`
}

type Totals struct {
	SchemaVersion            int   `json:"schemaVersion"`
	Production               bool  `json:"production"`
	RunCount                 int64 `json:"runCount"`
	InputTokens              int64 `json:"inputTokens"`
	OutputTokens             int64 `json:"outputTokens"`
	CacheReadInputTokens     int64 `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64 `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64 `json:"reasoningOutputTokens"`
	TotalTokens              int64 `json:"totalTokens"`
	EstimatedNanoUSD         int64 `json:"estimatedNanoUsd"`
	PricedRunCount           int64 `json:"pricedRunCount"`
	UnpricedRunCount         int64 `json:"unpricedRunCount"`
}

type BudgetSnapshot struct {
	SchemaVersion int              `json:"schemaVersion"`
	Thresholds    BudgetThresholds `json:"thresholds"`
	Warnings      []BudgetWarning  `json:"warnings"`
}

type BudgetThresholds struct {
	SchemaVersion           int   `json:"schemaVersion"`
	RunTokens               int64 `json:"runTokens"`
	RunEstimatedNanoUSD     int64 `json:"runEstimatedNanoUsd"`
	DailyEstimatedNanoUSD   int64 `json:"dailyEstimatedNanoUsd"`
	MonthlyEstimatedNanoUSD int64 `json:"monthlyEstimatedNanoUsd"`
}

type BudgetWarning struct {
	SchemaVersion int    `json:"schemaVersion"`
	WarningID     string `json:"warningId"`
	Kind          string `json:"kind"`
	RunID         string `json:"runId"`
	Observed      int64  `json:"observed"`
	Threshold     int64  `json:"threshold"`
	Unit          string `json:"unit"`
	CreatedAt     string `json:"createdAt"`
}

type Attribution struct {
	SchemaVersion        int            `json:"schemaVersion"`
	CommitHash           string         `json:"commitHash"`
	RepoKey              string         `json:"repoKey"`
	QueryIDs             []string       `json:"queryIds"`
	RunIDs               []string       `json:"runIds"`
	AttributedQueryCount int64          `json:"attributedQueryCount"`
	EstimatedNanoUSD     *int64         `json:"estimatedNanoUsd"`
	ProviderCosts        []ProviderCost `json:"providerCosts"`
	CostCoverage         string         `json:"costCoverage"`
	Decision             string         `json:"decision"`
	ProofKinds           []string       `json:"proofKinds"`
	Status               string         `json:"status"`
	CreatedAt            string         `json:"createdAt"`
}

type ProviderCost struct {
	Provider         string `json:"provider"`
	QueryCount       int64  `json:"queryCount"`
	EstimatedNanoUSD *int64 `json:"estimatedNanoUsd"`
}

type attributionsResponse struct {
	SchemaVersion int           `json:"schemaVersion"`
	Attributions  []Attribution `json:"attributions"`
}

type WebhookStatus struct {
	SchemaVersion           int                   `json:"schemaVersion"`
	URL                     string                `json:"url"`
	RunEndedEnabled         bool                  `json:"runEndedEnabled"`
	CommitAttributedEnabled bool                  `json:"commitAttributedEnabled"`
	BearerTokenConfigured   bool                  `json:"bearerTokenConfigured"`
	HMACSecretConfigured    bool                  `json:"hmacSecretConfigured"`
	QueuedCount             int64                 `json:"queuedCount"`
	BlockedCount            int64                 `json:"blockedCount"`
	DeliveredCount          int64                 `json:"deliveredCount"`
	OldestQueuedAt          string                `json:"oldestQueuedAt"`
	MaxQueueAgeMs           int64                 `json:"maxQueueAgeMs"`
	LastDeliveredAt         string                `json:"lastDeliveredAt"`
	LastErrorCode           string                `json:"lastErrorCode"`
	BlockedItems            []WebhookDeliveryItem `json:"blockedItems"`
	QueuedItems             []WebhookDeliveryItem `json:"queuedItems"`
}

type WebhookDeliveryItem struct {
	SchemaVersion int    `json:"schemaVersion"`
	EventID       string `json:"eventId"`
	EventType     string `json:"eventType"`
	SubjectID     string `json:"subjectId"`
	DeliveryState string `json:"deliveryState"`
	Attempts      int64  `json:"attempts"`
	QueuedAt      string `json:"queuedAt"`
	LastErrorCode string `json:"lastErrorCode"`
	UpdatedAt     string `json:"updatedAt"`
}

type Diagnostics struct {
	SchemaVersion              int               `json:"schemaVersion"`
	Health                     string            `json:"health"`
	OwnershipState             string            `json:"ownershipState"`
	ExecutionEnvironment       string            `json:"executionEnvironment"`
	SourceCount                int64             `json:"sourceCount"`
	SafeObservationCount       int64             `json:"safeObservationCount"`
	JournalPrunedCount         int64             `json:"journalPrunedCount"`
	JournalOverflowCount       int64             `json:"journalOverflowCount"`
	ProductionRunCount         int64             `json:"productionRunCount"`
	PricedRunCount             int64             `json:"pricedRunCount"`
	UnpricedRunCount           int64             `json:"unpricedRunCount"`
	RepositoryScopeCount       int64             `json:"repositoryScopeCount"`
	ActiveRepositoryScopeCount int64             `json:"activeRepositoryScopeCount"`
	VerifiedAttributionCount   int64             `json:"verifiedAttributionCount"`
	BudgetWarningCount         int64             `json:"budgetWarningCount"`
	Webhook                    *WebhookStatus    `json:"webhook"`
	ConstructStates            []ConstructState  `json:"constructStates"`
	RecentEvents               []DiagnosticEvent `json:"recentEvents"`
}

type Doctor struct {
	SchemaVersion     int          `json:"schemaVersion"`
	Health            string       `json:"health"`
	OwnershipState    string       `json:"ownershipState"`
	DatabaseIntegrity string       `json:"databaseIntegrity"`
	Checks            DoctorChecks `json:"checks"`
	Facts             DoctorFacts  `json:"facts"`
}

type DoctorChecks struct {
	SingleOwner           bool `json:"singleOwner"`
	StorageWorker         bool `json:"storageWorker"`
	ProtocolCompatible    bool `json:"protocolCompatible"`
	PrivateStateDirectory bool `json:"privateStateDirectory"`
	PrivateControlSocket  bool `json:"privateControlSocket"`
}

type DoctorFacts struct {
	SourceCount                     int64                  `json:"sourceCount"`
	SourceProviders                 []string               `json:"sourceProviders"`
	SourceStatuses                  []ProviderSourceStatus `json:"sourceStatuses"`
	ProductionRunCount              int64                  `json:"productionRunCount"`
	UnpricedRunCount                int64                  `json:"unpricedRunCount"`
	RepositoryScopeCount            int64                  `json:"repositoryScopeCount"`
	ActiveRepositoryScopeCount      int64                  `json:"activeRepositoryScopeCount"`
	UnavailableRepositoryScopeCount int64                  `json:"unavailableRepositoryScopeCount"`
	PausedRepositoryScopeCount      int64                  `json:"pausedRepositoryScopeCount"`
	BudgetWarningCount              int64                  `json:"budgetWarningCount"`
	JournalOverflowCount            int64                  `json:"journalOverflowCount"`
	RuntimeWarmupState              string                 `json:"runtimeWarmupState"`
	RuntimeWarmupLastErrorCode      string                 `json:"runtimeWarmupLastErrorCode"`
}

type ConstructState struct {
	SchemaVersion int    `json:"schemaVersion"`
	Construct     string `json:"construct"`
	State         string `json:"state"`
	Health        string `json:"health"`
	UpdatedAt     string `json:"updatedAt"`
	LastErrorCode string `json:"lastErrorCode"`
}

type DiagnosticEvent struct {
	SchemaVersion int                    `json:"schemaVersion"`
	EventID       string                 `json:"eventId"`
	Code          string                 `json:"code"`
	Severity      string                 `json:"severity"`
	ObservedAt    string                 `json:"observedAt"`
	Details       map[string]interface{} `json:"details"`
}
