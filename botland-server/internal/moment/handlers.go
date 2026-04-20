package moment

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/nicknnn/botland-server/internal/auth"
)

type Handler struct {
	db     *sql.DB
	logger *slog.Logger
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{db: db, logger: logger}
}

type CreateMomentBody struct {
	ContentType string                 `json:"content_type"`
	Content     map[string]interface{} `json:"content"`
	Visibility  string                 `json:"visibility"`
}

// CreateMoment posts a new moment
func (h *Handler) CreateMoment(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)

	var body CreateMomentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "VALIDATION_ERROR", "invalid body")
		return
	}
	if body.ContentType == "" {
		body.ContentType = "text"
	}
	if body.Visibility == "" {
		body.Visibility = "friends_only"
	}

	// Validate content_type
	validTypes := map[string]bool{"text": true, "image": true, "video": true, "link": true, "mixed": true}
	if !validTypes[body.ContentType] {
		writeError(w, 400, "VALIDATION_ERROR", "invalid content_type")
		return
	}
	validVis := map[string]bool{"public": true, "friends_only": true, "private": true}
	if !validVis[body.Visibility] {
		writeError(w, 400, "VALIDATION_ERROR", "invalid visibility")
		return
	}

	contentJSON, _ := json.Marshal(body.Content)
	momentID := auth.NewULID()

	_, err := h.db.Exec(
		"INSERT INTO moments (id, author_id, content_type, content, visibility) VALUES ($1, $2, $3, $4, $5)",
		momentID, citizenID, body.ContentType, contentJSON, body.Visibility,
	)
	if err != nil {
		h.logger.Error("insert moment", "error", err)
		writeError(w, 500, "INTERNAL", "server error")
		return
	}

	writeJSON(w, 201, map[string]interface{}{
		"moment_id":    momentID,
		"content_type": body.ContentType,
		"visibility":   body.Visibility,
		"created_at":   time.Now().UTC().Format(time.RFC3339),
	})
}

