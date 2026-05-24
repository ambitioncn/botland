package relay

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"
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

func (s *Service) resolveDirectTargetID(target string) string {
	normalized := strings.TrimSpace(target)
	if normalized == "" {
		return normalized
	}

	var citizenID string
	err := s.db.QueryRow(
		`SELECT id
		 FROM citizens
		 WHERE status='active' AND (id=$1 OR LOWER(handle)=LOWER($1))
		 LIMIT 1`,
		normalized,
	).Scan(&citizenID)
	if err != nil || citizenID == "" {
		if err != nil && err != sql.ErrNoRows {
			s.logger.Warn("resolve direct target failed", "target", normalized, "error", err)
		}
		return normalized
	}
	if citizenID != normalized {
		s.logger.Info("resolved direct target", "target", normalized, "citizen_id", citizenID)
	}
	return citizenID
}

// RouteMessage handles an incoming message: deliver in real-time or store offline.
func (s *Service) RouteMessage(from string, env *protocol.Envelope) {
	// Route to group if target is a group ID
	if strings.HasPrefix(env.To, "group_") {
		s.RouteGroupMessage(from, env)
		return
	}
	env.To = s.resolveDirectTargetID(env.To)
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
	s.LogEvent(env.To, protocol.TypeMessageReceived, env.ID, s.buildMessageEvent(protocol.TypeMessageReceived, env.ID, "direct", from, from, env.To, env.Timestamp, env.Payload))

	if s.hub.Send(env.To, delivered) {
		s.persistDirectMessage(from, env, "delivered")
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
		s.persistDirectMessage(from, env, "pending")
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
			if v, ok := p["segments"]; ok {
				payload["segments"] = v
			}
			if v, ok := p["mentions"]; ok {
				payload["mentions"] = v
			}
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
		s.LogEvent(mid, protocol.TypeGroupMessageReceived, env.ID, s.buildMessageEvent(protocol.TypeGroupMessageReceived, env.ID, "group", groupID, from, groupID, env.Timestamp, payload))
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

func (s *Service) persistDirectMessage(from string, env *protocol.Envelope, status string) {
	payload, _ := json.Marshal(map[string]interface{}{
		"id":        env.ID,
		"from":      from,
		"to":        env.To,
		"timestamp": env.Timestamp,
		"payload":   env.Payload,
	})
	_, err := s.db.Exec(
		`INSERT INTO message_relay (id, from_id, to_id, chat_type, payload, status, delivered_at)
		 VALUES ($1, $2, $3, 'direct', $4, $5,
		         CASE WHEN $5 IN ('delivered', 'read') THEN NOW() ELSE NULL END)
		 ON CONFLICT (id) DO UPDATE SET
		   payload = EXCLUDED.payload,
		   status = CASE
		     WHEN message_relay.status = 'read' THEN 'read'
		     WHEN message_relay.status = 'delivered' AND EXCLUDED.status = 'pending' THEN 'delivered'
		     ELSE EXCLUDED.status
		   END,
		   delivered_at = CASE
		     WHEN EXCLUDED.status IN ('delivered', 'read') THEN COALESCE(message_relay.delivered_at, EXCLUDED.delivered_at)
		     ELSE message_relay.delivered_at
		   END`,
		env.ID, from, env.To, payload, status,
	)
	if err != nil {
		s.logger.Error("persist direct message failed", "error", err, "message_id", env.ID, "status", status)
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
		ID        string      `json:"id"`
		FromID    string      `json:"sender_id"`
		FromName  string      `json:"sender_name"`
		ToID      string      `json:"to_id"`
		Payload   interface{} `json:"payload"`
		CreatedAt string      `json:"created_at"`
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

// LogEvent records a durable event for a citizen. eventKey should be stable for dedupe (message id, request id, etc.).
func (s *Service) LogEvent(citizenID, eventType, eventKey string, payload interface{}) string {
	if citizenID == "" || eventType == "" || eventKey == "" {
		return ""
	}
	payloadBytes, _ := json.Marshal(payload)
	eventID := "evt_" + auth.NewULID()
	res, err := s.db.Exec(`
		INSERT INTO event_log (id, citizen_id, event_key, event_type, payload)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (citizen_id, event_key) DO NOTHING
	`, eventID, citizenID, eventKey, eventType, payloadBytes)
	if err != nil {
		s.logger.Warn("log durable event failed", "citizen_id", citizenID, "event_type", eventType, "event_key", eventKey, "error", err)
		return ""
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		return ""
	}
	s.DispatchWebhooks(citizenID, eventID, eventType, payload)
	return eventID
}

func (s *Service) buildMessageEvent(eventType, eventID, chatType, chatID, from, to, timestamp string, payload interface{}) map[string]interface{} {
	contentType := eventType
	text := ""
	if p, ok := payload.(map[string]interface{}); ok {
		if v, ok := p["content_type"].(string); ok && v != "" {
			contentType = v
		}
		if v, ok := p["text"].(string); ok {
			text = v
		}
	}
	msg := map[string]interface{}{
		"id":           eventID,
		"from":         map[string]interface{}{"id": from},
		"content_type": contentType,
		"payload":      payload,
		"timestamp":    timestamp,
	}
	if text != "" {
		msg["text"] = text
	}
	return map[string]interface{}{
		"event_id":   eventID,
		"event_type": eventType,
		"chat":       map[string]interface{}{"type": chatType, "id": chatID},
		"message":    msg,
		"raw": map[string]interface{}{
			"type":      eventType,
			"id":        eventID,
			"from":      from,
			"to":        to,
			"timestamp": timestamp,
			"payload":   payload,
		},
	}
}

// ListEvents returns durable events for the authenticated citizen.
func (s *Service) ListEvents(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			switch {
			case n < 1:
				limit = 1
			case n > 200:
				limit = 200
			default:
				limit = n
			}
		}
	}
	query := `SELECT id, event_key, event_type, payload, created_at, delivered_at, acked_at FROM event_log WHERE citizen_id=$1`
	args := []interface{}{citizenID}
	if cursor != "" {
		query += ` AND id > $2`
		args = append(args, cursor)
	}
	query += ` ORDER BY id ASC LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "query failed"}})
		return
	}
	defer rows.Close()
	items := []map[string]interface{}{}
	ids := []string{}
	for rows.Next() {
		var id, eventKey, eventType string
		var payloadBytes []byte
		var createdAt time.Time
		var deliveredAt, ackedAt sql.NullTime
		if err := rows.Scan(&id, &eventKey, &eventType, &payloadBytes, &createdAt, &deliveredAt, &ackedAt); err != nil {
			continue
		}
		var payload interface{}
		_ = json.Unmarshal(payloadBytes, &payload)
		item := map[string]interface{}{"id": id, "event_key": eventKey, "event_type": eventType, "payload": payload, "created_at": createdAt.Format(time.RFC3339)}
		if deliveredAt.Valid {
			item["delivered_at"] = deliveredAt.Time.Format(time.RFC3339)
		}
		if ackedAt.Valid {
			item["acked_at"] = ackedAt.Time.Format(time.RFC3339)
		}
		items = append(items, item)
		ids = append(ids, id)
	}
	for _, id := range ids {
		_, _ = s.db.Exec(`UPDATE event_log SET delivered_at=COALESCE(delivered_at,NOW()) WHERE id=$1 AND citizen_id=$2`, id, citizenID)
	}
	nextCursor := ""
	if len(ids) > 0 {
		nextCursor = ids[len(ids)-1]
	}
	writeRelayJSON(w, http.StatusOK, map[string]interface{}{"events": items, "next_cursor": nextCursor})
}

type retentionRequest struct {
	Days  *int `json:"days"`
	Limit *int `json:"limit"`
}

func parseRetentionOptions(r *http.Request, defaultDays, maxLimit int) (int, int, error) {
	days := defaultDays
	limit := maxLimit
	var req retentionRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil {
			return 0, 0, fmt.Errorf("days must be a positive integer")
		}
		days = v
	} else if req.Days != nil {
		days = *req.Days
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil {
			return 0, 0, fmt.Errorf("limit must be a positive integer")
		}
		limit = v
	} else if req.Limit != nil {
		limit = *req.Limit
	}
	if days < 1 {
		return 0, 0, fmt.Errorf("days must be at least 1")
	}
	if days > 3650 {
		days = 3650
	}
	if limit < 1 {
		return 0, 0, fmt.Errorf("limit must be at least 1")
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	return days, limit, nil
}

func (s *Service) CleanupEventsRetention(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	days, limit, err := parseRetentionOptions(r, 30, 50000)
	if err != nil {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": err.Error()}})
		return
	}
	res, err := s.db.Exec(`
		WITH doomed AS (
			SELECT id FROM event_log
			WHERE citizen_id=$1 AND acked_at IS NOT NULL AND acked_at < NOW() - ($2 || ' days')::interval
			ORDER BY acked_at ASC
			LIMIT $3
		)
		DELETE FROM event_log WHERE id IN (SELECT id FROM doomed)
	`, citizenID, days, limit)
	if err != nil {
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "event cleanup failed"}})
		return
	}
	deleted, _ := res.RowsAffected()
	writeRelayJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "deleted": deleted, "days": days, "limit": limit, "scope": "acked_events"})
}

func (s *Service) CleanupWebhookDeliveriesRetention(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	days, limit, err := parseRetentionOptions(r, 30, 50000)
	if err != nil {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": err.Error()}})
		return
	}
	res, err := s.db.Exec(`
		WITH doomed AS (
			SELECT wd.id FROM webhook_deliveries wd
			JOIN webhooks wh ON wh.id = wd.webhook_id
			WHERE wh.citizen_id=$1 AND wd.status IN ('success','failed') AND wd.created_at < NOW() - ($2 || ' days')::interval
			ORDER BY wd.created_at ASC
			LIMIT $3
		)
		DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM doomed)
	`, citizenID, days, limit)
	if err != nil {
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "webhook delivery cleanup failed"}})
		return
	}
	deleted, _ := res.RowsAffected()
	writeRelayJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "deleted": deleted, "days": days, "limit": limit, "scope": "terminal_webhook_deliveries"})
}

func (s *Service) AckEvent(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	eventID := chi.URLParam(r, "eventID")
	res, err := s.db.Exec(`UPDATE event_log SET acked_at=COALESCE(acked_at,NOW()) WHERE id=$1 AND citizen_id=$2`, eventID, citizenID)
	if err != nil {
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "ack failed"}})
		return
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		writeRelayJSON(w, http.StatusNotFound, map[string]interface{}{"error": map[string]string{"code": "NOT_FOUND", "message": "event not found"}})
		return
	}
	writeRelayJSON(w, http.StatusOK, map[string]string{"status": "acked"})
}

type replyRequest struct {
	Text    string                 `json:"text"`
	Payload map[string]interface{} `json:"payload"`
}

func (s *Service) ReplyToMessage(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	messageID := chi.URLParam(r, "messageID")
	var req replyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": "invalid body"}})
		return
	}
	if strings.TrimSpace(req.Text) == "" && len(req.Payload) == 0 {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": "text or payload required"}})
		return
	}
	var payloadBytes []byte
	err := s.db.QueryRow(`SELECT payload FROM event_log WHERE citizen_id=$1 AND event_key=$2 AND event_type IN ($3,$4) ORDER BY created_at DESC LIMIT 1`, citizenID, messageID, protocol.TypeMessageReceived, protocol.TypeGroupMessageReceived).Scan(&payloadBytes)
	if err != nil {
		writeRelayJSON(w, http.StatusNotFound, map[string]interface{}{"error": map[string]string{"code": "NOT_FOUND", "message": "message event not found"}})
		return
	}
	var event map[string]interface{}
	_ = json.Unmarshal(payloadBytes, &event)
	chat, _ := event["chat"].(map[string]interface{})
	message, _ := event["message"].(map[string]interface{})
	from, _ := message["from"].(map[string]interface{})
	chatType, _ := chat["type"].(string)
	chatID, _ := chat["id"].(string)
	fromID, _ := from["id"].(string)
	target := fromID
	if chatType == "group" {
		target = chatID
	}
	if target == "" {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "INVALID_EVENT", "message": "cannot infer reply target"}})
		return
	}
	replyPayload := req.Payload
	if replyPayload == nil {
		replyPayload = map[string]interface{}{}
	}
	if _, ok := replyPayload["content_type"]; !ok {
		replyPayload["content_type"] = protocol.ContentText
	}
	if req.Text != "" {
		replyPayload["text"] = req.Text
	}
	replyPayload["reply_to"] = messageID
	env := &protocol.Envelope{Type: protocol.TypeMessageSend, To: target, Payload: replyPayload}
	s.RouteMessage(citizenID, env)
	writeRelayJSON(w, http.StatusOK, map[string]interface{}{"status": "sent", "message_id": env.ID, "to": target})
}

func writeRelayJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

type webhookCreateRequest struct {
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	RetryMax  *int     `json:"retry_max"`
	TimeoutMs *int     `json:"timeout_ms"`
}

type webhookPatchRequest struct {
	URL       *string  `json:"url"`
	Events    []string `json:"events"`
	Enabled   *bool    `json:"enabled"`
	RetryMax  *int     `json:"retry_max"`
	TimeoutMs *int     `json:"timeout_ms"`
}

func normalizeWebhookEvents(events []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, event := range events {
		e := strings.TrimSpace(event)
		if e == "" || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	if len(out) == 0 {
		out = []string{"*"}
	}
	return out
}

func validateWebhookURL(raw string) bool {
	return webhookURLValidationError(raw) == ""
}

func webhookURLValidationError(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "valid http/https url required"
	}
	if u.User != nil {
		return "webhook url must not contain user info"
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return "webhook url host required"
	}
	if isForbiddenWebhookHost(host) {
		return "webhook url must not target localhost, private networks, or metadata services"
	}
	return ""
}

func isForbiddenWebhookHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || host == "metadata.google.internal" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return isForbiddenWebhookIP(ip)
	}
	return false
}

func isForbiddenWebhookIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	if ip.Equal(net.ParseIP("169.254.169.254")) {
		return true
	}
	return false
}

func generateWebhookSecret() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return auth.NewULID() + auth.NewULID()
	}
	return hex.EncodeToString(buf)
}

func (s *Service) CreateWebhook(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	var req webhookCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": "invalid body"}})
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if msg := webhookURLValidationError(req.URL); msg != "" {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": msg}})
		return
	}
	events := normalizeWebhookEvents(req.Events)
	retryMax := 3
	if req.RetryMax != nil {
		retryMax = *req.RetryMax
	}
	if retryMax < 0 {
		retryMax = 0
	}
	if retryMax > 10 {
		retryMax = 10
	}
	timeoutMs := 5000
	if req.TimeoutMs != nil {
		timeoutMs = *req.TimeoutMs
	}
	if timeoutMs < 1000 {
		timeoutMs = 1000
	}
	if timeoutMs > 30000 {
		timeoutMs = 30000
	}
	id := "wh_" + auth.NewULID()
	secret := generateWebhookSecret()
	_, err := s.db.Exec(`INSERT INTO webhooks (id, citizen_id, url, secret, events, retry_max, timeout_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, citizenID, req.URL, secret, pq.Array(events), retryMax, timeoutMs)
	if err != nil {
		s.logger.Warn("create webhook failed", "error", err)
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "create failed"}})
		return
	}
	writeRelayJSON(w, http.StatusCreated, map[string]interface{}{"id": id, "url": req.URL, "events": events, "enabled": true, "retry_max": retryMax, "timeout_ms": timeoutMs, "secret": secret})
}

