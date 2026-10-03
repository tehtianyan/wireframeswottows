package handlers

import (
	"errors"
	"net/http"
	"strings"

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
	if errors.Is(err, authz.ErrInsufficientRole) {
		response.Fail(w, response.CodeForbidden, "your role in this workshop does not allow this action")
		return
	}
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

// failDB writes the error envelope for a database error, translating the
// conditions a user can actually do something about.
//
// It exists because the archive guard is a TRIGGER (see
// 20261003120000_archived_workshops_are_read_only.sql), and a trigger's
// exception arrives at every mutating handler as an opaque error. Mapping it in
// one place means an archived workshop refuses a write with a sentence that
// says why, from any path — including paths written later that never thought
// about archiving.
//
// Anything unrecognised is still a 500 with its original text, so this hides
// nothing.
func failDB(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	if strings.Contains(err.Error(), "workshop_archived") {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This workshop is archived and read-only. Un-archive it to make changes.")
		return
	}
	response.Fail(w, response.CodeServerError, err.Error())
}