// Timeline returns moments from friends (and public moments)
func (h *Handler) Timeline(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	cursor := r.URL.Query().Get("cursor")
	limitStr := r.URL.Query().Get("limit")
	limit := 20
	if limitStr != "" {
		if l := atoi(limitStr); l > 0 && l <= 50 {
			limit = l
		}
	}

	// Get moments from:
	// 1. Friends (friends_only or public)
	// 2. Self (any visibility)
	// 3. Public moments from anyone
	query := `
		SELECT m.id, m.author_id, m.content_type, m.content, m.visibility, m.created_at,
			c.display_name, c.avatar_url, c.citizen_type, c.species,
			(SELECT COUNT(*) FROM moment_interactions mi WHERE mi.moment_id = m.id AND mi.type = 'like') AS like_count,
			(SELECT COUNT(*) FROM moment_interactions mi WHERE mi.moment_id = m.id AND mi.type = 'comment') AS comment_count,
			EXISTS(SELECT 1 FROM moment_interactions mi WHERE mi.moment_id = m.id AND mi.citizen_id = $1 AND mi.type = 'like') AS liked_by_me
		FROM moments m
		JOIN citizens c ON c.id = m.author_id
		WHERE m.status = 'active'
			AND (
				m.author_id = $1
				OR m.visibility = 'public'
				OR (m.visibility = 'friends_only' AND EXISTS(
					SELECT 1 FROM relationships r
					WHERE r.status = 'active'
						AND ((r.citizen_a_id = $1 AND r.citizen_b_id = m.author_id)
							OR (r.citizen_b_id = $1 AND r.citizen_a_id = m.author_id))
				))
			)
	`
	args := []interface{}{citizenID}
	argIdx := 2

	if cursor != "" {
		query += ` AND m.created_at < $` + itoa(argIdx)
		args = append(args, cursor)
		argIdx++
	}

	query += ` ORDER BY m.created_at DESC LIMIT $` + itoa(argIdx)
	args = append(args, limit)

	rows, err := h.db.Query(query, args...)
	if err != nil {
		h.logger.Error("query timeline", "error", err)
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	defer rows.Close()

	var moments []map[string]interface{}
	var lastCreatedAt string
	for rows.Next() {
		var id, authorID, contentType, visibility, createdAt string
		var content []byte
		var displayName, avatarURL, citizenType, species sql.NullString
		var likeCount, commentCount int
		var likedByMe bool

		rows.Scan(&id, &authorID, &contentType, &content, &visibility, &createdAt,
			&displayName, &avatarURL, &citizenType, &species,
			&likeCount, &commentCount, &likedByMe)

		var contentMap map[string]interface{}
		json.Unmarshal(content, &contentMap)

		moments = append(moments, map[string]interface{}{
			"moment_id":     id,
			"author_id":     authorID,
			"content_type":  contentType,
			"content":       contentMap,
			"visibility":    visibility,
			"created_at":    createdAt,
			"display_name":  displayName.String,
			"avatar_url":    avatarURL.String,
			"citizen_type":  citizenType.String,
			"species":       species.String,
			"like_count":    likeCount,
			"comment_count": commentCount,
			"liked_by_me":   likedByMe,
		})
		lastCreatedAt = createdAt
	}
	if moments == nil {
		moments = []map[string]interface{}{}
	}

	result := map[string]interface{}{
		"moments": moments,
		"total":   len(moments),
	}
	if len(moments) == limit {
		result["next_cursor"] = lastCreatedAt
	}
	writeJSON(w, 200, result)
}

// GetMoment returns a single moment with its interactions
func (h *Handler) GetMoment(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	momentID := chi.URLParam(r, "momentID")

	var id, authorID, contentType, visibility, createdAt string
	var content []byte
	var displayName, avatarURL, citizenType, species sql.NullString

	err := h.db.QueryRow(`
		SELECT m.id, m.author_id, m.content_type, m.content, m.visibility, m.created_at,
			c.display_name, c.avatar_url, c.citizen_type, c.species
		FROM moments m JOIN citizens c ON c.id = m.author_id
		WHERE m.id = $1 AND m.status = 'active'`, momentID).
		Scan(&id, &authorID, &contentType, &content, &visibility, &createdAt,
			&displayName, &avatarURL, &citizenType, &species)

	if err == sql.ErrNoRows {
		writeError(w, 404, "NOT_FOUND", "moment not found")
		return
	}
	if err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}

	// Check visibility
	if visibility == "private" && authorID != citizenID {
		writeError(w, 403, "FORBIDDEN", "private moment")
		return
	}
	if visibility == "friends_only" && authorID != citizenID {
		var isFriend bool
		aID, bID := sortIDs(citizenID, authorID)
		h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM relationships WHERE citizen_a_id=$1 AND citizen_b_id=$2 AND status='active')", aID, bID).Scan(&isFriend)
		if !isFriend {
			writeError(w, 403, "FORBIDDEN", "friends only")
			return
		}
	}

	var contentMap map[string]interface{}
	json.Unmarshal(content, &contentMap)

	// Get comments
	commentRows, _ := h.db.Query(`
		SELECT mi.id, mi.citizen_id, mi.content, mi.created_at, c.display_name, c.avatar_url
		FROM moment_interactions mi JOIN citizens c ON c.id = mi.citizen_id
		WHERE mi.moment_id = $1 AND mi.type = 'comment'
		ORDER BY mi.created_at ASC LIMIT 50`, momentID)
	defer commentRows.Close()

	var comments []map[string]interface{}
	for commentRows.Next() {
		var cID, cCitizenID, cContent, cCreatedAt string
		var cName, cAvatar sql.NullString
		commentRows.Scan(&cID, &cCitizenID, &cContent, &cCreatedAt, &cName, &cAvatar)
		comments = append(comments, map[string]interface{}{
			"id": cID, "citizen_id": cCitizenID, "content": cContent,
			"created_at": cCreatedAt, "display_name": cName.String, "avatar_url": cAvatar.String,
		})
	}
	if comments == nil {
		comments = []map[string]interface{}{}
	}

	// Like count + liked_by_me
	var likeCount int
	var likedByMe bool
	h.db.QueryRow("SELECT COUNT(*) FROM moment_interactions WHERE moment_id=$1 AND type='like'", momentID).Scan(&likeCount)
	h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM moment_interactions WHERE moment_id=$1 AND citizen_id=$2 AND type='like')", momentID, citizenID).Scan(&likedByMe)

	writeJSON(w, 200, map[string]interface{}{
		"moment_id": id, "author_id": authorID, "content_type": contentType,
		"content": contentMap, "visibility": visibility, "created_at": createdAt,
		"display_name": displayName.String, "avatar_url": avatarURL.String,
		"citizen_type": citizenType.String, "species": species.String,
		"like_count": likeCount, "liked_by_me": likedByMe,
		"comments": comments,
	})
}

