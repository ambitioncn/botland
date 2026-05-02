package relay

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nicknnn/botland-server/internal/auth"
	"github.com/nicknnn/botland-server/internal/ws"
	"github.com/nicknnn/botland-server/pkg/protocol"
)

// PushFunc sends a push notification to a citizen
type PushFunc func(citizenID, title, body string, data map[string]string) error

type Service struct {
	db           *sql.DB
	hub          *ws.Hub
	logger       *slog.Logger
	pushFunc     PushFunc
	groupHandler GroupHandler
}

// GroupHandler interface for group operations (avoid circular import)
type GroupHandler interface {
	GetGroupMembers(groupID string) []string
	StoreGroupMessage(msgID, groupID, senderID string, payload interface{}) error
	GetMemberRole(groupID, citizenID string) string
	IsMutedAll(groupID string) bool
}

func NewService(db *sql.DB, hub *ws.Hub, logger *slog.Logger) *Service {
	return &Service{db: db, hub: hub, logger: logger}
}

func (s *Service) SetGroupHandler(gh GroupHandler) {
	s.groupHandler = gh
}

func (s *Service) SetPushFunc(fn PushFunc) {
	s.pushFunc = fn
}

// getSenderName looks up the display name for a citizen
func (s *Service) getSenderName(citizenID string) string {
	var name string
	err := s.db.QueryRow(`SELECT display_name FROM citizens WHERE id=$1`, citizenID).Scan(&name)
	if err != nil {
		return "新消息"
	}
	return name
}

