package testsupport

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
)

type Handler struct {
	db     *sql.DB
	logger *slog.Logger
	token  string
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{
		db:     db,
		logger: logger,
		token:  strings.TrimSpace(os.Getenv("BOTLAND_TEST_CLEANUP_TOKEN")),
	}
}

type CleanupObject struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	FromID string `json:"from_id,omitempty"`
	ToID   string `json:"to_id,omitempty"`
}

type CleanupRequest struct {
	RunID   string          `json:"run_id,omitempty"`
	Objects []CleanupObject `json:"objects"`
}

type CleanupResult struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Action string `json:"action"`
	Status string `json:"status"`
	Rows   int64  `json:"rows"`
	Error  string `json:"error,omitempty"`
}

func (h *Handler) CleanupResidue(w http.ResponseWriter, r *http.Request) {
	if h.token == "" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}

	header := strings.TrimSpace(r.Header.Get("X-Botland-Test-Cleanup-Token"))
	if subtle.ConstantTimeCompare([]byte(header), []byte(h.token)) != 1 {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "invalid cleanup token")
		return
	}

	var req CleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}
	if len(req.Objects) == 0 {
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "run_id": req.RunID, "results": []CleanupResult{}})
		return
	}

	tx, err := h.db.Begin()
	if err != nil {
		h.logger.Error("begin test cleanup", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}
	defer tx.Rollback()

	results := make([]CleanupResult, 0, len(req.Objects))
	for _, obj := range req.Objects {
		results = append(results, cleanupOne(tx, obj))
	}

	if err := tx.Commit(); err != nil {
		h.logger.Error("commit test cleanup", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	ok := true
	for _, res := range results {
		if res.Status == "error" {
			ok = false
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": ok, "run_id": req.RunID, "results": results})
}

func cleanupOne(tx *sql.Tx, obj CleanupObject) CleanupResult {
	obj.Type = strings.TrimSpace(obj.Type)
	obj.ID = strings.TrimSpace(obj.ID)
	obj.FromID = strings.TrimSpace(obj.FromID)
	obj.ToID = strings.TrimSpace(obj.ToID)

	if obj.Type == "" || obj.ID == "" {
		return CleanupResult{Type: obj.Type, ID: obj.ID, Action: "skip", Status: "skipped", Error: "type and id are required"}
	}

	switch obj.Type {
	case "group":
		return execCleanup(tx, obj, "delete group", `DELETE FROM groups WHERE id=$1`, obj.ID)
	case "message":
		return cleanupMessage(tx, obj)
	case "event":
		return execCleanup(tx, obj, "delete event", `DELETE FROM event_log WHERE id=$1 OR event_key=$1`, obj.ID)
	case "friend_request":
		return execCleanup(tx, obj, "delete friend request", `DELETE FROM friend_requests WHERE id=$1`, obj.ID)
	case "friendship":
		return cleanupFriendship(tx, obj)
	case "report":
		return execCleanup(tx, obj, "delete report", `DELETE FROM reports WHERE id=$1`, obj.ID)
	case "webhook":
		return execCleanup(tx, obj, "delete webhook", `DELETE FROM webhooks WHERE id=$1`, obj.ID)
	case "push_token":
		return execCleanup(tx, obj, "delete push token", `DELETE FROM push_tokens WHERE token=$1`, obj.ID)
	case "community":
		return execCleanup(tx, obj, "delete community", `DELETE FROM communities WHERE id=$1`, obj.ID)
	case "community_post":
		return execCleanup(tx, obj, "delete community post", `DELETE FROM community_posts WHERE id=$1`, obj.ID)
	case "community_reply":
		return execCleanup(tx, obj, "delete community reply", `DELETE FROM community_replies WHERE id=$1`, obj.ID)
	case "moment":
		return execCleanup(tx, obj, "delete moment", `DELETE FROM moments WHERE id=$1`, obj.ID)
	case "citizen":
		return execCleanup(tx, obj, "soft-delete citizen", `UPDATE citizens SET status='deleted', updated_at=NOW() WHERE id=$1 AND (display_name LIKE 'BT_TEST_%' OR display_name LIKE 'Relogin Smoke %')`, obj.ID)
	default:
		return CleanupResult{Type: obj.Type, ID: obj.ID, Action: "skip", Status: "skipped", Error: "unsupported object type"}
	}
}

func cleanupMessage(tx *sql.Tx, obj CleanupObject) CleanupResult {
	var rows int64
	res, err := tx.Exec(`DELETE FROM message_relay WHERE id=$1`, obj.ID)
	if err != nil {
		return cleanupError(obj, "delete message history", err)
	}
	rows += rowsAffected(res)

	res, err = tx.Exec(`DELETE FROM event_log WHERE id=$1 OR event_key=$1 OR payload->>'message_id'=$1 OR payload->>'id'=$1`, obj.ID)
	if err != nil {
		return cleanupError(obj, "delete message events", err)
	}
	rows += rowsAffected(res)

	return cleanupStatus(obj, "delete message", rows)
}

func cleanupFriendship(tx *sql.Tx, obj CleanupObject) CleanupResult {
	var res sql.Result
	var err error
	if obj.FromID != "" && obj.ToID != "" {
		aID, bID := sortIDs(obj.FromID, obj.ToID)
		res, err = tx.Exec(`UPDATE relationships SET status='ended', updated_at=NOW() WHERE citizen_a_id=$1 AND citizen_b_id=$2`, aID, bID)
	} else {
		res, err = tx.Exec(`UPDATE relationships SET status='ended', updated_at=NOW() WHERE id=$1`, obj.ID)
	}
	if err != nil {
		return cleanupError(obj, "end friendship", err)
	}
	return cleanupStatus(obj, "end friendship", rowsAffected(res))
}

func execCleanup(tx *sql.Tx, obj CleanupObject, action, query string, args ...interface{}) CleanupResult {
	res, err := tx.Exec(query, args...)
	if err != nil {
		return cleanupError(obj, action, err)
	}
	return cleanupStatus(obj, action, rowsAffected(res))
}

func cleanupStatus(obj CleanupObject, action string, rows int64) CleanupResult {
	status := "not_found"
	if rows > 0 {
		status = "deleted"
	}
	return CleanupResult{Type: obj.Type, ID: obj.ID, Action: action, Status: status, Rows: rows}
}

func cleanupError(obj CleanupObject, action string, err error) CleanupResult {
	return CleanupResult{Type: obj.Type, ID: obj.ID, Action: action, Status: "error", Error: err.Error()}
}

func rowsAffected(res sql.Result) int64 {
	rows, err := res.RowsAffected()
	if err != nil {
		return 0
	}
	return rows
}

func sortIDs(a, b string) (string, string) {
	if a < b {
		return a, b
	}
	return b, a
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":{"code":"%s","message":"%s"}}`, code, msg)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
