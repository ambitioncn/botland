package ws

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	mw "github.com/nicknnn/botland-server/internal/middleware"
	"github.com/nicknnn/botland-server/pkg/protocol"
)

const (
	authTimeout = 10 * time.Second // Must authenticate within 10s
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// authFrame is the first message a client must send after connecting.
type authFrame struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

func HandleUpgrade(hub *Hub, logger *slog.Logger, authFn func(string) string, onMessage func(*Client, *protocol.Envelope), onConnect func(string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Rate limit WS connections by IP
		ip := r.RemoteAddr
		if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
			ip = realIP
		}
		if !mw.WSConnectLimiter.Allow(ip) {
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}

		// --- Determine auth method ---
		// Priority: 1) Authorization header  2) query ?token=  3) auth frame (post-connect)
		var citizenID string

		// Method 1: Authorization header
		if auth := r.Header.Get("Authorization"); len(auth) > 7 {
			citizenID = authFn(auth[7:])
		}

		// Method 2: Query param (legacy, will be deprecated)
		if citizenID == "" {
			if token := r.URL.Query().Get("token"); token != "" {
				citizenID = authFn(token)
			}
		}

		// Upgrade connection regardless (auth frame may follow)
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Error("upgrade failed", "err", err)
			return
		}

		// Method 3: Auth frame — if not yet authenticated, wait for first message
		if citizenID == "" {
			citizenID = waitForAuthFrame(conn, authFn, logger)
			if citizenID == "" {
				// Auth failed — send error and close
				errMsg, _ := json.Marshal(protocol.Envelope{
					Type: "error",
					Payload: map[string]string{
						"code":    "AUTH_FAILED",
						"message": "authentication failed or timed out",
					},
				})
				conn.WriteMessage(websocket.TextMessage, errMsg)
				conn.Close()
				return
			}
		}

		client := NewClient(citizenID, conn, hub, logger, onMessage)

		// Register (kicks old client if same citizen)
		hub.Register(client)

		// Send connected message
		msg := protocol.Envelope{
			Type: protocol.TypeConnected,
			Payload: map[string]string{
				"citizen_id":  citizenID,
				"server_time": time.Now().UTC().Format(time.RFC3339),
			},
		}
		data, _ := json.Marshal(msg)
		client.Send(data)

		// Deliver pending offline messages
		if onConnect != nil {
			go onConnect(citizenID)
		}

		// Run client (blocks until both pumps exit)
		go client.Run()
	}
}

// waitForAuthFrame reads the first WebSocket message as an auth frame.
// Returns citizenID on success, empty string on failure.
func waitForAuthFrame(conn *websocket.Conn, authFn func(string) string, logger *slog.Logger) string {
	conn.SetReadDeadline(time.Now().Add(authTimeout))

	_, message, err := conn.ReadMessage()
	if err != nil {
		logger.Debug("auth frame read failed", "err", err)
		return ""
	}

	// Reset deadline
	conn.SetReadDeadline(time.Time{})

	var frame authFrame
	if err := json.Unmarshal(message, &frame); err != nil {
		logger.Debug("auth frame parse failed", "err", err)
		return ""
	}

	if frame.Type != "auth" || frame.Token == "" {
		logger.Debug("invalid auth frame", "type", frame.Type)
		return ""
	}

	citizenID := authFn(frame.Token)
	if citizenID == "" {
		logger.Debug("auth frame token invalid")
	}
	return citizenID
}
