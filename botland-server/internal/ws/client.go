package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nicknnn/botland-server/pkg/protocol"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 90 * time.Second
	pingPeriod     = 30 * time.Second
	maxMessageSize = 65536
	sendBufSize    = 256
)

var clientSeq uint64

type Client struct {
	CitizenID string
	id        string
	conn      *websocket.Conn
	hub       *Hub
	send      chan []byte
	logger    *slog.Logger
	onMessage func(*Client, *protocol.Envelope)

	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func NewClient(citizenID string, conn *websocket.Conn, hub *Hub, logger *slog.Logger, onMessage func(*Client, *protocol.Envelope)) *Client {
	seq := atomic.AddUint64(&clientSeq, 1)
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		CitizenID: citizenID,
		id:        fmt.Sprintf("%s#%d", citizenID, seq),
		conn:      conn,
		hub:       hub,
		send:      make(chan []byte, sendBufSize),
		logger:    logger,
		onMessage: onMessage,
		ctx:       ctx,
		cancel:    cancel,
	}
}

// Run starts read and write loops. Blocks until both exit.
// The caller should call this in a goroutine.
func (c *Client) Run() {
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		c.writePump()
	}()
	go func() {
		defer wg.Done()
		c.readPump()
	}()

	wg.Wait()

	// Both pumps done — clean up
	c.hub.Unregister(c)
	c.conn.Close()
	c.logger.Info("client fully stopped", "cid", c.id)
}

func (c *Client) readPump() {
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			c.logger.Info("read error", "cid", c.id, "err", err.Error())
			c.Shutdown() // signal everything to stop
			return
		}

		var env protocol.Envelope
		if err := json.Unmarshal(message, &env); err != nil {
			c.logger.Warn("bad json", "cid", c.id, "err", err)
			continue
		}

		if env.Type == protocol.TypePing {
			pong := protocol.Envelope{Type: protocol.TypePong}
			data, _ := json.Marshal(pong)
			c.Send(data)
			continue
		}

		env.From = c.CitizenID
		if c.onMessage != nil {
			c.onMessage(c, &env)
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			c.logger.Info("writepump ctx done", "cid", c.id)
			// Try to send a close frame
			_ = c.conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
				time.Now().Add(time.Second))
			return

		case msg, ok := <-c.send:
			if !ok {
				return
			}
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.logger.Warn("write err", "cid", c.id, "err", err)
				c.Shutdown()
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.logger.Warn("ping err", "cid", c.id, "err", err)
				c.Shutdown()
				return
			}
		}
	}
}

// Send enqueues data for writing. Returns false if client is shutting down or buffer full.
func (c *Client) Send(data []byte) bool {
	select {
	case c.send <- data:
		return true
	case <-c.ctx.Done():
		return false
	default:
		c.logger.Warn("send buf full", "cid", c.id)
		return false
	}
}

// Shutdown triggers graceful stop (idempotent).
func (c *Client) Shutdown() {
	c.once.Do(func() {
		c.logger.Info("shutdown", "cid", c.id)
		c.cancel()
	})
}

// IsClosed returns true after Shutdown().
func (c *Client) IsClosed() bool {
	return c.ctx.Err() != nil
}
