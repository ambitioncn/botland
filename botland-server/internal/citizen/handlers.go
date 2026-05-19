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
	var id, handle, citizenType, displayName, status string
	var avatarURL, bio, species, framework sql.NullString
	var tags []string
	var capabilities []string
	var servicesRaw []byte
	var friendCount, groupCount, momentCount int

	err := h.db.QueryRow(
		`SELECT
			c.id, c.handle, c.citizen_type, c.display_name, c.avatar_url, c.bio, c.species,
			c.personality_tags, c.framework, c.status, c.capabilities, c.services,
			(SELECT COUNT(*) FROM relationships r WHERE r.status='active' AND (r.citizen_a_id=c.id OR r.citizen_b_id=c.id)),
			(SELECT COUNT(*) FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.citizen_id=c.id AND gm.status='active' AND g.status='active'),
			(SELECT COUNT(*) FROM moments m WHERE m.author_id=c.id AND m.status='active')
		FROM citizens c WHERE c.id=$1`,
		citizenID,
	).Scan(
		&id, &handle, &citizenType, &displayName, &avatarURL, &bio, &species,
		pq.Array(&tags), &framework, &status, pq.Array(&capabilities), &servicesRaw,
		&friendCount, &groupCount, &momentCount,
	)

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
		"handle":           handle,
		"citizen_type":     citizenType,
		"display_name":     displayName,
		"avatar_url":       avatarURL.String,
		"bio":              bio.String,
		"species":          species.String,
		"personality_tags": tags,
		"framework":        framework.String,
		"capabilities":     capabilities,
		"services":         decodeServices(servicesRaw),
		"status":           status,
		"stats": map[string]interface{}{
			"friend_count": friendCount,
			"group_count":  groupCount,
			"moment_count": momentCount,
		},
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
	if capabilities, ok := body["capabilities"]; ok {
		strs := normalizeStringSlice(capabilities)
		sets = append(sets, "capabilities=$"+string(rune('0'+i)))
		args = append(args, pq.Array(strs))
		i++
	}
	if services, ok := body["services"]; ok {
		servicesJSON, err := json.Marshal(normalizeServices(services))
		if err != nil {
			writeError(w, 400, "VALIDATION_ERROR", "invalid services")
			return
		}
		sets = append(sets, "services=$"+string(rune('0'+i)))
		args = append(args, servicesJSON)
		i++
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

	query := `SELECT id, handle, citizen_type, display_name, avatar_url, bio, species, personality_tags, capabilities
		FROM citizens WHERE status='active'`
	args := []interface{}{}
	i := 1

	if q != "" {
		trimmed := strings.TrimSpace(q)
		query += ` AND (handle ILIKE $` + itoa(i) + ` OR display_name ILIKE $` + itoa(i) + ` OR bio ILIKE $` + itoa(i) + ` OR species ILIKE $` + itoa(i) + ` OR $` + itoa(i+1) + ` = ANY(capabilities) OR id = $` + itoa(i+2) + `)`
		args = append(args, "%"+trimmed+"%", trimmed, trimmed)
		i++
		i++
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
		var id, handle, ct, dn string
		var au, bio, sp sql.NullString
		var tags []string
		var capabilities []string
		rows.Scan(&id, &handle, &ct, &dn, &au, &bio, &sp, pq.Array(&tags), pq.Array(&capabilities))
		results = append(results, map[string]interface{}{
			"citizen_id":       id,
			"handle":           handle,
			"citizen_type":     ct,
			"display_name":     dn,
			"avatar_url":       au.String,
			"bio":              bio.String,
			"species":          sp.String,
			"personality_tags": tags,
			"capabilities":     capabilities,
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

func decodeServices(raw []byte) []map[string]interface{} {
	if len(raw) == 0 {
		return []map[string]interface{}{}
	}
	var services []map[string]interface{}
	if err := json.Unmarshal(raw, &services); err != nil || services == nil {
		return []map[string]interface{}{}
	}
	return services
}

func normalizeStringSlice(value interface{}) []string {
	items, ok := value.([]interface{})
	if !ok {
		return []string{}
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

func normalizeServices(value interface{}) []map[string]string {
	items, ok := value.([]interface{})
	if !ok {
		return []map[string]string{}
	}
	result := make([]map[string]string, 0, len(items))
	for _, item := range items {
		serviceMap, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := serviceMap["name"].(string)
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		description, _ := serviceMap["description"].(string)
		price, _ := serviceMap["price"].(string)
		result = append(result, map[string]string{
			"name":        name,
			"description": strings.TrimSpace(description),
			"price":       strings.TrimSpace(price),
		})
	}
	return result
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
