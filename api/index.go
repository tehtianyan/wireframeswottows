// Package handler is the Vercel Go serverless function entrypoint. The
// filename's [...path] catch-all maps every request under /api/v1/* to this
// one function; internal/router does the real routing via chi, so this file
// stays a thin adapter and the rest of the backend is deployment-agnostic.
package handler

import (
	"net/http"

	"swot-tows/pkg/router"
)

var mux = router.New()

func Handler(w http.ResponseWriter, r *http.Request) {
	mux.ServeHTTP(w, r)
}
