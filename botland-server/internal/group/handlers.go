package group

import (
	"database/sql"

	"github.com/go-chi/chi/v5"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/nicknnn/botland-server/internal/auth"
	"github.com/nicknnn/botland-server/internal/ws"
	"github.com/nicknnn/botland-server/pkg/protocol"
)

type Handler struct {
	db     *sql.DB
	hub    *ws.Hub
	logger *slog.Logger
}

func NewHandler(db *sql.DB, hub *ws.Hub, logger *slog.Logger) *Handler {
	return &Handler{db: db, hub: hub, logger: logger}
}

// CreateGroup POST /groups
func (h *Handler) CreateGroup(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)

	var req CreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "name is required"})
		return
	}

	groupID := "group_" + auth.NewULID()

	tx, err := h.db.Begin()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "db error"})
		return
	}
	defer tx.Rollback()

	// Create group
	_, err = tx.Exec(
		`INSERT INTO groups (id, name, description, owner_id) VALUES ($1, $2, $3, $4)`,
		groupID, req.Name, req.Description, citizenID,
	)
	if err != nil {
		h.logger.Error("create group", "error", err)
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "create failed"})
		return
	}

	// Add owner as member
	_, err = tx.Exec(
		`INSERT INTO group_members (id, group_id, citizen_id, role) VALUES ($1, $2, $3, 'owner')`,
		auth.NewULID(), groupID, citizenID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "add owner failed"})
		return
	}

	// Add initial members
	for _, mid := range req.MemberIDs {
		if mid == citizenID {
			continue
		}
		_, err = tx.Exec(
			`INSERT INTO group_members (id, group_id, citizen_id, role) VALUES ($1, $2, $3, 'member')
			 ON CONFLICT (group_id, citizen_id) DO NOTHING`,
			auth.NewULID(), groupID, mid,
		)
		if err != nil {
			h.logger.Error("add member", "error", err, "member", mid)
		}
	}

	if err := tx.Commit(); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "commit failed"})
		return
	}

	// Notify members via WS
	ownerName := h.getCitizenName(citizenID)
	for _, mid := range req.MemberIDs {
		if mid == citizenID {
			continue
		}
		h.hub.Send(mid, &protocol.Envelope{
			Type: protocol.TypeGroupMemberJoined,
			Payload: protocol.GroupNotification{
				GroupID:   groupID,
				GroupName: req.Name,
				ActorID:   citizenID,
				ActorName: ownerName,
				Action:    "joined",
			},
		})
	}

	h.logger.Info("group created", "id", groupID, "name", req.Name, "owner", citizenID, "members", len(req.MemberIDs)+1)

	msgID := h.storeSystemMessage(groupID, map[string]interface{}{
		"content_type": "system",
		"event": "group_created",
		"text": ownerName + " 创建了群聊「" + req.Name + "」",
		"actor_id": citizenID,
		"actor_name": ownerName,
		"group_name": req.Name,
	})
	h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{
		"content_type": "system",
		"event": "group_created",
		"text": ownerName + " 创建了群聊「" + req.Name + "」",
		"actor_id": citizenID,
		"actor_name": ownerName,
		"group_name": req.Name,
	})

	// Return created group
	grp := h.getGroupWithMembers(groupID)
	if grp != nil {
		writeJSON(w, http.StatusCreated, grp)
	} else {
		writeJSON(w, http.StatusCreated, map[string]string{"id": groupID, "name": req.Name})
	}
}