// LikeMoment toggles a like
func (h *Handler) LikeMoment(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	momentID := chi.URLParam(r, "momentID")

	// Verify moment exists
	var exists bool
	h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM moments WHERE id=$1 AND status='active')", momentID).Scan(&exists)
	if !exists {
		writeError(w, 404, "NOT_FOUND", "moment not found")
		return
	}

	// Toggle: if already liked, unlike
	var alreadyLiked bool
	h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM moment_interactions WHERE moment_id=$1 AND citizen_id=$2 AND type='like')", momentID, citizenID).Scan(&alreadyLiked)

	if alreadyLiked {
		h.db.Exec("DELETE FROM moment_interactions WHERE moment_id=$1 AND citizen_id=$2 AND type='like'", momentID, citizenID)
		writeJSON(w, 200, map[string]interface{}{"liked": false})
	} else {
		likeID := auth.NewULID()
		h.db.Exec("INSERT INTO moment_interactions (id, moment_id, citizen_id, type) VALUES ($1, $2, $3, 'like')", likeID, momentID, citizenID)
		writeJSON(w, 200, map[string]interface{}{"liked": true})
	}
}

// CommentMoment adds a comment
func (h *Handler) CommentMoment(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	momentID := chi.URLParam(r, "momentID")

	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Content == "" {
		writeError(w, 400, "VALIDATION_ERROR", "content is required")
		return
	}
	if len(body.Content) > 500 {
		writeError(w, 400, "VALIDATION_ERROR", "comment too long (max 500)")
		return
	}

	// Verify moment exists
	var exists bool
	h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM moments WHERE id=$1 AND status='active')", momentID).Scan(&exists)
	if !exists {
		writeError(w, 404, "NOT_FOUND", "moment not found")
		return
	}

	commentID := auth.NewULID()
	_, err := h.db.Exec(
		"INSERT INTO moment_interactions (id, moment_id, citizen_id, type, content) VALUES ($1, $2, $3, 'comment', $4)",
		commentID, momentID, citizenID, body.Content,
	)
	if err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}

	writeJSON(w, 201, map[string]interface{}{
		"comment_id": commentID,
		"moment_id":  momentID,
		"content":    body.Content,
		"created_at": time.Now().UTC().Format(time.RFC3339),
	})
}

// DeleteMoment soft-deletes a moment
func (h *Handler) DeleteMoment(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	momentID := chi.URLParam(r, "momentID")

	var authorID string
	err := h.db.QueryRow("SELECT author_id FROM moments WHERE id=$1 AND status='active'", momentID).Scan(&authorID)
	if err == sql.ErrNoRows {
		writeError(w, 404, "NOT_FOUND", "moment not found")
		return
	}
	if authorID != citizenID {
		writeError(w, 403, "FORBIDDEN", "not your moment")
		return
	}

	h.db.Exec("UPDATE moments SET status='deleted' WHERE id=$1", momentID)
	writeJSON(w, 200, map[string]string{"status": "deleted"})
}

// helpers
func sortIDs(a, b string) (string, string) {
	if a < b {
		return a, b
	}
	return b, a
}
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{"error": map[string]interface{}{"code": code, "message": message, "status": status}})
}
func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		}
	}
	return n
}
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
