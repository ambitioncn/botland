package relay

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/nicknnn/botland-server/internal/auth"
	"github.com/nicknnn/botland-server/internal/ws"
	"github.com/nicknnn/botland-server/pkg/protocol"
)

type Service struct {
	db     *sql.DB
	hub    *ws.Hub
	logger *slog.Logger
}

func NewService(db *sql.DB, hub *ws.Hub, logger *slog.Logger) *Service {
	return &Service{db: db, hub: hub, logger: logger}
}

// RouteMessage handles an incoming message: deliver in real-time or store offline.
func (s *Service) RouteMessage(from string, env *protocol.Envelope) {
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
		// Offline: store in relay
		s.storeOffline(from, env)
		s.logger.Info("message stored offline", "from", from, "to", env.To, "id", env.ID)
	}
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
		return 0
	}
	defer rows.Close()

	var delivered int
	var ids []string
	for rows.Next() {
		var id string
		var payloadBytes []byte
		rows.Scan(&id, &payloadBytes)

		var stored map[string]interface{}
		json.Unmarshal(payloadBytes, &stored)

		env := &protocol.Envelope{
			Type:      protocol.TypeMessageReceived,
			ID:        strVal(stored["id"]),
			From:      strVal(stored["from"]),
			To:        citizenID,
			Timestamp: strVal(stored["timestamp"]),
			Payload:   stored["payload"],
		}
		if s.hub.Send(citizenID, env) {
			ids = append(ids, id)
			delivered++
		}
	}

	// Mark as delivered
	for _, id := range ids {
		s.db.Exec("UPDATE message_relay SET status='delivered', delivered_at=NOW() WHERE id=$1", id)
	}

	if delivered > 0 {
		s.logger.Info("delivered pending messages", "citizen_id", citizenID, "count", delivered)
	}
	return delivered
}

// HandleAck processes message acknowledgements
func (s *Service) HandleAck(from string, env *protocol.Envelope) {
	payloadBytes, _ := json.Marshal(env.Payload)
	var ack protocol.AckPayload
	json.Unmarshal(payloadBytes, &ack)

	if ack.MessageID == "" {
		return
	}

	// Forward ack to the original sender (find from relay or just broadcast)
	// For now, we look up the relay entry
	var originalFrom string
	s.db.QueryRow("SELECT from_id FROM message_relay WHERE payload->>'id' = $1", ack.MessageID).Scan(&originalFrom)

	if originalFrom != "" {
		s.hub.Send(originalFrom, &protocol.Envelope{
			Type: protocol.TypeMessageStatus,
			Payload: protocol.AckPayload{
				MessageID: ack.MessageID,
				Status:    ack.Status,
			},
		})
	}
}

// HandleTyping forwards typing indicators
func (s *Service) HandleTyping(from string, env *protocol.Envelope) {
	indicator := &protocol.Envelope{
		Type: protocol.TypeTypingIndicator,
		From: from,
		To:   env.To,
	}
	s.hub.Send(env.To, indicator)
}

// HandleReaction forwards reactions
func (s *Service) HandleReaction(from string, env *protocol.Envelope) {
	reaction := &protocol.Envelope{
		Type:      "message.reaction.received",
		ID:        "react_" + auth.NewULID(),
		From:      from,
		To:        env.To,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   env.Payload,
	}
	s.hub.Send(env.To, reaction)
}

// CleanExpired removes messages older than TTL
func (s *Service) CleanExpired() (int64, error) {
	res, err := s.db.Exec("DELETE FROM message_relay WHERE created_at < NOW() - (ttl_hours || ' hours')::INTERVAL")
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func strVal(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