// ListGroups GET /groups
func (h *Handler) ListGroups(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)

	rows, err := h.db.Query(`
		SELECT g.id, g.name, g.avatar_url, g.description, COALESCE(g.announcement,''), COALESCE(g.muted_all,false), g.owner_id, g.max_members, g.status, g.created_at, g.updated_at,
			(SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) as member_count
		FROM groups g
		JOIN group_members gm ON gm.group_id = g.id AND gm.citizen_id = $1
		WHERE g.status = 'active'
		ORDER BY g.updated_at DESC
	`, citizenID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	defer rows.Close()

	var groups []GroupListItem
	for rows.Next() {
		var g GroupListItem
		var avatarURL, desc sql.NullString
		if err := rows.Scan(&g.ID, &g.Name, &avatarURL, &desc, &g.OwnerID, &g.MaxMembers, &g.Status, &g.CreatedAt, &g.UpdatedAt, &g.MemberCount); err != nil {
			continue
		}
		if avatarURL.Valid {
			g.AvatarURL = avatarURL.String
		}
		if desc.Valid {
			g.Description = desc.String
		}
		groups = append(groups, g)
	}

	if groups == nil {
		groups = []GroupListItem{}
	}
	writeJSON(w, http.StatusOK, groups)
}

// GetGroup GET /groups/:id
func (h *Handler) GetGroup(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")
	if citizenID == "" || groupID == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "missing params"})
		return
	}

	// Verify membership
	if !h.isMember(groupID, citizenID) {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "not a member"})
		return
	}

	grp := h.getGroupWithMembers(groupID)
	if grp == nil {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "group not found"})
		return
	}
	writeJSON(w, http.StatusOK, grp)
}

// UpdateGroup PUT /groups/:id
func (h *Handler) UpdateGroup(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")

	// Only owner/admin can update
	role := h.getMemberRole(groupID, citizenID)
	if role != "owner" && role != "admin" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "permission denied"})
		return
	}

	var req UpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}

	if req.Name != nil {
		h.db.Exec(`UPDATE groups SET name=$1, updated_at=NOW() WHERE id=$2`, *req.Name, groupID)
	}
	if req.Description != nil {
		h.db.Exec(`UPDATE groups SET description=$1, updated_at=NOW() WHERE id=$2`, *req.Description, groupID)
	}
	if req.AvatarURL != nil {
		h.db.Exec(`UPDATE groups SET avatar_url=$1, updated_at=NOW() WHERE id=$2`, *req.AvatarURL, groupID)
	}
	if req.Announcement != nil {
		h.db.Exec(`UPDATE groups SET announcement=$1, updated_at=NOW() WHERE id=$2`, *req.Announcement, groupID)
	}
	if req.MutedAll != nil {
		h.db.Exec(`UPDATE groups SET muted_all=$1, updated_at=NOW() WHERE id=$2`, *req.MutedAll, groupID)
	}

	// Notify members
	h.broadcastToGroup(groupID, citizenID, &protocol.Envelope{
		Type: protocol.TypeGroupUpdated,
		Payload: protocol.GroupNotification{
			GroupID: groupID,
			ActorID: citizenID,
			Action:  "updated",
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

// InviteMembers POST /groups/:id/members
func (h *Handler) InviteMembers(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")

	if !h.isMember(groupID, citizenID) {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "not a member"})
		return
	}

	var req InviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}

	// Check max members
	var count int
	h.db.QueryRow(`SELECT COUNT(*) FROM group_members WHERE group_id=$1`, groupID).Scan(&count)
	var maxMembers int
	h.db.QueryRow(`SELECT max_members FROM groups WHERE id=$1`, groupID).Scan(&maxMembers)
	if count+len(req.CitizenIDs) > maxMembers {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "exceeds max members"})
		return
	}

	added := 0
	actorName := h.getCitizenName(citizenID)
	groupName := h.getGroupName(groupID)

	for _, cid := range req.CitizenIDs {
		_, err := h.db.Exec(
			`INSERT INTO group_members (id, group_id, citizen_id, role) VALUES ($1, $2, $3, 'member')
			 ON CONFLICT (group_id, citizen_id) DO NOTHING`,
			auth.NewULID(), groupID, cid,
		)
		if err == nil {
			added++
			targetName := h.getCitizenName(cid)
			msgID := h.storeSystemMessage(groupID, map[string]interface{}{
				"content_type": "system",
				"event": "member_joined",
				"text": targetName + " 加入了群聊",
				"actor_id": citizenID,
				"actor_name": actorName,
				"target_id": cid,
				"target_name": targetName,
				"group_name": groupName,
			})
			h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{
				"content_type": "system",
				"event": "member_joined",
				"text": targetName + " 加入了群聊",
				"actor_id": citizenID,
				"actor_name": actorName,
				"target_id": cid,
				"target_name": targetName,
				"group_name": groupName,
			})
			// Notify the new member
			h.hub.Send(cid, &protocol.Envelope{
				Type: protocol.TypeGroupMemberJoined,
				Payload: protocol.GroupNotification{
					GroupID:   groupID,
					GroupName: groupName,
					ActorID:   citizenID,
					ActorName: actorName,
					TargetID:  cid,
					Action:    "joined",
				},
			})
		}
	}

	// Notify existing members
	h.broadcastToGroup(groupID, "", &protocol.Envelope{
		Type: protocol.TypeGroupMemberJoined,
		Payload: protocol.GroupNotification{
			GroupID:   groupID,
			GroupName: groupName,
			ActorID:   citizenID,
			ActorName: actorName,
			Action:    "joined",
		},
	})

	h.db.Exec(`UPDATE groups SET updated_at=NOW() WHERE id=$1`, groupID)
	writeJSON(w, http.StatusOK, map[string]int{"added": added})
}

