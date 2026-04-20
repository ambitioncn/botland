package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/nicknnn/botland-server/internal/auth"
)

func AuthRequired(jwtSvc *auth.JWTService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" {
				http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"missing token","status":401}}`, http.StatusUnauthorized)
				return
			}

			token := strings.TrimPrefix(header, "Bearer ")
			if token == header {
				http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"invalid auth header","status":401}}`, http.StatusUnauthorized)
				return
			}

			claims, err := jwtSvc.ValidateToken(token)
			if err != nil {
				http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"invalid or expired token","status":401}}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), "citizen_id", claims.CitizenID)
			ctx = context.WithValue(ctx, "citizen_type", claims.CitizenType)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
