package citizen

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"
)

type Handler struct {
	db     *sql.DB
	logger *slog.Logger
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{db: db, logger: logger}
}

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	h.getCitizen(w, citizenID)
}

func (h *Handler) GetCitizen(w http.ResponseWriter, r *http.Request) {
	citizenID := chi.URLParam(r, "citizenID")
	h.getCitizen(w, citizenID)
}

func (h *Handler) getCitizen(w http.ResponseWriter, citizenID string) {
	var id, citizenType, displayName, status string
	var avatarURL, bio, species, framework sql.NullString
	var tags []string

	err := h.db.QueryRow(
		`SELECT id, citizen_type, display_name, avatar_url, bio, species, personality_tags, framework, status FROM citizens WHERE id=$1`,
		citizenID,
	).Scan(&id, &citizenType, &displayName, &avatarURL, &bio, &species, pq.Array(&tags), &framework, &status)

	if err == sql.ErrNoRows {
		writeError(w, 404, "NOT_FOUND", "citizen not found")
		return
	}
	if err != nil {
		h.logger.Error("get citizen", "error", err)
		writeError(w, 500, "INTERNAL", "server error")
		return
	}

	result := map[string]interface{}{
		"citizen_id":       id,
		"citizen_type":     citizenType,
		"display_name":     displayName,
		"avatar_url":       avatarURL.String,
		"bio":              bio.String,
		"species":          species.String,
		"personality_tags": tags,
		"framework":        framework.String,
		"status":           status,
	}
	writeJSON(w, 200, result)
}

func (h *Handler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)

	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "VALIDATION_ERROR", "invalid body")
		return
	}

	sets := []string{}
	args := []interface{}{}
	i := 1

	for _, field := range []string{"display_name", "avatar_url", "bio", "species", "framework"} {
		if v, ok := body[field]; ok {
			sets = append(sets, field+"=$"+string(rune('0'+i)))
			args = append(args, v)
			i++
		}
	}
	if tags, ok := body["personality_tags"]; ok {
		if arr, ok := tags.([]interface{}); ok {
			strs := make([]string, len(arr))
			for j, v := range arr {
				strs[j], _ = v.(string)
			}
			sets = append(sets, "personality_tags=$"+string(rune('0'+i)))
			args = append(args, pq.Array(strs))
			i++
		}
	}

	if len(sets) == 0 {
		writeError(w, 400, "VALIDATION_ERROR", "nothing to update")
		return
	}

	sets = append(sets, "updated_at=NOW()")
	query := "UPDATE citizens SET " + strings.Join(sets, ", ") + " WHERE id=$" + string(rune('0'+i))
	args = append(args, citizenID)

	_, err := h.db.Exec(query, args...)
	if err != nil {
		h.logger.Error("update citizen", "error", err)
		writeError(w, 500, "INTERNAL", "server error")
		return
	}

	h.getCitizen(w, citizenID)
}

// Search citizens
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	citizenType := r.URL.Query().Get("type")
	tag := r.URL.Query().Get("tags")

	query := `SELECT id, citizen_type, display_name, avatar_url, bio, species, personality_tags
		FROM citizens WHERE status='active'`
	args := []interface{}{}
	i := 1

	if q != "" {
		query += ` AND (display_name ILIKE $` + itoa(i) + ` OR bio ILIKE $` + itoa(i) + ` OR species ILIKE $` + itoa(i) + `)`
		args = append(args, "%"+q+"%")
		i++
	}
	if citizenType != "" {
		query += ` AND citizen_type=$` + itoa(i)
		args = append(args, citizenType)
		i++
	}
	if tag != "" {
		query += ` AND $` + itoa(i) + ` = ANY(personality_tags)`
		args = append(args, tag)
		i++
	}
	query += " ORDER BY created_at DESC LIMIT 50"

	rows, err := h.db.Query(query, args...)
	if err != nil {
		h.logger.Error("search", "error", err)
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var id, ct, dn string
		var au, bio, sp sql.NullString
		var tags []string
		rows.Scan(&id, &ct, &dn, &au, &bio, &sp, pq.Array(&tags))
		results = append(results, map[string]interface{}{
			"citizen_id":       id,
			"citizen_type":     ct,
			"display_name":     dn,
			"avatar_url":       au.String,
			"bio":              bio.String,
			"species":          sp.String,
			"personality_tags": tags,
		})
	}
	if results == nil {
		results = []map[string]interface{}{}
	}
	writeJSON(w, 200, map[string]interface{}{"results": results, "total": len(results)})
}

func (h *Handler) Trending(w http.ResponseWriter, r *http.Request) {
	h.Search(w, r) // For MVP, trending = latest
}

func itoa(i int) string {
	return string(rune('0' + i))
}
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{"error": map[string]interface{}{"code": code, "message": msg, "status": status}})
}