func (s *Service) ListWebhooks(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	rows, err := s.db.Query(`SELECT id, url, events, enabled, retry_max, timeout_ms, created_at, updated_at, last_success_at, last_failure_at FROM webhooks WHERE citizen_id=$1 ORDER BY created_at DESC`, citizenID)
	if err != nil {
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "query failed"}})
		return
	}
	defer rows.Close()
	items := []map[string]interface{}{}
	for rows.Next() {
		var id, whURL string
		var events pq.StringArray
		var enabled bool
		var retryMax, timeoutMs int
		var createdAt, updatedAt time.Time
		var lastSuccessAt, lastFailureAt sql.NullTime
		if err := rows.Scan(&id, &whURL, &events, &enabled, &retryMax, &timeoutMs, &createdAt, &updatedAt, &lastSuccessAt, &lastFailureAt); err != nil {
			continue
		}
		item := map[string]interface{}{"id": id, "url": whURL, "events": []string(events), "enabled": enabled, "retry_max": retryMax, "timeout_ms": timeoutMs, "created_at": createdAt.Format(time.RFC3339), "updated_at": updatedAt.Format(time.RFC3339)}
		if lastSuccessAt.Valid {
			item["last_success_at"] = lastSuccessAt.Time.Format(time.RFC3339)
		}
		if lastFailureAt.Valid {
			item["last_failure_at"] = lastFailureAt.Time.Format(time.RFC3339)
		}
		items = append(items, item)
	}
	writeRelayJSON(w, http.StatusOK, map[string]interface{}{"webhooks": items, "total": len(items)})
}

