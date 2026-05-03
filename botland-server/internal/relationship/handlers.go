package relationship

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
	db          *sql.DB
	logger      *slog.Logger
	isOnlineFunc func(string) bool
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{db: db, logger: logger}
}

// SetIsOnlineFunc sets the function used to check citizen online status.
func (h *Handler) SetIsOnlineFunc(fn func(string) bool) {
	h.isOnlineFunc = fn
}

type SendRequestBody struct {
	TargetID string `json:"target_id"`
	Greeting string `json:"greeting,omitempty"`
}

type UpdateLabelBody struct {
	Label string `json:"label"`
}

type relationshipSummaryGroup struct {
	GroupID   string `json:"group_id"`
	GroupName string `json:"group_name"`
}

type relationshipSummaryBot struct {
	BotID   string `json:"bot_id"`
	BotName string `json:"bot_name"`
}

type RelationshipSummaryResponse struct {
	TargetCitizenID    string                     `json:"target_citizen_id"`
	RelationshipStatus string                     `json:"relationship_status"`
	FriendRequestID    *string                    `json:"friend_request_id"`
	FriendsSince       *string                    `json:"friends_since"`
	MyLabel            *string                    `json:"my_label"`
	TheirLabel         *string                    `json:"their_label"`
	DMCount            int                        `json:"dm_count"`
	SharedGroups       []relationshipSummaryGroup `json:"shared_groups"`
	SharedBots         []relationshipSummaryBot   `json:"shared_bots"`
	IsOnline           bool                       `json:"is_online"`
}

// SendFriendRequest creates a friend request
func (h *Handler) SendFriendRequest(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)

	var body SendRequestBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TargetID == "" {
		writeError(w, 400, "VALIDATION_ERROR", "target_id is required")
		return
	}
	if body.TargetID == citizenID {
		writeError(w, 400, "SELF_ACTION", "cannot send friend request to yourself")
		return
	}

	// Check target exists
	var exists bool
	h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM citizens WHERE id=$1 AND status='active')", body.TargetID).Scan(&exists)
	if !exists {
		writeError(w, 404, "NOT_FOUND", "citizen not found")
		return
	}

	// Check not already friends
	aID, bID := sortIDs(citizenID, body.TargetID)
	var relStatus string
	err := h.db.QueryRow("SELECT status FROM relationships WHERE citizen_a_id=$1 AND citizen_b_id=$2", aID, bID).Scan(&relStatus)
	if err == nil {
		if relStatus == "active" {
			writeError(w, 400, "ALREADY_FRIENDS", "already friends")
			return
		}
		if relStatus == "blocked" {
			writeError(w, 403, "FORBIDDEN", "cannot send request")
			return
		}
	}

	// Check no pending request
	var pendingExists bool
	h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2 AND status='pending')", citizenID, body.TargetID).Scan(&pendingExists)
	if pendingExists {
		writeError(w, 400, "ALREADY_EXISTS", "friend request already pending")
		return
	}

	reqID := auth.NewULID()
	_, err = h.db.Exec(
		"INSERT INTO friend_requests (id, from_id, to_id, greeting) VALUES ($1, $2, $3, $4)",
		reqID, citizenID, body.TargetID, nilStr(body.Greeting),
	)
	if err != nil {
		h.logger.Error("insert friend request", "error", err)
		writeError(w, 500, "INTERNAL", "server error")
		return
	}

	writeJSON(w, 201, map[string]string{"request_id": reqID, "status": "pending"})
}