// RemoveMember DELETE /groups/:id/members/:cid
func (h *Handler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")
	targetID := chi.URLParam(r, "citizenID")

	role := h.getMemberRole(groupID, citizenID)
	if role != "owner" && role != "admin" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "permission denied"})
		return
	}
	// Can't remove owner
	targetRole := h.getMemberRole(groupID, targetID)
	if targetRole == "owner" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "cannot remove owner"})
		return
	}

	targetName := h.getCitizenName(targetID)
	actorName := h.getCitizenName(citizenID)
	h.db.Exec(`DELETE FROM group_members WHERE group_id=$1 AND citizen_id=$2`, groupID, targetID)
	msgID := h.storeSystemMessage(groupID, map[string]interface{}{
		"content_type": "system",
		"event": "member_removed",
		"text": targetName + " 被移出了群聊",
		"actor_id": citizenID,
		"actor_name": actorName,
		"target_id": targetID,
		"target_name": targetName,
	})
	h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{
		"content_type": "system",
		"event": "member_removed",
		"text": targetName + " 被移出了群聊",
		"actor_id": citizenID,
		"actor_name": actorName,
		"target_id": targetID,
		"target_name": targetName,
	})

	h.broadcastToGroup(groupID, "", &protocol.Envelope{
		Type: protocol.TypeGroupMemberLeft,
		Payload: protocol.GroupNotification{
			GroupID:  groupID,
			ActorID:  citizenID,
			TargetID: targetID,
			Action:   "kicked",
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// UpdateMemberRole PUT /groups/:id/members/:cid/role
func (h *Handler) UpdateMemberRole(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")
	targetID := chi.URLParam(r, "citizenID")

	if h.getMemberRole(groupID, citizenID) != "owner" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "only owner can manage admins"})
		return
	}
	if targetID == citizenID {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "cannot change your own role"})
		return
	}

	var req struct { Role string `json:"role"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	if req.Role != "admin" && req.Role != "member" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "role must be admin or member"})
		return
	}
	if h.getMemberRole(groupID, targetID) == "owner" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "cannot change owner role"})
		return
	}

	if _, err := h.db.Exec(`UPDATE group_members SET role=$1 WHERE group_id=$2 AND citizen_id=$3`, req.Role, groupID, targetID); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "db error"})
		return
	}

	actorName := h.getCitizenName(citizenID)
	targetName := h.getCitizenName(targetID)
	actionText := targetName + " 被设为管理员"
	event := "member_promoted"
	if req.Role == "member" {
		actionText = targetName + " 被取消管理员"
		event = "member_demoted"
	}
	msgID := h.storeSystemMessage(groupID, map[string]interface{}{
		"content_type": "system",
		"event": event,
		"text": actionText,
		"actor_id": citizenID,
		"actor_name": actorName,
		"target_id": targetID,
		"target_name": targetName,
	})
	h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{
		"content_type": "system",
		"event": event,
		"text": actionText,
		"actor_id": citizenID,
		"actor_name": actorName,
		"target_id": targetID,
		"target_name": targetName,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

// LeaveGroup POST /groups/:id/leave
func (h *Handler) LeaveGroup(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")

	role := h.getMemberRole(groupID, citizenID)
	if role == "owner" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "owner cannot leave, transfer or disband"})
		return
	}
	if role == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "not a member"})
		return
	}

	actorName := h.getCitizenName(citizenID)
	h.db.Exec(`DELETE FROM group_members WHERE group_id=$1 AND citizen_id=$2`, groupID, citizenID)
	msgID := h.storeSystemMessage(groupID, map[string]interface{}{
		"content_type": "system",
		"event": "member_left",
		"text": actorName + " 退出了群聊",
		"actor_id": citizenID,
		"actor_name": actorName,
	})
	h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{
		"content_type": "system",
		"event": "member_left",
		"text": actorName + " 退出了群聊",
		"actor_id": citizenID,
		"actor_name": actorName,
	})

	h.broadcastToGroup(groupID, "", &protocol.Envelope{
		Type: protocol.TypeGroupMemberLeft,
		Payload: protocol.GroupNotification{
			GroupID:  groupID,
			ActorID:  citizenID,
			TargetID: citizenID,
			Action:   "left",
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "left"})
}

// DisbandGroup DELETE /groups/:id
func (h *Handler) DisbandGroup(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")

	role := h.getMemberRole(groupID, citizenID)
	if role != "owner" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "only owner can disband"})
		return
	}

	actorName := h.getCitizenName(citizenID)
	groupName := h.getGroupName(groupID)
	msgID := h.storeSystemMessage(groupID, map[string]interface{}{
		"content_type": "system",
		"event": "group_disbanded",
		"text": actorName + " 解散了群聊「" + groupName + "」",
		"actor_id": citizenID,
		"actor_name": actorName,
		"group_name": groupName,
	})
	h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{
		"content_type": "system",
		"event": "group_disbanded",
		"text": actorName + " 解散了群聊「" + groupName + "」",
		"actor_id": citizenID,
		"actor_name": actorName,
		"group_name": groupName,
	})

	h.broadcastToGroup(groupID, "", &protocol.Envelope{
		Type: protocol.TypeGroupUpdated,
		Payload: protocol.GroupNotification{
			GroupID: groupID,
			ActorID: citizenID,
			Action:  "disbanded",
		},
	})

	h.db.Exec(`UPDATE groups SET status='disbanded', updated_at=NOW() WHERE id=$1`, groupID)
	h.db.Exec(`DELETE FROM group_members WHERE group_id=$1`, groupID)

	writeJSON(w, http.StatusOK, map[string]string{"status": "disbanded"})
}

// TransferOwnership POST /groups/:id/transfer
func (h *Handler) TransferOwnership(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")
	if h.getMemberRole(groupID, citizenID) != "owner" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "only owner can transfer"})
		return
	}
	var req struct { CitizenID string `json:"citizen_id"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.CitizenID == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	if !h.isMember(groupID, req.CitizenID) {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "target is not a member"})
		return
	}
	_, _ = h.db.Exec(`UPDATE groups SET owner_id=$1, updated_at=NOW() WHERE id=$2`, req.CitizenID, groupID)
	_, _ = h.db.Exec(`UPDATE group_members SET role='member' WHERE group_id=$1 AND citizen_id=$2`, groupID, citizenID)
	_, _ = h.db.Exec(`UPDATE group_members SET role='owner' WHERE group_id=$1 AND citizen_id=$2`, groupID, req.CitizenID)
	actorName := h.getCitizenName(citizenID)
	targetName := h.getCitizenName(req.CitizenID)
	msgID := h.storeSystemMessage(groupID, map[string]interface{}{"content_type":"system","event":"owner_transferred","text":actorName + " 将群主转让给了 " + targetName,"actor_id":citizenID,"actor_name":actorName,"target_id":req.CitizenID,"target_name":targetName})
	h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{"content_type":"system","event":"owner_transferred","text":actorName + " 将群主转让给了 " + targetName,"actor_id":citizenID,"actor_name":actorName,"target_id":req.CitizenID,"target_name":targetName})
	writeJSON(w, http.StatusOK, map[string]string{"status":"updated"})
}

