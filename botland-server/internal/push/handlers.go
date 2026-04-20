package push

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type Handler struct {
	db     *sql.DB
	logger *slog.Logger
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{db: db, logger: logger}
}

// RegisterToken stores a push token for a citizen
// POST /api/v1/push/register  { "token": "ExponentPushToken[xxx]" }
func (h *Handler) RegisterToken(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	if citizenID == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return
	}

	var req struct {
		Token    string `json:"token"`
		Platform string `json:"platform"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	token := strings.TrimSpace(req.Token)
	if token == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "token is required")
		return
	}

	platform := req.Platform
	if platform == "" {
		platform = "expo"
	}

	_, err := h.db.Exec(
		`INSERT INTO push_tokens (citizen_id, token, platform, updated_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (citizen_id, token) DO UPDATE SET updated_at = NOW()`,
		citizenID, token, platform,
	)
	if err != nil {
		h.logger.Error("register push token error", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	h.logger.Info("push token registered", "citizen_id", citizenID, "platform", platform)
	writeJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

// UnregisterToken removes a push token
// POST /api/v1/push/unregister  { "token": "ExponentPushToken[xxx]" }
func (h *Handler) UnregisterToken(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	if citizenID == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return
	}

	var req struct {
		Token string `json:"token"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if req.Token != "" {
		h.db.Exec(`DELETE FROM push_tokens WHERE citizen_id=$1 AND token=$2`, citizenID, req.Token)
	} else {
		h.db.Exec(`DELETE FROM push_tokens WHERE citizen_id=$1`, citizenID)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "unregistered"})
}

// SendPush sends a push notification to a citizen via Expo Push API
func (h *Handler) SendPush(citizenID, title, body string, data map[string]string) error {
	rows, err := h.db.Query(`SELECT token FROM push_tokens WHERE citizen_id=$1`, citizenID)
	if err != nil {
		return err
	}
	defer rows.Close()

	var tokens []string
	for rows.Next() {
		var t string
		rows.Scan(&t)
		tokens = append(tokens, t)
	}

	if len(tokens) == 0 {
		return nil // no tokens registered
	}

	// Send via Expo Push API
	for _, token := range tokens {
		msg := map[string]interface{}{
			"to":    token,
			"title": title,
			"body":  body,
			"sound": "default",
		}
		if data != nil {
			msg["data"] = data
		}

		payload, _ := json.Marshal([]interface{}{msg})

		req, _ := http.NewRequest("POST", "https://exp.host/--/api/v2/push/send", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")

		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			h.logger.Error("push send error", "error", err, "citizen_id", citizenID)
			continue
		}
		resp.Body.Close()

		if resp.StatusCode != 200 {
			h.logger.Warn("push send non-200", "status", resp.StatusCode, "citizen_id", citizenID)
		} else {
			h.logger.Info("push sent", "citizen_id", citizenID, "title", title)
		}
	}

	return nil
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
