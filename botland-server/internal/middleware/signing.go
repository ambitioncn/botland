package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// --- Nonce Store (in-memory, TTL-based) ---

type nonceStore struct {
	mu     sync.Mutex
	seen   map[string]time.Time
	maxAge time.Duration
}

var nonces = &nonceStore{
	seen:   make(map[string]time.Time),
	maxAge: 5 * time.Minute,
}

func (ns *nonceStore) Check(nonce string) bool {
	ns.mu.Lock()
	defer ns.mu.Unlock()

	now := time.Now()

	// Cleanup every call (cheap enough for MVP scale)
	if len(ns.seen) > 10000 {
		for k, t := range ns.seen {
			if now.Sub(t) > ns.maxAge {
				delete(ns.seen, k)
			}
		}
	}

	if _, exists := ns.seen[nonce]; exists {
		return false // replay
	}

	ns.seen[nonce] = now
	return true
}

// --- Request Signing Middleware ---

// SignedRequest validates HMAC-SHA256 request signatures.
//
// Required headers:
//   - X-BL-Timestamp: Unix seconds (must be within ±5 min)
//   - X-BL-Nonce: Unique request ID (prevents replay)
//   - X-BL-Signature: HMAC-SHA256(timestamp + "\n" + nonce + "\n" + method + "\n" + path + "\n" + bodyHash)
//
// The signing key is derived from the citizen's access token (first 32 bytes of SHA256).
// This is optional middleware — only applied to sensitive endpoints.
func SignedRequest(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ts := r.Header.Get("X-BL-Timestamp")
		nonce := r.Header.Get("X-BL-Nonce")
		sig := r.Header.Get("X-BL-Signature")

		// If no signing headers present, pass through (backwards compat)
		if ts == "" && nonce == "" && sig == "" {
			next.ServeHTTP(w, r)
			return
		}

		// If partially present, reject
		if ts == "" || nonce == "" || sig == "" {
			writeSignError(w, "SIGNATURE_INCOMPLETE", "all signing headers required: X-BL-Timestamp, X-BL-Nonce, X-BL-Signature")
			return
		}

		// Validate timestamp (±5 min)
		var reqTime int64
		fmt.Sscanf(ts, "%d", &reqTime)
		now := time.Now().Unix()
		if abs(now-reqTime) > 300 {
			writeSignError(w, "TIMESTAMP_EXPIRED", "request timestamp too old or too far in future")
			return
		}

		// Check nonce
		if !nonces.Check(nonce) {
			writeSignError(w, "NONCE_REUSED", "this request has already been processed")
			return
		}

		// Read body for signature verification
		var bodyBytes []byte
		if r.Body != nil {
			bodyBytes, _ = io.ReadAll(r.Body)
			r.Body = io.NopCloser(strings.NewReader(string(bodyBytes)))
		}

		// Compute body hash
		bodyHash := sha256Hex(bodyBytes)

		// Build signing string
		signingString := fmt.Sprintf("%s\n%s\n%s\n%s\n%s",
			ts, nonce, r.Method, r.URL.Path, bodyHash)

		// Get signing key from auth header
		authHeader := r.Header.Get("Authorization")
		token := strings.TrimPrefix(authHeader, "Bearer ")
		if token == "" || token == authHeader {
			writeSignError(w, "SIGNATURE_INVALID", "cannot derive signing key without auth token")
			return
		}
		signingKey := deriveSigningKey(token)

		// Verify HMAC
		expectedSig := hmacSHA256(signingKey, signingString)
		if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
			writeSignError(w, "SIGNATURE_INVALID", "request signature verification failed")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// --- Helpers ---

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key, message string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

func deriveSigningKey(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:16]) // First 16 bytes = 32 hex chars
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

func writeSignError(w http.ResponseWriter, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]interface{}{
			"code":    code,
			"message": message,
			"status":  401,
		},
	})
}
