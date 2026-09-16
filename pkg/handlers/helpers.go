package handlers

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/authz"
	"swot-tows/pkg/db"
	"swot-tows/pkg/response"
)

// mustPool fetches the DB pool, writing a 500 envelope and returning nil on failure.
func mustPool(r *http.Request, w http.ResponseWriter) *pgxpool.Pool {
	pool, err := db.Pool(r.Context())
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return nil
	}
	return pool
}

func writeAuthzErr(w http.ResponseWriter, err error) {
	if errors.Is(err, authz.ErrForbidden) {
		response.Fail(w, response.CodeForbidden, "you do not have access to this workshop")
		return
	}
	if errors.Is(err, authz.ErrNotFound) {
		response.Fail(w, response.CodeNotFound, "not found")
		return
	}
	response.Fail(w, response.CodeServerError, err.Error())
}