// ToggleMuteAll POST /groups/:id/mute-all
func (h *Handler) ToggleMuteAll(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")
	role := h.getMemberRole(groupID, citizenID)
	if role != "owner" && role != "admin" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "permission denied"})
		return
	}
	var req struct { Muted bool `json:"muted"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	_, _ = h.db.Exec(`UPDATE groups SET muted_all=$1, updated_at=NOW() WHERE id=$2`, req.Muted, groupID)
	actorName := h.getCitizenName(citizenID)
	text := actorName + " 开启了全员禁言"
	event := "mute_all_enabled"
	if !req.Muted { text = actorName + " 关闭了全员禁言"; event = "mute_all_disabled" }
	msgID := h.storeSystemMessage(groupID, map[string]interface{}{"content_type":"system","event":event,"text":text,"actor_id":citizenID,"actor_name":actorName})
	h.broadcastSystemMessage(groupID, msgID, map[string]interface{}{"content_type":"system","event":event,"text":text,"actor_id":citizenID,"actor_name":actorName})
	writeJSON(w, http.StatusOK, map[string]string{"status":"updated"})
}

// GetMessages GET /groups/:id/messages?before=&limit=
func (h *Handler) GetMessages(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	groupID := chi.URLParam(r, "groupID")

	if !h.isMember(groupID, citizenID) {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "not a member"})
		return
	}

	before := r.URL.Query().Get("before")
	limit := 50

	var rows *sql.Rows
	var err error
	if before != "" {
		rows, err = h.db.Query(`
			SELECT gm.id, gm.group_id, gm.sender_id, c.display_name, COALESCE(c.avatar_url,''), gm.payload, gm.created_at
			FROM group_messages gm
			JOIN citizens c ON c.id = gm.sender_id
			WHERE gm.group_id=$1 AND gm.created_at < (SELECT created_at FROM group_messages WHERE id=$2)
			ORDER BY gm.created_at DESC LIMIT $3
		`, groupID, before, limit)
	} else {
		rows, err = h.db.Query(`
			SELECT gm.id, gm.group_id, gm.sender_id, c.display_name, COALESCE(c.avatar_url,''), gm.payload, gm.created_at
			FROM group_messages gm
			JOIN citizens c ON c.id = gm.sender_id
			WHERE gm.group_id=$1
			ORDER BY gm.created_at DESC LIMIT $2
		`, groupID, limit)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	defer rows.Close()

	var messages []MessageItem
	for rows.Next() {
		var m MessageItem
		var payloadBytes []byte
		if err := rows.Scan(&m.ID, &m.GroupID, &m.SenderID, &m.SenderName, &m.AvatarURL, &payloadBytes, &m.CreatedAt); err != nil {
			continue
		}
		json.Unmarshal(payloadBytes, &m.Payload)
		messages = append(messages, m)
	}

	if messages == nil {
		messages = []MessageItem{}
	}
	writeJSON(w, http.StatusOK, messages)
}

// --- Helpers ---

func (h *Handler) isMember(groupID, citizenID string) bool {
	var exists bool
	h.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id=$1 AND citizen_id=$2)`, groupID, citizenID).Scan(&exists)
	return exists
}