func (s *Service) PatchWebhook(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	id := chi.URLParam(r, "webhookID")
	var req webhookPatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": "invalid body"}})
		return
	}
	var exists bool
	_ = s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM webhooks WHERE id=$1 AND citizen_id=$2)`, id, citizenID).Scan(&exists)
	if !exists {
		writeRelayJSON(w, http.StatusNotFound, map[string]interface{}{"error": map[string]string{"code": "NOT_FOUND", "message": "webhook not found"}})
		return
	}
	if req.URL != nil {
		u := strings.TrimSpace(*req.URL)
		if msg := webhookURLValidationError(u); msg != "" {
			writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": msg}})
			return
		}
		_, _ = s.db.Exec(`UPDATE webhooks SET url=$1, updated_at=NOW() WHERE id=$2 AND citizen_id=$3`, u, id, citizenID)
	}
	if req.Events != nil {
		events := normalizeWebhookEvents(req.Events)
		_, _ = s.db.Exec(`UPDATE webhooks SET events=$1, updated_at=NOW() WHERE id=$2 AND citizen_id=$3`, pq.Array(events), id, citizenID)
	}
	if req.Enabled != nil {
		_, _ = s.db.Exec(`UPDATE webhooks SET enabled=$1, updated_at=NOW() WHERE id=$2 AND citizen_id=$3`, *req.Enabled, id, citizenID)
	}
	if req.RetryMax != nil {
		v := *req.RetryMax
		if v < 0 {
			v = 0
		}
		if v > 10 {
			v = 10
		}
		_, _ = s.db.Exec(`UPDATE webhooks SET retry_max=$1, updated_at=NOW() WHERE id=$2 AND citizen_id=$3`, v, id, citizenID)
	}
	if req.TimeoutMs != nil {
		v := *req.TimeoutMs
		if v < 1000 {
			v = 1000
		}
		if v > 30000 {
			v = 30000
		}
		_, _ = s.db.Exec(`UPDATE webhooks SET timeout_ms=$1, updated_at=NOW() WHERE id=$2 AND citizen_id=$3`, v, id, citizenID)
	}
	writeRelayJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Service) DeleteWebhook(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	id := chi.URLParam(r, "webhookID")
	res, err := s.db.Exec(`DELETE FROM webhooks WHERE id=$1 AND citizen_id=$2`, id, citizenID)
	if err != nil {
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "delete failed"}})
		return
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		writeRelayJSON(w, http.StatusNotFound, map[string]interface{}{"error": map[string]string{"code": "NOT_FOUND", "message": "webhook not found"}})
		return
	}
	writeRelayJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Service) RotateWebhookSecret(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	id := chi.URLParam(r, "webhookID")
	secret := generateWebhookSecret()
	res, err := s.db.Exec(`UPDATE webhooks SET secret=$1, updated_at=NOW() WHERE id=$2 AND citizen_id=$3`, secret, id, citizenID)
	if err != nil {
		writeRelayJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": map[string]string{"code": "INTERNAL", "message": "rotate failed"}})
		return
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		writeRelayJSON(w, http.StatusNotFound, map[string]interface{}{"error": map[string]string{"code": "NOT_FOUND", "message": "webhook not found"}})
		return
	}
	writeRelayJSON(w, http.StatusOK, map[string]interface{}{"id": id, "secret": secret, "rotated": true})
}

func (s *Service) TestWebhook(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	id := chi.URLParam(r, "webhookID")
	payload := map[string]interface{}{"event_id": "test_" + auth.NewULID(), "event_type": "webhook.test", "created_at": time.Now().UTC().Format(time.RFC3339), "citizen_id": citizenID, "test": true}
	var wh webhookTarget
	if err := s.db.QueryRow(`SELECT id, url, secret, retry_max, timeout_ms FROM webhooks WHERE id=$1 AND citizen_id=$2`, id, citizenID).Scan(&wh.ID, &wh.URL, &wh.Secret, &wh.RetryMax, &wh.TimeoutMs); err != nil {
		writeRelayJSON(w, http.StatusNotFound, map[string]interface{}{"error": map[string]string{"code": "NOT_FOUND", "message": "webhook not found"}})
		return
	}
	result := s.deliverWebhook(wh, payload["event_id"].(string), "webhook.test", payload)
	status := "failed"
	if result.Success {
		status = "success"
	}
	writeRelayJSON(w, http.StatusOK, map[string]interface{}{"status": status, "attempts": result.Attempts, "response_status": result.ResponseStatus, "error": result.Error})
}

type webhookTarget struct {
	ID, URL, Secret     string
	RetryMax, TimeoutMs int
}
type webhookDeliveryResult struct {
	Success        bool
	Attempts       int
	ResponseStatus int
	Error          string
}

func (s *Service) DispatchWebhooks(citizenID, eventID, eventType string, payload interface{}) {
	rows, err := s.db.Query(`SELECT id, url, secret, retry_max, timeout_ms FROM webhooks WHERE citizen_id=$1 AND enabled=true AND ($2 = ANY(events) OR '*' = ANY(events))`, citizenID, eventType)
	if err != nil {
		s.logger.Warn("query webhooks failed", "citizen_id", citizenID, "error", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var wh webhookTarget
		if err := rows.Scan(&wh.ID, &wh.URL, &wh.Secret, &wh.RetryMax, &wh.TimeoutMs); err != nil {
			continue
		}
		go s.deliverWebhook(wh, eventID, eventType, payload)
	}
}

func webhookHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(address)
				if err != nil {
					return nil, err
				}
				ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
				if err != nil {
					return nil, err
				}
				for _, ip := range ips {
					if isForbiddenWebhookIP(ip) {
						continue
					}
					var d net.Dialer
					return d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				}
				return nil, fmt.Errorf("webhook target resolved only to forbidden addresses")
			},
		},
	}
}

func (s *Service) deliverWebhook(wh webhookTarget, eventID, eventType string, payload interface{}) webhookDeliveryResult {
	bodyBytes, _ := json.Marshal(payload)
	deliveryID := "whd_" + auth.NewULID()
	_, _ = s.db.Exec(`INSERT INTO webhook_deliveries (id, webhook_id, event_id, request_body) VALUES ($1,$2,$3,$4) ON CONFLICT (webhook_id,event_id) DO NOTHING`, deliveryID, wh.ID, eventID, bodyBytes)
	maxAttempts := wh.RetryMax + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	result := webhookDeliveryResult{}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		result.Attempts = attempt
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		sig := signWebhookPayload(wh.Secret, timestamp, bodyBytes)
		client := webhookHTTPClient(time.Duration(wh.TimeoutMs) * time.Millisecond)
		req, err := http.NewRequest(http.MethodPost, wh.URL, bytes.NewReader(bodyBytes))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("User-Agent", "BotLand-Webhook/1.0")
			req.Header.Set("X-BotLand-Webhook-ID", wh.ID)
			req.Header.Set("X-BotLand-Event-ID", eventID)
			req.Header.Set("X-BotLand-Event-Type", eventType)
			req.Header.Set("X-BotLand-Timestamp", timestamp)
			req.Header.Set("X-BotLand-Signature", sig)
		}
		if err == nil {
			resp, err2 := client.Do(req)
			if err2 == nil {
				result.ResponseStatus = resp.StatusCode
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					_, _ = s.db.Exec(`UPDATE webhook_deliveries SET status='success', attempt_count=$1, response_status=$2, delivered_at=NOW(), last_error=NULL WHERE webhook_id=$3 AND event_id=$4`, attempt, resp.StatusCode, wh.ID, eventID)
					_, _ = s.db.Exec(`UPDATE webhooks SET last_success_at=NOW(), updated_at=NOW() WHERE id=$1`, wh.ID)
					result.Success = true
					return result
				}
				result.Error = "http status " + strconv.Itoa(resp.StatusCode)
			} else {
				result.Error = err2.Error()
			}
		} else {
			result.Error = err.Error()
		}
		_, _ = s.db.Exec(`UPDATE webhook_deliveries SET attempt_count=$1, response_status=NULLIF($2,0), last_error=$3, next_attempt_at=NOW()+($4 || ' seconds')::interval WHERE webhook_id=$5 AND event_id=$6`, attempt, result.ResponseStatus, result.Error, 1<<(attempt-1), wh.ID, eventID)
		if attempt < maxAttempts {
			time.Sleep(time.Duration(1<<uint(attempt-1)) * time.Second)
		}
	}
	_, _ = s.db.Exec(`UPDATE webhook_deliveries SET status='failed', attempt_count=$1, response_status=NULLIF($2,0), last_error=$3 WHERE webhook_id=$4 AND event_id=$5`, result.Attempts, result.ResponseStatus, result.Error, wh.ID, eventID)
	_, _ = s.db.Exec(`UPDATE webhooks SET last_failure_at=NOW(), updated_at=NOW() WHERE id=$1`, wh.ID)
	return result
}

func signWebhookPayload(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

type sendMessageRequest struct {
	To      string                 `json:"to"`
	Text    string                 `json:"text"`
	Payload map[string]interface{} `json:"payload"`
}

func (s *Service) SendMessageHTTP(w http.ResponseWriter, r *http.Request) {
	citizenID, _ := r.Context().Value("citizen_id").(string)
	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": "invalid body"}})
		return
	}
	target := strings.TrimSpace(req.To)
	if strings.HasPrefix(target, "group:") {
		target = strings.TrimPrefix(target, "group:")
	}
	if target == "" {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": "to is required"}})
		return
	}
	payload := req.Payload
	if payload == nil {
		payload = map[string]interface{}{}
	}
	if req.Text != "" {
		payload["text"] = req.Text
	}
	if _, ok := payload["content_type"]; !ok {
		payload["content_type"] = protocol.ContentText
	}
	if strings.TrimSpace(stringVal(payload["text"])) == "" && payload["media_url"] == nil && payload["url"] == nil {
		writeRelayJSON(w, http.StatusBadRequest, map[string]interface{}{"error": map[string]string{"code": "VALIDATION_ERROR", "message": "text or payload content required"}})
		return
	}

	if strings.HasPrefix(target, "group_") {
		if s.groupHandler == nil || !containsString(s.groupHandler.GetGroupMembers(target), citizenID) {
			writeRelayJSON(w, http.StatusForbidden, map[string]interface{}{"error": map[string]string{"code": "FORBIDDEN", "message": "not a member of this group"}})
			return
		}
	} else {
		target = s.resolveDirectTargetID(target)
		var exists bool
		if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM citizens WHERE id=$1 AND status='active')`, target).Scan(&exists); err != nil || !exists {
			writeRelayJSON(w, http.StatusNotFound, map[string]interface{}{"error": map[string]string{"code": "NOT_FOUND", "message": "target citizen not found"}})
			return
		}
	}

	msgID := "msg_" + auth.NewULID()
	env := &protocol.Envelope{Type: protocol.TypeMessageSend, ID: msgID, To: target, Payload: payload, Timestamp: time.Now().UTC().Format(time.RFC3339)}
	s.RouteMessage(citizenID, env)
	writeRelayJSON(w, http.StatusAccepted, map[string]interface{}{"status": "accepted", "message_id": msgID, "to": target})
}

func stringVal(v interface{}) string {
	s, _ := v.(string)
	return s
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