// ListFriendRequests returns incoming or outgoing requests
func (h *Handler) ListFriendRequests(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	direction := r.URL.Query().Get("direction")
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}

	var rows *sql.Rows
	var err error
	if direction == "outgoing" {
		rows, err = h.db.Query(
			`SELECT fr.id, fr.from_id, fr.to_id, fr.greeting, fr.status, fr.created_at, c.display_name, c.avatar_url, c.citizen_type, c.species
			 FROM friend_requests fr JOIN citizens c ON c.id = fr.to_id
			 WHERE fr.from_id=$1 AND fr.status=$2 ORDER BY fr.created_at DESC`, citizenID, status)
	} else {
		rows, err = h.db.Query(
			`SELECT fr.id, fr.from_id, fr.to_id, fr.greeting, fr.status, fr.created_at, c.display_name, c.avatar_url, c.citizen_type, c.species
			 FROM friend_requests fr JOIN citizens c ON c.id = fr.from_id
			 WHERE fr.to_id=$1 AND fr.status=$2 ORDER BY fr.created_at DESC`, citizenID, status)
	}
	if err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	defer rows.Close()

	var requests []map[string]interface{}
	for rows.Next() {
		var id, fromID, toID, reqStatus string
		var greeting, displayName, avatarURL, citizenType, species sql.NullString
		var createdAt time.Time
		rows.Scan(&id, &fromID, &toID, &greeting, &reqStatus, &createdAt, &displayName, &avatarURL, &citizenType, &species)
		requests = append(requests, map[string]interface{}{
			"request_id":   id,
			"from_id":      fromID,
			"to_id":        toID,
			"greeting":     greeting.String,
			"status":       reqStatus,
			"created_at":   createdAt.Format(time.RFC3339),
			"display_name": displayName.String,
			"avatar_url":   avatarURL.String,
			"citizen_type": citizenType.String,
			"species":      species.String,
		})
	}
	if requests == nil {
		requests = []map[string]interface{}{}
	}
	writeJSON(w, 200, map[string]interface{}{"requests": requests, "total": len(requests)})
}

// GetRelationshipSummary returns aggregate relationship context for a target citizen.
func (h *Handler) GetRelationshipSummary(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	targetID := chi.URLParam(r, "citizenID")
	if targetID == "" {
		writeError(w, 400, "VALIDATION_ERROR", "citizenID is required")
		return
	}

	var exists bool
	if err := h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM citizens WHERE id=$1 AND status='active')", targetID).Scan(&exists); err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	if !exists {
		writeError(w, 404, "NOT_FOUND", "citizen not found")
		return
	}

	resp := RelationshipSummaryResponse{
		TargetCitizenID:    targetID,
		RelationshipStatus: "none",
		DMCount:            0,
		SharedGroups:       []relationshipSummaryGroup{},
		SharedBots:         []relationshipSummaryBot{},
		IsOnline:           h.isOnlineFunc != nil && h.isOnlineFunc(targetID),
	}

	aID, bID := sortIDs(citizenID, targetID)
	var status string
	var myLabel, theirLabel sql.NullString
	var createdAt time.Time
	err := h.db.QueryRow(`
		SELECT r.status,
			CASE WHEN r.citizen_a_id = $1 THEN r.label_a_to_b ELSE r.label_b_to_a END AS my_label,
			CASE WHEN r.citizen_a_id = $1 THEN r.label_b_to_a ELSE r.label_a_to_b END AS their_label,
			r.created_at
		FROM relationships r
		WHERE r.citizen_a_id=$2 AND r.citizen_b_id=$3
	`, citizenID, aID, bID).Scan(&status, &myLabel, &theirLabel, &createdAt)
	if err != nil && err != sql.ErrNoRows {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	if err == nil {
		if myLabel.Valid {
			resp.MyLabel = &myLabel.String
		}
		if theirLabel.Valid {
			resp.TheirLabel = &theirLabel.String
		}
		switch status {
		case "active":
			resp.RelationshipStatus = "friends"
			formatted := createdAt.Format(time.RFC3339)
			resp.FriendsSince = &formatted
		case "blocked":
			resp.RelationshipStatus = "blocked"
		}
	}

	if resp.RelationshipStatus == "none" {
		var requestID, fromID string
		err = h.db.QueryRow(`
			SELECT id, from_id
			FROM friend_requests
			WHERE ((from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)) AND status='pending'
			ORDER BY created_at DESC
			LIMIT 1
		`, citizenID, targetID).Scan(&requestID, &fromID)
		if err != nil && err != sql.ErrNoRows {
			writeError(w, 500, "INTERNAL", "server error")
			return
		}
		if err == nil {
			resp.FriendRequestID = &requestID
			if fromID == citizenID {
				resp.RelationshipStatus = "request_sent"
			} else {
				resp.RelationshipStatus = "request_received"
			}
		}
	}

	if err := h.db.QueryRow(`
		SELECT COUNT(*)
		FROM message_relay mr
		WHERE (mr.from_id = $1 AND mr.to_id = $2) OR (mr.from_id = $2 AND mr.to_id = $1)
	`, citizenID, targetID).Scan(&resp.DMCount); err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}

	groupRows, err := h.db.Query(`
		SELECT g.id, g.name
		FROM groups g
		JOIN group_members gm1 ON gm1.group_id = g.id
		JOIN group_members gm2 ON gm2.group_id = g.id
		WHERE gm1.citizen_id = $1 AND gm2.citizen_id = $2 AND g.status = 'active'
		ORDER BY g.updated_at DESC
		LIMIT 5
	`, citizenID, targetID)
	if err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	for groupRows.Next() {
		var group relationshipSummaryGroup
		if scanErr := groupRows.Scan(&group.GroupID, &group.GroupName); scanErr == nil {
			resp.SharedGroups = append(resp.SharedGroups, group)
		}
	}
	groupRows.Close()

	botRows, err := h.db.Query(`
		SELECT DISTINCT c.id, c.display_name
		FROM bot_card_bindings b1
		JOIN bot_card_bindings b2 ON b1.card_id = b2.card_id
		JOIN bot_cards bc ON bc.id = b1.card_id
		JOIN citizens c ON c.id = bc.bot_id
		WHERE b1.citizen_id = $1 AND b2.citizen_id = $2
			AND b1.status = 'connected' AND b2.status = 'connected'
		ORDER BY c.display_name
		LIMIT 5
	`, citizenID, targetID)
	if err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	for botRows.Next() {
		var bot relationshipSummaryBot
		if scanErr := botRows.Scan(&bot.BotID, &bot.BotName); scanErr == nil {
			resp.SharedBots = append(resp.SharedBots, bot)
		}
	}
	botRows.Close()

	writeJSON(w, 200, resp)
}

