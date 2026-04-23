package relay

import (
	"database/sql"
	"encoding/json"
	"log/slog"
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

	// Forward read receipt
	if env.From != "" {
		s.hub.Send(env.From, &protocol.Envelope{
			Type: protocol.TypeMessageStatus,
			Payload: protocol.AckPayload{
				MessageID: env.ID,
				Status:    "read",
			},
		})
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
	if env.To != "" {
		s.hub.Send(env.To, &protocol.Envelope{
			Type:    env.Type,
			From:    from,
			Payload: env.Payload,
		})
	}
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
