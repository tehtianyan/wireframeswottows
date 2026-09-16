package handlers

import (
	"net/http"

	"swot-tows/pkg/db"
	"swot-tows/pkg/response"
)

// Health proves the function is deployed and can reach the database —
// no auth required, matches App Spec §11.4's "all requests authenticated
// except login" (a health probe is neither).
func Health(w http.ResponseWriter, r *http.Request) {
	pool, err := db.Pool(r.Context())
	if err != nil {
		response.Fail(w, response.CodeServerError, "db pool: "+err.Error())
		return
	}
	if err := pool.Ping(r.Context()); err != nil {
		response.Fail(w, response.CodeServerError, "db ping: "+err.Error())
		return
	}
	response.OK(w, map[string]string{"status": "ok"})
}