// AcceptFriendRequest accepts a pending request
func (h *Handler) AcceptFriendRequest(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	requestID := chi.URLParam(r, "requestID")

	var fromID, toID, status string
	err := h.db.QueryRow("SELECT from_id, to_id, status FROM friend_requests WHERE id=$1", requestID).Scan(&fromID, &toID, &status)
	if err == sql.ErrNoRows {
		writeError(w, 404, "NOT_FOUND", "request not found")
		return
	}
	if toID != citizenID {
		writeError(w, 403, "FORBIDDEN", "not your request")
		return
	}
	if status != "pending" {
		writeError(w, 400, "VALIDATION_ERROR", "request is not pending")
		return
	}

	tx, _ := h.db.Begin()
	defer tx.Rollback()

	tx.Exec("UPDATE friend_requests SET status='accepted', resolved_at=NOW() WHERE id=$1", requestID)

	aID, bID := sortIDs(fromID, toID)
	relID := auth.NewULID()
	tx.Exec(
		`INSERT INTO relationships (id, citizen_a_id, citizen_b_id, status, initiated_by)
		 VALUES ($1, $2, $3, 'active', $4) ON CONFLICT (citizen_a_id, citizen_b_id) DO UPDATE SET status='active', updated_at=NOW()`,
		relID, aID, bID, fromID,
	)

	tx.Commit()
	writeJSON(w, 200, map[string]string{"status": "accepted"})
}

// RejectFriendRequest rejects a pending request
func (h *Handler) RejectFriendRequest(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	requestID := chi.URLParam(r, "requestID")

	var toID, status string
	err := h.db.QueryRow("SELECT to_id, status FROM friend_requests WHERE id=$1", requestID).Scan(&toID, &status)
	if err == sql.ErrNoRows {
		writeError(w, 404, "NOT_FOUND", "request not found")
		return
	}
	if toID != citizenID {
		writeError(w, 403, "FORBIDDEN", "not your request")
		return
	}

	h.db.Exec("UPDATE friend_requests SET status='rejected', resolved_at=NOW() WHERE id=$1", requestID)
	writeJSON(w, 200, map[string]string{"status": "rejected"})
}

