// Package response implements the standard API envelope from
// Application Specification §11.6/§11.7.
package response

import (
	"encoding/json"
	"net/http"
)

type Envelope struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data"`
	Message interface{} `json:"message"`
	Error   *APIError   `json:"error,omitempty"`
}

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error codes per App Spec §11.7.
const (
	CodeUnauthorized          = "UNAUTHORIZED"
	CodeForbidden             = "FORBIDDEN"
	CodeNotFound              = "NOT_FOUND"
	CodeValidationError       = "VALIDATION_ERROR"
	CodeInvalidStateTransition = "INVALID_STATE_TRANSITION"
	CodeAIGenerationFailed    = "AI_GENERATION_FAILED"
	CodeRateLimited           = "RATE_LIMITED"
	CodeServerError           = "SERVER_ERROR"
)

var statusForCode = map[string]int{
	CodeUnauthorized:           http.StatusUnauthorized,
	CodeForbidden:              http.StatusForbidden,
	CodeNotFound:               http.StatusNotFound,
	CodeValidationError:        http.StatusBadRequest,
	CodeInvalidStateTransition: http.StatusConflict,
	CodeAIGenerationFailed:     http.StatusBadGateway,
	CodeRateLimited:            http.StatusTooManyRequests,
	CodeServerError:            http.StatusInternalServerError,
}

func OK(w http.ResponseWriter, data interface{}) {
	writeJSON(w, http.StatusOK, Envelope{Success: true, Data: data, Message: nil})
}

func Created(w http.ResponseWriter, data interface{}) {
	writeJSON(w, http.StatusCreated, Envelope{Success: true, Data: data, Message: nil})
}

func Fail(w http.ResponseWriter, code string, message string) {
	status, ok := statusForCode[code]
	if !ok {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, Envelope{Success: false, Data: nil, Error: &APIError{Code: code, Message: message}})
}

func writeJSON(w http.ResponseWriter, status int, env Envelope) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(env)
}
