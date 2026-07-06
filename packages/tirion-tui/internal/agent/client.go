package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type Client struct {
	paths      Paths
	httpClient *http.Client
}

func NewClientFromEnvironment() (*Client, error) {
	paths, err := ResolvePaths()
	if err != nil {
		return nil, err
	}
	return NewClient(paths), nil
}

func NewClient(paths Paths) *Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network string, address string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", paths.SocketPath)
		},
	}
	return &Client{
		paths: paths,
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   5 * time.Second,
		},
	}
}

func (c *Client) FetchSnapshot(ctx context.Context) Snapshot {
	var snapshot Snapshot

	status, err := c.FetchStatus(ctx)
	if err != nil {
		snapshot.Errors = append(snapshot.Errors, "status: "+err.Error())
		return snapshot
	}
	snapshot.Status = status

	token, err := c.bootstrapToken()
	if err != nil {
		snapshot.Errors = append(snapshot.Errors, "authentication: "+err.Error())
		return snapshot
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	recordError := func(section string, err error) {
		mu.Lock()
		defer mu.Unlock()
		snapshot.Errors = append(snapshot.Errors, section+": "+err.Error())
	}
	run := func(fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn()
		}()
	}

	run(func() {
		var diagnostics Diagnostics
		if err := c.get(ctx, "/v1/diagnostics", token, &diagnostics); err != nil {
			recordError("diagnostics", err)
			return
		}
		mu.Lock()
		snapshot.Diagnostics = &diagnostics
		mu.Unlock()
	})

	run(func() {
		var doctor Doctor
		if err := c.get(ctx, "/v1/doctor", token, &doctor); err != nil {
			recordError("doctor", err)
			return
		}
		mu.Lock()
		snapshot.Doctor = &doctor
		mu.Unlock()
	})

	run(func() {
		var repositories repositoriesResponse
		if err := c.get(ctx, "/v1/repositories", token, &repositories); err != nil {
			recordError("repositories", err)
			return
		}
		mu.Lock()
		snapshot.Repositories = repositories.Scopes
		mu.Unlock()
	})

	run(func() {
		var sources sourcesResponse
		if err := c.get(ctx, "/v1/sources", token, &sources); err != nil {
			recordError("sources", err)
			return
		}
		sourceTests := make([]SourceTest, 0, len(sources.Sources))
		for _, source := range sources.Sources {
			var result SourceTest
			if err := c.get(ctx, "/v1/sources/"+url.PathEscape(source.SourceID)+"/test", token, &result); err != nil {
				recordError("source test "+source.SourceID, err)
			} else {
				sourceTests = append(sourceTests, result)
			}
		}
		mu.Lock()
		snapshot.Sources = sources.Sources
		snapshot.SourceTests = sourceTests
		mu.Unlock()
	})

	run(func() {
		var runs runsResponse
		if err := c.get(ctx, "/v1/runs?limit=20", token, &runs); err != nil {
			recordError("runs", err)
			return
		}
		mu.Lock()
		snapshot.Runs = runs.Runs
		mu.Unlock()
	})

	run(func() {
		var totals Totals
		if err := c.get(ctx, "/v1/totals", token, &totals); err != nil {
			recordError("totals", err)
			return
		}
		mu.Lock()
		snapshot.Totals = &totals
		mu.Unlock()
	})

	run(func() {
		var budgets BudgetSnapshot
		if err := c.get(ctx, "/v1/budgets", token, &budgets); err != nil {
			recordError("budgets", err)
			return
		}
		mu.Lock()
		snapshot.Budgets = &budgets
		mu.Unlock()
	})

	run(func() {
		var attributions attributionsResponse
		if err := c.get(ctx, "/v1/attributions?limit=20", token, &attributions); err != nil {
			recordError("attribution", err)
			return
		}
		mu.Lock()
		snapshot.Attributions = attributions.Attributions
		mu.Unlock()
	})

	run(func() {
		var webhook WebhookStatus
		if err := c.get(ctx, "/v1/webhook/status", token, &webhook); err != nil {
			recordError("webhook", err)
			return
		}
		mu.Lock()
		snapshot.Webhook = &webhook
		mu.Unlock()
	})

	wg.Wait()

	return snapshot
}