func (h *Handler) getMemberRole(groupID, citizenID string) string {
	var role string
	err := h.db.QueryRow(`SELECT role FROM group_members WHERE group_id=$1 AND citizen_id=$2`, groupID, citizenID).Scan(&role)
	if err != nil {
		return ""
	}
	return role
}

func (h *Handler) getCitizenName(citizenID string) string {
	var name string
	h.db.QueryRow(`SELECT display_name FROM citizens WHERE id=$1`, citizenID).Scan(&name)
	return name
}

func (h *Handler) getGroupName(groupID string) string {
	var name string
	h.db.QueryRow(`SELECT name FROM groups WHERE id=$1`, groupID).Scan(&name)
	return name
}

func (h *Handler) getGroupWithMembers(groupID string) *GroupWithMembers {
	var g GroupWithMembers
	var avatarURL, desc sql.NullString
	err := h.db.QueryRow(`
		SELECT id, name, avatar_url, description, COALESCE(announcement,''), COALESCE(muted_all,false), owner_id, max_members, status, created_at, updated_at
		FROM groups WHERE id=$1
	`, groupID).Scan(&g.ID, &g.Name, &avatarURL, &desc, &g.OwnerID, &g.MaxMembers, &g.Status, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return nil
	}
	if avatarURL.Valid {
		g.AvatarURL = avatarURL.String
	}
	if desc.Valid {
		g.Description = desc.String
	}

	rows, err := h.db.Query(`
		SELECT gm.id, gm.group_id, gm.citizen_id, gm.role, COALESCE(gm.nickname,''), gm.muted, gm.joined_at,
			c.display_name, COALESCE(c.avatar_url,''), c.citizen_type
		FROM group_members gm
		JOIN citizens c ON c.id = gm.citizen_id
		WHERE gm.group_id=$1
		ORDER BY gm.joined_at ASC
	`, groupID)
	if err != nil {
		return &g
	}
	defer rows.Close()

	for rows.Next() {
		var m MemberWithInfo
		if err := rows.Scan(&m.ID, &m.GroupID, &m.CitizenID, &m.Role, &m.Nickname, &m.Muted, &m.JoinedAt,
			&m.DisplayName, &m.AvatarURL, &m.CitizenType); err != nil {
			continue
		}
		g.Members = append(g.Members, m)
	}
	g.MemberCount = len(g.Members)
	return &g
}

