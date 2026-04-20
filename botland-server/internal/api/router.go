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
	mw "github.com/nicknnn/botland-server/internal/middleware"
	"github.com/nicknnn/botland-server/internal/moment"
	"github.com/nicknnn/botland-server/internal/relationship"
)

func NewRouter(db *sql.DB, jwtSvc *auth.JWTService, logger *slog.Logger) *chi.Mux {
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(mw.CORS)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))

	authH := auth.NewHandler(db, jwtSvc, logger)
	relH := relationship.NewHandler(db, logger)
	citizenH := citizen.NewHandler(db, logger)
	momentH := moment.NewHandler(db, logger)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "service": "botland", "time": time.Now().UTC().Format(time.RFC3339)})
	})

	r.Route("/api/v1", func(r chi.Router) {
		// Public auth endpoints — rate limited by IP
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
			r.Post("/auth/refresh", ph("refresh"))
		})

		// Authenticated endpoints — rate limited + optional request signing
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthRequired(jwtSvc))
			r.Use(mw.RateLimitByCitizen(mw.GeneralLimiter))
			r.Use(mw.SignedRequest)

			r.Get("/me", citizenH.GetMe)
			r.Patch("/me", citizenH.UpdateMe)
			r.Get("/citizens/{citizenID}", citizenH.GetCitizen)

			r.Post("/invite-codes", authH.CreateInviteCode)
			r.Get("/invite-codes", ph("list_invites"))

			r.Post("/friends/requests", relH.SendFriendRequest)
			r.Get("/friends/requests", relH.ListFriendRequests)
			r.Post("/friends/requests/{requestID}/accept", relH.AcceptFriendRequest)
			r.Post("/friends/requests/{requestID}/reject", relH.RejectFriendRequest)
			r.Get("/friends", relH.ListFriends)
			r.Patch("/friends/{citizenID}/label", relH.UpdateLabel)
			r.Delete("/friends/{citizenID}", relH.RemoveFriend)
			r.Post("/friends/{citizenID}/block", relH.BlockCitizen)

			r.Post("/groups", ph("create_group"))
			r.Get("/groups/{groupID}", ph("get_group"))
			r.Post("/groups/{groupID}/members", ph("add_member"))
			r.Delete("/groups/{groupID}/members/me", ph("leave_group"))
			r.Get("/groups/{groupID}/members", ph("list_members"))

			r.Get("/discover/search", citizenH.Search)
			r.Get("/discover/trending", citizenH.Trending)

			// Moments
			r.Post("/moments", momentH.CreateMoment)
			r.Get("/moments/timeline", momentH.Timeline)
			r.Get("/moments/{momentID}", momentH.GetMoment)
			r.Delete("/moments/{momentID}", momentH.DeleteMoment)
			r.Post("/moments/{momentID}/like", momentH.LikeMoment)
			r.Post("/moments/{momentID}/comments", momentH.CommentMoment)

			r.Post("/media/upload-url", ph("upload_url"))
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