func (c *Client) FetchStatus(ctx context.Context) (*Status, error) {
	var status Status
	if err := c.get(ctx, "/v1/status", "", &status); err != nil {
		return nil, err
	}
	return &status, nil
}

func (c *Client) ActivateRepository(ctx context.Context, path string) (RepositoryActivation, error) {
	token, err := c.bootstrapToken()
	if err != nil {
		return RepositoryActivation{}, err
	}
	var activation RepositoryActivation
	err = c.post(ctx, "/v1/repositories/activate", token, map[string]interface{}{
		"schemaVersion":          1,
		"path":                   path,
		"provider":               "auto",
		"capturePrompts":         false,
		"captureToolDetails":     false,
		"captureToolContent":     false,
		"captureResponseContent": false,
	}, &activation)
	return activation, err
}

func (c *Client) RemoveRepository(ctx context.Context, scopeID string) (RepositoryRemoval, error) {
	token, err := c.bootstrapToken()
	if err != nil {
		return RepositoryRemoval{}, err
	}
	var removal RepositoryRemoval
	err = c.delete(ctx, "/v1/repositories/"+scopeID, token, &removal)
	return removal, err
}

func (c *Client) ConfigureProvider(ctx context.Context, provider string) (ProviderConfiguration, error) {
	token, err := c.bootstrapToken()
	if err != nil {
		return ProviderConfiguration{}, err
	}
	var configuration ProviderConfiguration
	err = c.post(ctx, "/v1/configure/"+url.PathEscape(provider), token, map[string]interface{}{
		"capturePrompts":         false,
		"captureToolDetails":     true,
		"captureToolContent":     false,
		"captureResponseContent": false,
	}, &configuration)
	return configuration, err
}

func (c *Client) RestoreProvider(ctx context.Context, provider string) (ProviderConfiguration, error) {
	token, err := c.bootstrapToken()
	if err != nil {
		return ProviderConfiguration{}, err
	}
	var configuration ProviderConfiguration
	err = c.request(ctx, http.MethodPost, "/v1/configure/"+url.PathEscape(provider)+"/restore", token, nil, &configuration)
	return configuration, err
}

func (c *Client) SetWebhookURL(ctx context.Context, destination string) (WebhookStatus, error) {
	token, err := c.bootstrapToken()
	if err != nil {
		return WebhookStatus{}, err
	}
	var status WebhookStatus
	err = c.post(ctx, "/v1/webhook/url", token, map[string]interface{}{
		"schemaVersion": 1,
		"url":           destination,
	}, &status)
	return status, err
}

func (c *Client) get(ctx context.Context, path string, token string, target interface{}) error {
	return c.request(ctx, http.MethodGet, path, token, nil, target)
}

func (c *Client) post(ctx context.Context, path string, token string, body interface{}, target interface{}) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return c.request(ctx, http.MethodPost, path, token, encoded, target)
}

func (c *Client) delete(ctx context.Context, path string, token string, target interface{}) error {
	return c.request(ctx, http.MethodDelete, path, token, nil, target)
}

func (c *Client) request(ctx context.Context, method string, path string, token string, body []byte, target interface{}) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://tirion"+path, reader)
	if err != nil {
		return err
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("agent_unavailable")
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if err != nil {
		return err
	}
	if response.StatusCode >= 400 {
		var payload struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(responseBody, &payload); err == nil && payload.Error != "" {
			return fmt.Errorf("%s", payload.Error)
		}
		return fmt.Errorf("http_%d", response.StatusCode)
	}
	if len(responseBody) == 0 {
		return nil
	}
	if err := json.Unmarshal(responseBody, target); err != nil {
		return fmt.Errorf("invalid_response")
	}
	return nil
}

func (c *Client) bootstrapToken() (string, error) {
	bytes, err := os.ReadFile(c.paths.BootstrapTokenPath)
	if err != nil {
		return "", fmt.Errorf("bootstrap_token_unavailable")
	}
	token := strings.TrimSpace(string(bytes))
	if token == "" {
		return "", fmt.Errorf("bootstrap_token_unavailable")
	}
	return token, nil
}
