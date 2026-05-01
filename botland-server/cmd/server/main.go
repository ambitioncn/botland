package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/nicknnn/botland-server/internal/api"
	"github.com/nicknnn/botland-server/internal/auth"
	"github.com/nicknnn/botland-server/internal/config"
	"github.com/nicknnn/botland-server/internal/push"
	"github.com/nicknnn/botland-server/internal/group"
	"github.com/nicknnn/botland-server/internal/relay"
	"github.com/nicknnn/botland-server/internal/ws"
	"github.com/nicknnn/botland-server/pkg/protocol"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg := config.Load()
	logger.Info("starting botland server", "port", cfg.Port, "env", cfg.Environment)

	db, err := config.ConnectDB(cfg, logger)
	if err != nil {
		logger.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// ES256 key-based JWT
	var jwtSvc *auth.JWTService
	if cfg.JWTKeyPath != "" {
		jwtSvc = auth.NewJWTService(cfg.JWTKeyPath)
		logger.Info("JWT using ES256 with key file", "path", cfg.JWTKeyPath)
	} else {
		// Generate ephemeral key (dev mode)
		jwtSvc = auth.NewJWTService("")
		logger.Warn("JWT using ephemeral ES256 key (tokens won't survive restart)")
	}
	hub := ws.NewHub(logger)
	relaySvc := relay.NewService(db, hub, logger)

	hub.SetOnDisconnect(func(citizenID string) {
		relaySvc.BroadcastPresence(citizenID, "offline")
	})

	groupH := group.NewHandler(db, hub, logger)
	relaySvc.SetGroupHandler(groupH)

	wsAuth := func(token string) string {
		claims, err := jwtSvc.ValidateToken(token)
		if err != nil {
			return ""
		}
		return claims.CitizenID
	}

	pushH := push.NewHandler(db, logger)
	relaySvc.SetPushFunc(pushH.SendPush)

	onMessage := func(client *ws.Client, env *protocol.Envelope) {
		switch env.Type {
		case protocol.TypeMessageSend:
			relaySvc.RouteMessage(client.CitizenID, env)
		case protocol.TypeMessageAck:
			relaySvc.HandleAck(client.CitizenID, env)
		case protocol.TypeTypingStart, protocol.TypeTypingStop, protocol.TypeGroupTypingStart, protocol.TypeGroupTypingStop:
			logger.Info("typing event inbound", "type", env.Type, "from", client.CitizenID, "to", env.To)
			if env.To != "" && len(env.To) > 6 && env.To[:6] == "group_" {
				relaySvc.HandleGroupTyping(client.CitizenID, env)
			} else {
				relaySvc.HandleTyping(client.CitizenID, env)
			}
		case protocol.TypeGroupMessageSend:
			relaySvc.RouteMessage(client.CitizenID, env)
		case protocol.TypeMessageReaction:
			relaySvc.HandleReaction(client.CitizenID, env)
		case protocol.TypePresenceUpdate:
			logger.Info("presence update", "from", client.CitizenID)
			go relaySvc.BroadcastPresence(client.CitizenID, "online")
		default:
			logger.Warn("unhandled ws type", "type", env.Type)
		}
	}

	onConnect := func(citizenID string) {
		relaySvc.DeliverPending(citizenID)
		go relaySvc.BroadcastPresence(citizenID, "online")
	}

	router := api.NewRouter(db, jwtSvc, hub, relaySvc, logger, "https://api.botland.im")
	router.Get("/ws", ws.HandleUpgrade(hub, logger, wsAuth, onMessage, onConnect))

	addr := fmt.Sprintf(":%d", cfg.Port)
	logger.Info("listening", "addr", addr)
	if err := http.ListenAndServe(addr, router); err != nil {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}
