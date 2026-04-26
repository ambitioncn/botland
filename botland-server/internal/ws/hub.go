package ws

import (
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/nicknnn/botland-server/pkg/protocol"
)

type Hub struct {
	mu           sync.RWMutex
	clients      map[string]*Client
	logger       *slog.Logger
	onDisconnect func(citizenID string)
}

func NewHub(logger *slog.Logger) *Hub {
	return &Hub{clients: make(map[string]*Client), logger: logger}
}

// SetOnDisconnect sets a callback that fires when a client unregisters.
func (h *Hub) SetOnDisconnect(fn func(citizenID string)) {
	h.onDisconnect = fn
}

// Register adds client. Kicks existing client for same citizen (if any).
func (h *Hub) Register(client *Client) {
	h.mu.Lock()
	old := h.clients[client.CitizenID]
	h.clients[client.CitizenID] = client
	h.mu.Unlock()

	if old != nil && old != client {
		h.logger.Info("kicking old", "old", old.id, "new", client.id)
		old.Shutdown()
	}
	h.logger.Info("registered", "cid", client.id)
}

// Unregister removes client only if it's still the current one.
func (h *Hub) Unregister(client *Client) {
	h.mu.Lock()
	removed := false
	if cur, ok := h.clients[client.CitizenID]; ok && cur == client {
		delete(h.clients, client.CitizenID)
		removed = true
		h.logger.Info("unregistered", "cid", client.id)
	}
	h.mu.Unlock()
	if removed && h.onDisconnect != nil {
		go h.onDisconnect(client.CitizenID)
	}
}

func (h *Hub) Send(citizenID string, env *protocol.Envelope) bool {
	h.mu.RLock()
	client, ok := h.clients[citizenID]
	h.mu.RUnlock()
	if !ok || client == nil || client.IsClosed() {
		return false
	}
	data, err := json.Marshal(env)
	if err != nil {
		return false
	}
	return client.Send(data)
}

func (h *Hub) IsOnline(citizenID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[citizenID]
	return ok && c != nil && !c.IsClosed()
}

func (h *Hub) OnlineCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, c := range h.clients {
		if c != nil && !c.IsClosed() {
			n++
		}
	}
	return n
}
