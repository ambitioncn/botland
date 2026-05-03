package api

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/nicknnn/botland-server/internal/auth"
	"github.com/nicknnn/botland-server/internal/citizen"
	"github.com/nicknnn/botland-server/internal/media"
	"github.com/nicknnn/botland-server/internal/push"
	mw "github.com/nicknnn/botland-server/internal/middleware"
	"github.com/nicknnn/botland-server/internal/moment"
	"github.com/nicknnn/botland-server/internal/relay"
	"github.com/nicknnn/botland-server/internal/relationship"
	"github.com/nicknnn/botland-server/internal/botcard"
	"github.com/nicknnn/botland-server/internal/group"
	ws "github.com/nicknnn/botland-server/internal/ws"
)

func NewRouter(db *sql.DB, jwtSvc *auth.JWTService, hub *ws.Hub, relaySvc *relay.Service, logger *slog.Logger, baseURL string) *chi.Mux {
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(mw.CORS)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))

	authH := auth.NewHandler(db, jwtSvc, logger)
	relH := relationship.NewHandler(db, logger)
	relH.SetIsOnlineFunc(hub.IsOnline)
	citizenH := citizen.NewHandler(db, logger)
	momentH := moment.NewHandler(db, logger)
	mediaH := media.NewHandler(logger, baseURL)
	pushH := push.NewHandler(db, logger)
	botCardH := botcard.NewHandler(db)
	groupH := group.NewHandler(db, hub, logger)

	// Serve uploaded files
	r.Handle("/uploads/*", http.StripPrefix("/uploads", http.FileServer(http.Dir(media.UploadDir))))

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "service": "botland", "time": time.Now().UTC().Format(time.RFC3339)})
	})

	r.Route("/api/v1", func(r chi.Router) {
		// Public auth endpoints
		r.Group(func(r chi.Router) {
			r.Use(mw.RateLimit(mw.ChallengeLimiter))
			r.Post("/auth/challenge", authH.StartChallenge)
			r.Post("/auth/challenge/answer", authH.AnswerChallenge)
		})
		r.Group(func(r chi.Router) {
			r.Use(mw.RateLimit(mw.AuthLimiter))
			r.Get("/auth/check-handle", authH.CheckHandle)
			r.Post("/auth/register", authH.Register)
			r.Post("/auth/login", authH.Login)
			r.Post("/auth/refresh", authH.Refresh)
		})

		// Public bot-cards endpoints
		r.Post("/bot-cards/resolve", botCardH.Resolve)
		r.Get("/bot-cards/{slug}", botCardH.GetCard)

		// Authenticated endpoints
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthRequired(jwtSvc))
			r.Use(mw.RateLimitByCitizen(mw.GeneralLimiter))
			r.Use(mw.SignedRequest)

			r.Get("/me", citizenH.GetMe)
			r.Patch("/me", citizenH.UpdateMe)
			r.Get("/citizens/{citizenID}", citizenH.GetCitizen)
			r.Get("/citizens/{citizenID}/relationship-summary", relH.GetRelationshipSummary)

			r.Post("/invite-codes", authH.CreateBotCardCode) // legacy route; product concept = bot card
			r.Get("/invite-codes", ph("list_invites"))

			r.Post("/friends/requests", relH.SendFriendRequest)
			r.Get("/friends/requests", relH.ListFriendRequests)
			r.Post("/friends/requests/{requestID}/accept", relH.AcceptFriendRequest)
			r.Post("/friends/requests/{requestID}/reject", relH.RejectFriendRequest)
			r.Get("/friends", relH.ListFriends)

			// Message history & search
			r.Get("/messages/history", relaySvc.GetDMHistory)
			r.Get("/messages/search", relaySvc.SearchMessages)
			r.Patch("/friends/{citizenID}/label", relH.UpdateLabel)
			r.Delete("/friends/{citizenID}", relH.RemoveFriend)
			r.Post("/friends/{citizenID}/block", relH.BlockCitizen)

			r.Post("/groups", groupH.CreateGroup)
			r.Get("/groups", groupH.ListGroups)
			r.Get("/groups/{groupID}", groupH.GetGroup)
			r.Put("/groups/{groupID}", groupH.UpdateGroup)
			r.Delete("/groups/{groupID}", groupH.DisbandGroup)
			r.Post("/groups/{groupID}/members", groupH.InviteMembers)
			r.Delete("/groups/{groupID}/members/{citizenID}", groupH.RemoveMember)
			r.Put("/groups/{groupID}/members/{citizenID}/role", groupH.UpdateMemberRole)
			r.Post("/groups/{groupID}/leave", groupH.LeaveGroup)
			r.Get("/groups/{groupID}/messages", groupH.GetMessages)
			r.Post("/groups/{groupID}/transfer", groupH.TransferOwnership)
			r.Post("/groups/{groupID}/mute-all", groupH.ToggleMuteAll)

			r.Get("/discover/search", citizenH.Search)
			r.Get("/discover/trending", citizenH.Trending)

			// Moments
			r.Post("/moments", momentH.CreateMoment)
			r.Get("/moments/timeline", momentH.Timeline)
			r.Get("/moments/{momentID}", momentH.GetMoment)
			r.Delete("/moments/{momentID}", momentH.DeleteMoment)
			r.Post("/moments/{momentID}/like", momentH.LikeMoment)
			r.Post("/moments/{momentID}/comments", momentH.CommentMoment)

			// Media upload
			r.Post("/media/upload", mediaH.Upload)

			// Push notifications
			r.Post("/push/register", pushH.RegisterToken)
			r.Post("/push/unregister", pushH.UnregisterToken)

			// Bot Card bindings
			r.Post("/bot-cards/bind", botCardH.Bind)
		r.Post("/bot-cards/use", botCardH.UseCard)
			r.Get("/me/bot-bindings", botCardH.ListBindings)
			r.Get("/me/bot-card", botCardH.GetMyCard)

			r.Post("/reports", ph("create_report"))
		})
	})
	return r
}

func ph(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(501)
		json.NewEncoder(w).Encode(map[string]string{"status": "not_implemented", "endpoint": name})
	}
}
