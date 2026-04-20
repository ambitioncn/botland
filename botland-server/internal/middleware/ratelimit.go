package middleware

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// RateLimiter is a simple in-memory sliding window rate limiter.
type RateLimiter struct {
	mu       sync.Mutex
	windows  map[string][]time.Time
	limit    int
	window   time.Duration
	cleanAt  time.Time
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		windows: make(map[string][]time.Time),
		limit:   limit,
		window:  window,
	}
}

func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	// Periodic cleanup (every 5 minutes)
	if now.After(rl.cleanAt) {
		cutoff := now.Add(-rl.window * 2)
		for k, times := range rl.windows {
			filtered := times[:0]
			for _, t := range times {
				if t.After(cutoff) {
					filtered = append(filtered, t)
				}
			}
			if len(filtered) == 0 {
				delete(rl.windows, k)
			} else {
				rl.windows[k] = filtered
			}
		}
		rl.cleanAt = now.Add(5 * time.Minute)
	}

	// Filter to current window
	cutoff := now.Add(-rl.window)
	times := rl.windows[key]
	filtered := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}

	if len(filtered) >= rl.limit {
		rl.windows[key] = filtered
		return false
	}

	rl.windows[key] = append(filtered, now)
	return true
}

// --- Pre-built limiters ---

var (
	// Auth endpoints: 10 requests per minute per IP
	AuthLimiter = NewRateLimiter(10, 1*time.Minute)

	// Challenge: 5 per minute per IP (prevent spam)
	ChallengeLimiter = NewRateLimiter(20, 1*time.Minute)

	// Message sending: 60 per minute per citizen
	MessageLimiter = NewRateLimiter(60, 1*time.Minute)

	// General API: 120 per minute per IP
	GeneralLimiter = NewRateLimiter(120, 1*time.Minute)

	// WebSocket connect: 5 per minute per IP
	WSConnectLimiter = NewRateLimiter(20, 1*time.Minute)
)

// RateLimit returns middleware that rate-limits by IP using the given limiter.
func RateLimit(rl *RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.RemoteAddr
			// Use X-Real-IP if behind proxy
			if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
				key = realIP
			}

			if !rl.Allow(key) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"error": map[string]interface{}{
						"code":    "RATE_LIMITED",
						"message": "too many requests, please try again later",
						"status":  429,
					},
				})
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RateLimitByCitizen rate-limits by citizen_id from JWT context.
func RateLimitByCitizen(rl *RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := "unknown"
			if cid, ok := r.Context().Value("citizen_id").(string); ok && cid != "" {
				key = cid
			}

			if !rl.Allow(key) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"error": map[string]interface{}{
						"code":    "RATE_LIMITED",
						"message": "too many requests, please slow down",
						"status":  429,
					},
				})
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
