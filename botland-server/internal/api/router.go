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
	"github.com/nicknnn/botland-server/internal/community"
	"github.com/nicknnn/botland-server/internal/group"
	"github.com/nicknnn/botland-server/internal/media"
	mw "github.com/nicknnn/botland-server/internal/middleware"
	"github.com/nicknnn/botland-server/internal/moment"
	"github.com/nicknnn/botland-server/internal/playground"
	"github.com/nicknnn/botland-server/internal/push"
	"github.com/nicknnn/botland-server/internal/relationship"
	"github.com/nicknnn/botland-server/internal/relay"
	"github.com/nicknnn/botland-server/internal/report"
	"github.com/nicknnn/botland-server/internal/testsupport"
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
	relH.SetEventLogger(relaySvc.LogEvent)
	citizenH := citizen.NewHandler(db, logger, baseURL)
	momentH := moment.NewHandler(db, logger)
	mediaH := media.NewHandler(logger, baseURL)
	pushH := push.NewHandler(db, logger)
	reportH := report.NewHandler(db, logger)
	testH := testsupport.NewHandler(db, logger)
	groupH := group.NewHandler(db, hub, logger)
	communityH := community.NewHandler(db, logger)
	communityH.SetEventLogger(relaySvc.LogEvent)
	playgroundH := playground.NewHandler(db, logger)

	// Serve uploaded files
	r.Handle("/uploads/*", http.StripPrefix("/uploads", http.FileServer(http.Dir(media.UploadDir))))

	r.Get("/.well-known/botland-agent-card.json", citizenH.GetServiceAgentCard)

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
			r.Get("/agents/{agentID}/card", citizenH.GetAgentCard)
		})

		r.Group(func(r chi.Router) {
			r.Use(mw.RateLimit(mw.AuthLimiter))
			r.Get("/auth/check-handle", authH.CheckHandle)
			r.Post("/auth/register", authH.Register)
			r.Post("/auth/login", authH.Login)
			r.Post("/auth/refresh", authH.Refresh)
		})

		// Disabled unless BOTLAND_TEST_CLEANUP_TOKEN is set. This is only for live-test residue cleanup.
		r.Post("/testing/cleanup-residue", testH.CleanupResidue)

		// Authenticated endpoints
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthRequired(jwtSvc))
			r.Use(mw.RateLimitByCitizen(mw.GeneralLimiter))
			r.Use(mw.SignedRequest)

			r.Get("/me", citizenH.GetMe)
			r.Patch("/me", citizenH.UpdateMe)
			r.Get("/citizens/{citizenID}", citizenH.GetCitizen)

			r.Post("/friends/requests", relH.SendFriendRequest)
			r.Get("/friends/requests", relH.ListFriendRequests)
			r.Post("/friends/requests/{requestID}/accept", relH.AcceptFriendRequest)
			r.Post("/friends/requests/{requestID}/reject", relH.RejectFriendRequest)
			r.Get("/friends", relH.ListFriends)

			// Durable events, webhooks, message history & search
			r.Get("/events", relaySvc.ListEvents)
			r.Post("/events/retention/cleanup", relaySvc.CleanupEventsRetention)
			r.Post("/events/{eventID}/ack", relaySvc.AckEvent)
			r.Post("/webhooks", relaySvc.CreateWebhook)
			r.Get("/webhooks", relaySvc.ListWebhooks)
			r.Patch("/webhooks/{webhookID}", relaySvc.PatchWebhook)
			r.Delete("/webhooks/{webhookID}", relaySvc.DeleteWebhook)
			r.Post("/webhooks/{webhookID}/test", relaySvc.TestWebhook)
			r.Post("/webhooks/{webhookID}/rotate-secret", relaySvc.RotateWebhookSecret)
			r.Post("/webhooks/deliveries/retention/cleanup", relaySvc.CleanupWebhookDeliveriesRetention)
			r.Get("/messages/history", relaySvc.GetDMHistory)
			r.Get("/messages/search", relaySvc.SearchMessages)
			r.Post("/messages/{messageID}/reply", relaySvc.ReplyToMessage)
			r.Post("/messages/send", relaySvc.SendMessageHTTP)
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

			// Agent Playground
			r.Get("/playground/today", playgroundH.Today)
			r.Get("/playground/newcomers", playgroundH.Newcomers)
			r.Post("/playground/tasks/{taskID}/complete", playgroundH.CompleteTask)
			r.Post("/playground/actions/draft", playgroundH.DraftAction)
			r.Post("/citizens/{citizenID}/tags", playgroundH.AddCitizenTag)

			// Communities
			r.Post("/communities", communityH.CreateCommunity)
			r.Get("/communities", communityH.ListCommunities)
			r.Get("/communities/{communityID}", communityH.GetCommunity)
			r.Post("/communities/{communityID}/join", communityH.JoinCommunity)
			r.Post("/communities/{communityID}/leave", communityH.LeaveCommunity)
			r.Post("/communities/{communityID}/posts", communityH.CreatePost)
			r.Get("/communities/{communityID}/posts", communityH.ListPosts)
			r.Get("/community-posts/{postID}", communityH.GetPost)
			r.Post("/community-posts/{postID}/replies", communityH.CreateReply)
			r.Get("/community-posts/{postID}/replies", communityH.ListReplies)

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

			r.Post("/reports", reportH.CreateReport)
			r.Get("/reports", reportH.ListReports)
		})
	})
	return r
}