// RouteMessage handles an incoming message: deliver in real-time or store offline.
func (s *Service) RouteMessage(from string, env *protocol.Envelope) {
	// Route to group if target is a group ID
	if strings.HasPrefix(env.To, "group_") {
		s.RouteGroupMessage(from, env)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if env.Timestamp == "" {
		env.Timestamp = now
	}
	if env.ID == "" {
		env.ID = "msg_" + auth.NewULID()
	}

	delivered := &protocol.Envelope{
		Type:      protocol.TypeMessageReceived,
		ID:        env.ID,
		From:      from,
		To:        env.To,
		Timestamp: env.Timestamp,
		Payload:   env.Payload,
	}

	if s.hub.Send(env.To, delivered) {
		// Online: send ACK back to sender
		s.hub.Send(from, &protocol.Envelope{
			Type: protocol.TypeMessageStatus,
			Payload: protocol.AckPayload{
				MessageID: env.ID,
				Status:    "delivered",
			},
		})
		s.logger.Info("message delivered realtime", "from", from, "to", env.To, "id", env.ID)
	} else {
		// Offline: store in relay + send push notification
		s.storeOffline(from, env)
		s.logger.Info("message stored offline", "from", from, "to", env.To, "id", env.ID)

		// Send push notification
		if s.pushFunc != nil {
			senderName := s.getSenderName(from)
			// Extract message text for push body
			pushBody := "发来一条消息"
			if p, ok := env.Payload.(map[string]interface{}); ok {
				if text, ok := p["text"].(string); ok && text != "" {
					if len(text) > 50 {
						pushBody = text[:50] + "..."
					} else {
						pushBody = text
					}
				} else if ct, ok := p["content_type"].(string); ok && ct == "image" {
					pushBody = "[图片]"
				}
			}
			go s.pushFunc(env.To, senderName, pushBody, map[string]string{
				"type":    "message",
				"from_id": from,
			})
		}
	}
}


// RouteGroupMessage broadcasts a message to all group members.
func (s *Service) RouteGroupMessage(from string, env *protocol.Envelope) {
	if s.groupHandler == nil {
		s.logger.Error("group handler not set")
		return
	}

	groupID := env.To
	now := time.Now().UTC().Format(time.RFC3339)
	if env.Timestamp == "" {
		env.Timestamp = now
	}
	if env.ID == "" {
		env.ID = "msg_" + auth.NewULID()
	}

	// Verify sender is a member
	members := s.groupHandler.GetGroupMembers(groupID)
	isMember := false
	for _, m := range members {
		if m == from {
			isMember = true
			break
		}
	}
	if !isMember {
		s.hub.Send(from, &protocol.Envelope{
			Type: protocol.TypeError,
			Payload: protocol.ErrorPayload{
				Code:    "not_member",
				Message: "you are not a member of this group",
				RefID:   env.ID,
			},
		})
		return
	}

	// Enforce mute-all: only owner/admin can speak when enabled
	if s.groupHandler.IsMutedAll(groupID) {
		role := s.groupHandler.GetMemberRole(groupID, from)
		if role != "owner" && role != "admin" {
			s.hub.Send(from, &protocol.Envelope{
				Type: protocol.TypeError,
				Payload: protocol.ErrorPayload{
					Code:    "group_muted",
					Message: "this group is muted for members",
					RefID:   env.ID,
				},
			})
			return
		}
	}

	// Store message
	s.groupHandler.StoreGroupMessage(env.ID, groupID, from, env.Payload)

	// Get sender name
	senderName := s.getSenderName(from)

	// Enrich payload for clients/plugin
	payload := map[string]interface{}{}
	switch p := env.Payload.(type) {
	case map[string]interface{}:
		for k, v := range p {
			payload[k] = v
		}
	default:
		payload["raw"] = p
	}
	if _, ok := payload["segments"]; !ok {
		if p, ok := env.Payload.(map[string]interface{}); ok {
			if v, ok := p["segments"]; ok { payload["segments"] = v }
			if v, ok := p["mentions"]; ok { payload["mentions"] = v }
		}
	}
	payload["sender_name"] = senderName
	payload["group_id"] = groupID

	// Best-effort group name lookup
	var groupName string
	_ = s.db.QueryRow(`SELECT name FROM groups WHERE id=$1`, groupID).Scan(&groupName)
	if groupName != "" {
		payload["group_name"] = groupName
	}

	// Broadcast to all members except sender
	delivered := &protocol.Envelope{
		Type:      protocol.TypeGroupMessageReceived,
		ID:        env.ID,
		From:      from,
		To:        groupID,
		Timestamp: env.Timestamp,
		Payload:   payload,
	}

	// Extract mentions from payload for targeted notifications
	mentionedIDs := map[string]bool{}
	if mentions, ok := payload["mentions"].([]interface{}); ok {
		for _, m := range mentions {
			if mm, ok := m.(map[string]interface{}); ok {
				if id, ok := mm["citizen_id"].(string); ok {
					mentionedIDs[id] = true
				}
			}
		}
	}

	onlineCount := 0
	for _, mid := range members {
		if mid == from {
			continue
		}
		if s.hub.Send(mid, delivered) {
			onlineCount++
		} else if s.pushFunc != nil {
			// Send push to offline members — mention gets special text
			pushBody := "发来一条消息"
			if mentionedIDs[mid] {
				pushBody = "在群里@了你"
			}
			if p, ok := env.Payload.(map[string]interface{}); ok {
				if text, ok := p["text"].(string); ok && text != "" {
					if len(text) > 50 {
						pushBody = text[:50] + "..."
					} else {
						pushBody = text
					}
				}
			}
			go s.pushFunc(mid, senderName, pushBody, map[string]string{
				"type":     "group_message",
				"group_id": groupID,
				"from_id":  from,
			})
		}
	}

	// ACK to sender
	s.hub.Send(from, &protocol.Envelope{
		Type: protocol.TypeMessageStatus,
		Payload: protocol.AckPayload{
			MessageID: env.ID,
			Status:    "delivered",
		},
	})

	s.logger.Info("group message delivered", "group", groupID, "from", from, "id", env.ID, "online", onlineCount, "total", len(members)-1)
}

func (s *Service) storeOffline(from string, env *protocol.Envelope) {
	payload, _ := json.Marshal(map[string]interface{}{
		"id":        env.ID,
		"from":      from,
		"to":        env.To,
		"timestamp": env.Timestamp,
		"payload":   env.Payload,
	})
	_, err := s.db.Exec(
		`INSERT INTO message_relay (id, from_id, to_id, chat_type, payload) VALUES ($1, $2, $3, 'direct', $4)`,
		auth.NewULID(), from, env.To, payload,
	)
	if err != nil {
		s.logger.Error("store offline message failed", "error", err)
	}
}

// DeliverPending pushes all pending messages to a citizen who just came online.
func (s *Service) DeliverPending(citizenID string) int {
	rows, err := s.db.Query(
		`SELECT id, payload FROM message_relay WHERE to_id=$1 AND status='pending' ORDER BY created_at ASC LIMIT 100`,
		citizenID,
	)
	if err != nil {
		s.logger.Error("query pending messages", "error", err)
		return 0
	}
	defer rows.Close()

	count := 0
	var ids []string
	for rows.Next() {
		var id string
		var payload []byte
		if err := rows.Scan(&id, &payload); err != nil {
			continue
		}

		var raw map[string]interface{}
		if err := json.Unmarshal(payload, &raw); err != nil {
			continue
		}

		env := &protocol.Envelope{
			Type:      protocol.TypeMessageReceived,
			ID:        strVal(raw["id"]),
			From:      strVal(raw["from"]),
			To:        strVal(raw["to"]),
			Timestamp: strVal(raw["timestamp"]),
			Payload:   raw["payload"],
		}
		if s.hub.Send(citizenID, env) {
			ids = append(ids, id)
			count++
		}
	}

	// Mark delivered
	for _, id := range ids {
		s.db.Exec(`UPDATE message_relay SET status='delivered', delivered_at=NOW() WHERE id=$1`, id)
	}

	if count > 0 {
		s.logger.Info("delivered pending", "citizen_id", citizenID, "count", count)
	}
	return count
}

func (s *Service) HandleAck(from string, env *protocol.Envelope) {
	// Update relay status
	if env.ID != "" {
		s.db.Exec(`UPDATE message_relay SET status='read' WHERE id=$1 AND to_id=$2`, env.ID, from)
	}

	// Forward read receipt to the original sender (env.To = original sender)
	target := env.To
	if target == "" {
		target = env.From
	}
	if target != "" && target != from {
		s.hub.Send(target, &protocol.Envelope{
			Type: protocol.TypeMessageStatus,
			From: from,
			Payload: protocol.AckPayload{
				MessageID: env.ID,
				Status:    "read",
			},
		})
		s.logger.Info("read receipt forwarded", "from", from, "to", target, "msgId", env.ID)
	}
}

func (s *Service) HandleTyping(from string, env *protocol.Envelope) {
	if env.To != "" {
		s.hub.Send(env.To, &protocol.Envelope{
			Type: env.Type,
			From: from,
		})
	}
}

func (s *Service) HandleReaction(from string, env *protocol.Envelope) {
	if env.To == "" {
		return
	}
	if s.groupHandler != nil && strings.HasPrefix(env.To, "group_") {
		members := s.groupHandler.GetGroupMembers(env.To)
		broadcast := &protocol.Envelope{
			Type:    env.Type,
			From:    from,
			To:      env.To,
			Payload: env.Payload,
		}
		for _, mid := range members {
			if mid == from {
				continue
			}
			s.hub.Send(mid, broadcast)
		}
		return
	}
	s.hub.Send(env.To, &protocol.Envelope{
		Type:    env.Type,
		From:    from,
		Payload: env.Payload,
	})
}


// HandleGroupTyping broadcasts typing indicators to group members.
func (s *Service) HandleGroupTyping(from string, env *protocol.Envelope) {
	if s.groupHandler == nil || !strings.HasPrefix(env.To, "group_") {
		return
	}
	members := s.groupHandler.GetGroupMembers(env.To)
	broadcast := &protocol.Envelope{
		Type: env.Type,
		From: from,
		To:   env.To,
	}
	for _, mid := range members {
		if mid == from {
			continue
		}
		s.hub.Send(mid, broadcast)
	}
}
func strVal(v interface{}) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

// BroadcastPresence notifies all friends of a citizen about their online/offline status.
func (s *Service) BroadcastPresence(citizenID string, state string) {
	rows, err := s.db.Query(`
		SELECT CASE WHEN citizen_a_id = $1 THEN citizen_b_id ELSE citizen_a_id END AS friend_id
		FROM relationships
		WHERE (citizen_a_id = $1 OR citizen_b_id = $1) AND status = 'active'`, citizenID)
	if err != nil {
		s.logger.Error("query friends for presence", "error", err)
		return
	}
	defer rows.Close()

	env := &protocol.Envelope{
		Type: protocol.TypePresenceChanged,
		From: citizenID,
		Payload: map[string]string{
			"citizen_id": citizenID,
			"state":      state,
		},
	}

	sent := 0
	for rows.Next() {
		var friendID string
		if err := rows.Scan(&friendID); err != nil {
			continue
		}
		if s.hub.Send(friendID, env) {
			sent++
		}
	}

	if sent > 0 {
		s.logger.Info("presence broadcast", "citizen", citizenID, "state", state, "notified", sent)
	}
}



// GetDMHistory returns paginated DM history between the authenticated citizen and a peer.
// GET /api/v1/messages/history?peer={citizenID}&before={msgID}&limit=50
func (s *Service) GetDMHistory(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	if citizenID == "" {
		http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"not authenticated"}}`, 401)
		return
	}

	peerID := r.URL.Query().Get("peer")
	if peerID == "" {
		http.Error(w, `{"error":{"code":"VALIDATION_ERROR","message":"peer parameter required"}}`, 400)
		return
	}

	before := r.URL.Query().Get("before")
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	type DMMessage struct {
		ID          string      `json:"id"`
		FromID      string      `json:"sender_id"`
		FromName    string      `json:"sender_name"`
		ToID        string      `json:"to_id"`
		Payload     interface{} `json:"payload"`
		CreatedAt   string      `json:"created_at"`
	}

	var rows *sql.Rows
	var err error

	if before != "" {
		rows, err = s.db.Query(`
			SELECT mr.id, mr.from_id, COALESCE(c.display_name,''), mr.to_id, mr.payload, mr.created_at
			FROM message_relay mr
			JOIN citizens c ON c.id = mr.from_id
			WHERE ((mr.from_id = $1 AND mr.to_id = $2) OR (mr.from_id = $2 AND mr.to_id = $1))
				AND mr.created_at < (SELECT created_at FROM message_relay WHERE id = $3)
			ORDER BY mr.created_at DESC
			LIMIT $4
		`, citizenID, peerID, before, limit)
	} else {
		rows, err = s.db.Query(`
			SELECT mr.id, mr.from_id, COALESCE(c.display_name,''), mr.to_id, mr.payload, mr.created_at
			FROM message_relay mr
			JOIN citizens c ON c.id = mr.from_id
			WHERE ((mr.from_id = $1 AND mr.to_id = $2) OR (mr.from_id = $2 AND mr.to_id = $1))
			ORDER BY mr.created_at DESC
			LIMIT $3
		`, citizenID, peerID, limit)
	}
	if err != nil {
		s.logger.Error("dm history query", "error", err)
		http.Error(w, `{"error":{"code":"INTERNAL","message":"query failed"}}`, 500)
		return
	}
	defer rows.Close()

	var messages []DMMessage
	for rows.Next() {
		var m DMMessage
		var payloadBytes []byte
		var ts time.Time
		if err := rows.Scan(&m.ID, &m.FromID, &m.FromName, &m.ToID, &payloadBytes, &ts); err != nil {
			continue
		}
		// The payload in message_relay is a JSON envelope; extract the inner payload
		var envelope map[string]interface{}
		if json.Unmarshal(payloadBytes, &envelope) == nil {
			if inner, ok := envelope["payload"]; ok {
				m.Payload = inner
			} else {
				m.Payload = envelope
			}
		}
		m.CreatedAt = ts.Format(time.RFC3339)
		messages = append(messages, m)
	}
	if messages == nil {
		messages = []DMMessage{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(messages)
}

// SearchMessages searches DM and group messages for a citizen.
// GET /api/v1/messages/search?q=keyword&limit=20&before=<timestamp>
func (s *Service) SearchMessages(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	if citizenID == "" {
		http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"not authenticated"}}`, 401)
		return
	}

	q := r.URL.Query().Get("q")
	if q == "" || len(q) < 2 {
		http.Error(w, `{"error":{"code":"VALIDATION_ERROR","message":"query must be at least 2 characters"}}`, 400)
		return
	}

	limitStr := r.URL.Query().Get("limit")
	limit := 30
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	pattern := "%" + q + "%"

	type SearchResult struct {
		ID          string `json:"id"`
		ChatID      string `json:"chat_id"`
		ChatType    string `json:"chat_type"` // "direct" or "group"
		FromID      string `json:"from_id"`
		FromName    string `json:"from_name"`
		Text        string `json:"text"`
		ContentType string `json:"content_type"`
		Timestamp   string `json:"timestamp"`
		PeerName    string `json:"peer_name,omitempty"`
	}

	var results []SearchResult

	// Search DM messages (message_relay)
	dmRows, err := s.db.Query(`
		SELECT mr.id, 
			CASE WHEN mr.from_id = $1 THEN mr.to_id ELSE mr.from_id END AS chat_id,
			'direct' AS chat_type,
			mr.from_id,
			COALESCE(c.display_name, '') AS from_name,
			COALESCE(mr.payload->'payload'->>'text', mr.payload->>'text', '') AS text,
			COALESCE(mr.payload->'payload'->>'content_type', mr.payload->>'content_type', 'text') AS content_type,
			mr.created_at,
			COALESCE(peer.display_name, '') AS peer_name
		FROM message_relay mr
		JOIN citizens c ON c.id = mr.from_id
		JOIN citizens peer ON peer.id = CASE WHEN mr.from_id = $1 THEN mr.to_id ELSE mr.from_id END
		WHERE (mr.from_id = $1 OR mr.to_id = $1)
			AND (mr.payload->>'text' ILIKE $2 OR mr.payload->'payload'->>'text' ILIKE $2)
		ORDER BY mr.created_at DESC
		LIMIT $3`,
		citizenID, pattern, limit/2)

	if err != nil {
		s.logger.Error("search dm messages", "error", err)
	} else {
		defer dmRows.Close()
		for dmRows.Next() {
			var r SearchResult
			var ts time.Time
			dmRows.Scan(&r.ID, &r.ChatID, &r.ChatType, &r.FromID, &r.FromName, &r.Text, &r.ContentType, &ts, &r.PeerName)
			r.Timestamp = ts.Format(time.RFC3339)
			results = append(results, r)
		}
	}

	// Search group messages
	grpRows, err := s.db.Query(`
		SELECT gm.id, gm.group_id AS chat_id,
			'group' AS chat_type,
			gm.sender_id AS from_id,
			COALESCE(c.display_name, '') AS from_name,
			COALESCE(gm.payload->>'text', '') AS text,
			COALESCE(gm.payload->>'content_type', 'text') AS content_type,
			gm.created_at,
			COALESCE(g.name, '') AS peer_name
		FROM group_messages gm
		JOIN group_members memb ON memb.group_id = gm.group_id AND memb.citizen_id = $1
		JOIN citizens c ON c.id = gm.sender_id
		JOIN groups g ON g.id = gm.group_id
		WHERE gm.payload->>'text' ILIKE $2
		ORDER BY gm.created_at DESC
		LIMIT $3`,
		citizenID, pattern, limit/2)

	if err != nil {
		s.logger.Error("search group messages", "error", err)
	} else {
		defer grpRows.Close()
		for grpRows.Next() {
			var r SearchResult
			var ts time.Time
			grpRows.Scan(&r.ID, &r.ChatID, &r.ChatType, &r.FromID, &r.FromName, &r.Text, &r.ContentType, &ts, &r.PeerName)
			r.Timestamp = ts.Format(time.RFC3339)
			results = append(results, r)
		}
	}

	// Sort combined results by timestamp desc
	sort.Slice(results, func(i, j int) bool {
		return results[i].Timestamp > results[j].Timestamp
	})

	if len(results) > limit {
		results = results[:limit]
	}

	if results == nil {
		results = []SearchResult{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"results": results,
		"total":   len(results),
		"query":   q,
	})
}