// ListFriends returns the friend list
func (h *Handler) ListFriends(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)

	rows, err := h.db.Query(`
		SELECT c.id, c.display_name, c.citizen_type, c.avatar_url, c.species,
			CASE WHEN r.citizen_a_id = $1 THEN r.label_a_to_b ELSE r.label_b_to_a END AS my_label,
			CASE WHEN r.citizen_a_id = $1 THEN r.label_b_to_a ELSE r.label_a_to_b END AS their_label
		FROM relationships r
		JOIN citizens c ON c.id = CASE WHEN r.citizen_a_id = $1 THEN r.citizen_b_id ELSE r.citizen_a_id END
		WHERE (r.citizen_a_id = $1 OR r.citizen_b_id = $1) AND r.status = 'active'
		ORDER BY c.display_name`, citizenID)
	if err != nil {
		writeError(w, 500, "INTERNAL", "server error")
		return
	}
	defer rows.Close()

	var friends []map[string]interface{}
	for rows.Next() {
		var id, displayName, citizenType string
		var avatarURL, species, myLabel, theirLabel sql.NullString
		rows.Scan(&id, &displayName, &citizenType, &avatarURL, &species, &myLabel, &theirLabel)
		isOnline := false
		if h.isOnlineFunc != nil {
			isOnline = h.isOnlineFunc(id)
		}
		friends = append(friends, map[string]interface{}{
			"citizen_id":   id,
			"display_name": displayName,
			"citizen_type": citizenType,
			"avatar_url":   avatarURL.String,
			"species":      species.String,
			"my_label":     myLabel.String,
			"their_label":  theirLabel.String,
			"is_online":    isOnline,
		})
	}
	if friends == nil {
		friends = []map[string]interface{}{}
	}
	writeJSON(w, 200, map[string]interface{}{"friends": friends, "total": len(friends)})
}

// UpdateLabel updates my label for a friend
func (h *Handler) UpdateLabel(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	friendID := chi.URLParam(r, "citizenID")

	var body UpdateLabelBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "VALIDATION_ERROR", "invalid body")
		return
	}

	aID, bID := sortIDs(citizenID, friendID)
	var col string
	if citizenID == aID {
		col = "label_a_to_b"
	} else {
		col = "label_b_to_a"
	}

	res, _ := h.db.Exec("UPDATE relationships SET "+col+"=$1, updated_at=NOW() WHERE citizen_a_id=$2 AND citizen_b_id=$3 AND status='active'", body.Label, aID, bID)
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, 404, "NOT_FOUND", "relationship not found")
		return
	}
	writeJSON(w, 200, map[string]string{"status": "updated"})
}

// RemoveFriend ends a friendship
func (h *Handler) RemoveFriend(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	friendID := chi.URLParam(r, "citizenID")
	aID, bID := sortIDs(citizenID, friendID)

	h.db.Exec("UPDATE relationships SET status='ended', updated_at=NOW() WHERE citizen_a_id=$1 AND citizen_b_id=$2", aID, bID)
	writeJSON(w, 200, map[string]string{"status": "removed"})
}

// BlockCitizen blocks someone
func (h *Handler) BlockCitizen(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	targetID := chi.URLParam(r, "citizenID")
	aID, bID := sortIDs(citizenID, targetID)

	h.db.Exec(`INSERT INTO relationships (id, citizen_a_id, citizen_b_id, status, initiated_by) VALUES ($1,$2,$3,'blocked',$4)
		ON CONFLICT (citizen_a_id, citizen_b_id) DO UPDATE SET status='blocked', updated_at=NOW()`,
		auth.NewULID(), aID, bID, citizenID)
	writeJSON(w, 200, map[string]string{"status": "blocked"})
}

// helpers
func sortIDs(a, b string) (string, string) {
	if a < b {
		return a, b
	}
	return b, a
}
func nilStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
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
