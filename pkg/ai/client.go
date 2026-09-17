// Package ai calls the Anthropic Messages API on the server's behalf.
//
// The API key never leaves the server: it is read from the environment here
// and no handler returns it. Prompt templates are equally server-side — the
// methodology loader marks AIPrompts `json:"-"` so they are never serialized
// to a client.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Model is the default model for assistant calls. Sonnet is the right balance
// of judgement and latency for interactive strategy work.
const Model = "claude-sonnet-5"

const (
	apiURL     = "https://api.anthropic.com/v1/messages"
	apiVersion = "2023-06-01"
	maxTokens  = 4096
	// A workshop facilitator is waiting on this, so fail rather than hang.
	requestTimeout = 90 * time.Second
)

// UserFacingFailure is the exact message App Spec §12.22 requires whenever an
// AI call cannot complete, whatever the underlying cause. The user must
// always be able to carry on without AI.
const UserFacingFailure = "AI could not complete this request. Please try again or continue manually."

// SystemPrompt is App Spec §13.2's global assistant prompt with §12.23's
// safety rules appended. The methodology name is substituted rather than
// hardcoded, so the assistant introduces itself correctly for PESTLE or any
// future methodology.
func SystemPrompt(methodologyName string) string {
	return fmt.Sprintf(`You are the AI Strategy Assistant for the %s Intelligence Workspace. Your role is to help users conduct structured strategic analysis using the %s methodology. You may assist with brainstorming, clustering, duplicate detection, theme generation, relationship analysis, insight generation, recommendation drafting, and executive summary creation.

You must follow these rules:
1. Use only the context provided in the request.
2. Do not invent facts, data, metrics, market conditions, or organizational details.
3. Clearly distinguish observations from interpretations.
4. Preserve traceability to supplied factors, themes, insights, or recommendations.
5. Generate practical, concise, business-oriented outputs.
6. Do not make final decisions.
7. Do not approve, publish, or finalize content.
8. Assume all outputs require human review.
9. Return valid JSON when a JSON schema is requested.
10. If there is insufficient information, state what is missing rather than fabricating content.

Safety rules:
- Do not fabricate workshop data.
- Do not claim certainty where evidence is weak.
- Do not approve recommendations.
- Do not produce offensive or discriminatory content.
- Do not reveal information outside the user's authorized workspace.
- Do not present AI output as a human decision.
- Do not bypass review workflows.

Your tone should be professional, clear, practical, and strategy-oriented.`,
		methodologyName, methodologyName)
}

type Result struct {
	// Raw is the model's text response.
	Raw string
	// Parsed is Raw decoded as JSON, when the caller asked for JSON.
	Parsed       map[string]interface{}
	Model        string
	InputTokens  int
	OutputTokens int
	LatencyMS    int
}

type apiRequest struct {
	Model     string       `json:"model"`
	MaxTokens int          `json:"max_tokens"`
	System    string       `json:"system"`
	Messages  []apiMessage `json:"messages"`
}

type apiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type apiResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Usage struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Configured reports whether an API key is present, so the UI can hide AI
// affordances rather than offering buttons that always fail.
func Configured() bool {
	return strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")) != ""
}

// Complete sends one request. `expectJSON` makes the caller's schema a hard
// requirement: the response is parsed and a parse failure is an error, so an
// unparseable output never reaches storage (App Spec §12.30).
func Complete(ctx context.Context, systemPrompt, userPrompt string, expectJSON bool) (*Result, error) {
	key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if key == "" {
		return nil, fmt.Errorf("ANTHROPIC_API_KEY is not configured")
	}

	body, err := json.Marshal(apiRequest{
		Model:     Model,
		MaxTokens: maxTokens,
		System:    systemPrompt,
		Messages:  []apiMessage{{Role: "user", Content: userPrompt}},
	})
	if err != nil {
		return nil, err
	}

	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, apiURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", apiVersion)

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("calling the model: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var parsed apiResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("provider returned an unreadable response (status %d)", resp.StatusCode)
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("provider error: %s", parsed.Error.Message)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("provider returned status %d", resp.StatusCode)
	}

	var text strings.Builder
	for _, c := range parsed.Content {
		if c.Type == "text" {
			text.WriteString(c.Text)
		}
	}
	out := strings.TrimSpace(text.String())
	if out == "" {
		return nil, fmt.Errorf("the model returned an empty response")
	}

	result := &Result{
		Raw:          out,
		Model:        Model,
		InputTokens:  parsed.Usage.InputTokens,
		OutputTokens: parsed.Usage.OutputTokens,
		LatencyMS:    int(time.Since(start).Milliseconds()),
	}

	if expectJSON {
		obj, err := extractJSON(out)
		if err != nil {
			return nil, fmt.Errorf("the model did not return valid JSON: %w", err)
		}
		result.Parsed = obj
	}
	return result, nil
}

// extractJSON tolerates a model that wraps its JSON in prose or a fenced code
// block, which is cheaper than failing the whole request over formatting.
func extractJSON(s string) (map[string]interface{}, error) {
	var obj map[string]interface{}
	if err := json.Unmarshal([]byte(s), &obj); err == nil {
		return obj, nil
	}

	if i := strings.Index(s, "```"); i >= 0 {
		rest := s[i+3:]
		if j := strings.Index(rest, "\n"); j >= 0 {
			rest = rest[j+1:]
		}
		if k := strings.Index(rest, "```"); k >= 0 {
			rest = rest[:k]
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(rest)), &obj); err == nil {
			return obj, nil
		}
	}

	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		if err := json.Unmarshal([]byte(s[start:end+1]), &obj); err == nil {
			return obj, nil
		}
	}
	return nil, fmt.Errorf("no JSON object found in the response")
}
