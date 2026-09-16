// Package httpctx holds small request-context helpers shared across handlers.
package httpctx

import (
	"context"
	"net/http"

	"swot-tows/pkg/auth"
	"swot-tows/pkg/response"
)

type contextKey string

const userContextKey contextKey = "user"

// RequireAuth verifies the request's bearer token and attaches the user to
// the request context, or writes a 401 envelope and returns nil.
func RequireAuth(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	user, err := auth.FromRequest(r)
	if err != nil {
		response.Fail(w, response.CodeUnauthorized, err.Error())
		return r, false
	}
	ctx := context.WithValue(r.Context(), userContextKey, user)
	return r.WithContext(ctx), true
}

func UserFromContext(ctx context.Context) *auth.User {
	u, _ := ctx.Value(userContextKey).(*auth.User)
	return u
}