// GetGroupMembers returns all member IDs for a group.
func (h *Handler) GetGroupMembers(groupID string) []string {
	rows, err := h.db.Query(`SELECT citizen_id FROM group_members WHERE group_id=$1`, groupID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids
}

// StoreGroupMessage persists a group message and returns its ID.
func (h *Handler) StoreGroupMessage(msgID, groupID, senderID string, payload interface{}) error {
	payloadBytes, _ := json.Marshal(payload)
	_, err := h.db.Exec(
		`INSERT INTO group_messages (id, group_id, sender_id, payload) VALUES ($1, $2, $3, $4)`,
		msgID, groupID, senderID, payloadBytes,
	)
	if err != nil {
		h.logger.Error("store group message", "error", err)
	}
	return err
}

func (h *Handler) broadcastToGroup(groupID, excludeID string, env *protocol.Envelope) {
	members := h.GetGroupMembers(groupID)
	for _, mid := range members {
		if mid == excludeID {
			continue
		}
		h.hub.Send(mid, env)
	}
}


func (h *Handler) storeSystemMessage(groupID string, payload map[string]interface{}) string {
	msgID := "msg_" + auth.NewULID()
	payloadBytes, _ := json.Marshal(payload)
	_, _ = h.db.Exec(`INSERT INTO group_messages (id, group_id, sender_id, payload) VALUES ($1, $2, $3, $4)`, msgID, groupID, "system", payloadBytes)
	return msgID
}

func (h *Handler) broadcastSystemMessage(groupID, msgID string, payload map[string]interface{}) {
	h.broadcastToGroup(groupID, "", &protocol.Envelope{
		Type:      protocol.TypeGroupMessageReceived,
		ID:        msgID,
		From:      "system",
		To:        groupID,
		Payload:   payload,
	})
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}




func (h *Handler) IsMutedAll(groupID string) bool {
	var muted bool
	_ = h.db.QueryRow(`SELECT COALESCE(muted_all,false) FROM groups WHERE id=$1`, groupID).Scan(&muted)
	return muted
}

func (h *Handler) GetMemberRole(groupID, citizenID string) string {
	return h.getMemberRole(groupID, citizenID)
}
