// Package auth verifies Supabase-issued JWTs. Supabase signs tokens with
// ES256 against a per-project JWKS endpoint (confirmed for this project at
// https://<project>.supabase.co/auth/v1/.well-known/jwks.json) — no shared
// secret needed, which is exactly what a Go trust boundary wants: it can
// verify a caller's identity independently, using only the public key.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type User struct {
	ID    string
	Email string
}

var (
	jwksOnce sync.Once
	jwksKF   keyfunc.Keyfunc
	jwksErr  error
)

func jwksURL() string {
	return fmt.Sprintf("%s/auth/v1/.well-known/jwks.json", supabaseURL())
}

func supabaseURL() string {
	if v := envOrDefault("SUPABASE_URL", ""); v != "" {
		return strings.TrimRight(v, "/")
	}
	return ""
}

func getKeyfunc() (keyfunc.Keyfunc, error) {
	jwksOnce.Do(func() {
		jwksKF, jwksErr = keyfunc.NewDefaultCtx(context.Background(), []string{jwksURL()})
	})
	return jwksKF, jwksErr
}

// FromRequest extracts and verifies the Bearer token on a request, returning
// the authenticated user's Supabase user id and email from the token claims.
func FromRequest(r *http.Request) (*User, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return nil, errors.New("no authorization header provided")
	}
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return nil, errors.New("only bearer tokens are supported")
	}
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")
	if tokenString == "" {
		return nil, errors.New("empty bearer token")
	}

	kf, err := getKeyfunc()
	if err != nil {
		return nil, fmt.Errorf("jwks unavailable: %w", err)
	}

	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, kf.Keyfunc, jwt.WithValidMethods([]string{"ES256"}))
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("invalid token: %w", err)
	}

	sub, _ := claims["sub"].(string)
	if sub == "" {
		return nil, errors.New("token has no subject claim")
	}
	email, _ := claims["email"].(string)

	return &User{ID: sub, Email: email}, nil
}
