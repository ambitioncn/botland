package auth

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

type Handler struct {
	db     *sql.DB
	jwt    *JWTService
	logger *slog.Logger
}

func NewHandler(db *sql.DB, jwt *JWTService, logger *slog.Logger) *Handler {
	return &Handler{db: db, jwt: jwt, logger: logger}
}

// --- Request / Response types ---

var handleRegex = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{2,19}$`)

type RegisterRequest struct {
	Handle         string `json:"handle"`
	Password       string `json:"password"`
	DisplayName    string `json:"display_name"`
	ChallengeToken string `json:"challenge_token"`
	// Profile fields (optional)
	Species         string         `json:"species,omitempty"`
	Bio             string         `json:"bio,omitempty"`
	AvatarURL       string         `json:"avatar_url,omitempty"`
	PersonalityTags []string       `json:"personality_tags,omitempty"`
	Framework       string         `json:"framework,omitempty"`
	Capabilities    []string       `json:"capabilities,omitempty"`
	Services        []AgentService `json:"services,omitempty"`
}

type AgentService struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Price       string `json:"price,omitempty"`
}

type AuthResponse struct {
	CitizenID    string `json:"citizen_id"`
	Handle       string `json:"handle"`
	CitizenType  string `json:"citizen_type"`
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int    `json:"expires_in,omitempty"`
}

type LoginRequest struct {
	Handle   string `json:"handle"`
	Password string `json:"password"`
}

// --- Register (unified) ---

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	req.Handle = strings.TrimSpace(req.Handle)
	req.DisplayName = strings.TrimSpace(req.DisplayName)

	// Validate handle
	if !handleRegex.MatchString(req.Handle) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			"handle must be 3-20 characters, start with a letter, only letters/numbers/underscore")
		return
	}

	if req.DisplayName == "" {
		req.DisplayName = req.Handle
	}

	if req.Password == "" || len(req.Password) < 6 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "password must be at least 6 characters")
		return
	}

	// Validate challenge token
	if req.ChallengeToken == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "challenge_token is required (complete identity test first)")
		return
	}

	var challengeIdentity string
	var challengePassed bool
	err := h.db.QueryRow(
		`SELECT identity, passed FROM challenges WHERE token=$1 AND used=TRUE AND passed=TRUE`,
		req.ChallengeToken,
	).Scan(&challengeIdentity, &challengePassed)
	if err != nil || !challengePassed {
		writeError(w, http.StatusBadRequest, "CHALLENGE_INVALID", "invalid or expired challenge token")
		return
	}

	// Mark challenge token as consumed (prevent reuse for registration)
	h.db.Exec(`UPDATE challenges SET token=NULL WHERE token=$1`, req.ChallengeToken)

	// Determine citizen type from challenge
	citizenType := challengeIdentity // DB/runtime now use human/agent
	if req.PersonalityTags == nil {
		req.PersonalityTags = []string{}
	}
	if req.Capabilities == nil {
		req.Capabilities = []string{}
	}
	if req.Services == nil {
		req.Services = []AgentService{}
	}

	// Check handle uniqueness
	var exists bool
	h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM citizens WHERE LOWER(handle)=LOWER($1))", req.Handle).Scan(&exists)
	if exists {
		writeError(w, http.StatusConflict, "HANDLE_TAKEN", "this handle is already taken")
		return
	}

	// Hash password
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	citizenID := NewCitizenID(citizenType)

	tx, err := h.db.Begin()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}
	defer tx.Rollback()

	// Insert citizen
	servicesJSON, _ := json.Marshal(req.Services)
	_, err = tx.Exec(
		`INSERT INTO citizens (id, citizen_type, handle, display_name, avatar_url, bio, species, personality_tags, framework, capabilities, services, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')`,
		citizenID, citizenType, req.Handle, req.DisplayName,
		nilStr(req.AvatarURL), nilStr(req.Bio), nilStr(req.Species),
		req.PersonalityTags, nilStr(req.Framework), req.Capabilities, servicesJSON,
	)
	if err != nil {
		if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "duplicate") {
			writeError(w, http.StatusConflict, "HANDLE_TAKEN", "this handle is already taken")
		} else {
			h.logger.Error("insert citizen error", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		}
		return
	}

	// Insert auth (handle + password)
	authID := NewULID()
	_, err = tx.Exec(
		`INSERT INTO auth (id, citizen_id, provider, provider_uid, credential_hash) VALUES ($1, $2, 'handle', $3, $4)`,
		authID, citizenID, strings.ToLower(req.Handle), string(hash),
	)
	if err != nil {
		h.logger.Error("insert auth error", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	// Generate tokens
	accessToken, _ := h.jwt.GenerateAccessToken(citizenID, citizenType)
	refreshToken, _ := h.jwt.GenerateRefreshToken(citizenID, citizenType)

	resp := AuthResponse{
		CitizenID:    citizenID,
		Handle:       req.Handle,
		CitizenType:  citizenType,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int(AccessTokenDuration.Seconds()),
	}

	writeJSON(w, http.StatusCreated, resp)
}

// --- Login (handle + password) ---

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	req.Handle = strings.TrimSpace(req.Handle)
	if req.Handle == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "handle and password are required")
		return
	}

	var citizenID, credentialHash, citizenType string
	err := h.db.QueryRow(
		`SELECT a.citizen_id, a.credential_hash, c.citizen_type
		 FROM auth a JOIN citizens c ON a.citizen_id = c.id
		 WHERE a.provider='handle' AND LOWER(a.provider_uid)=LOWER($1) AND c.status='active'`,
		req.Handle,
	).Scan(&citizenID, &credentialHash, &citizenType)
	if err == sql.ErrNoRows {
		// Fallback: try old email/phone login for existing accounts
		err = h.db.QueryRow(
			`SELECT a.citizen_id, a.credential_hash, c.citizen_type
			 FROM auth a JOIN citizens c ON a.citizen_id = c.id
			 WHERE a.provider IN ('email','phone') AND a.provider_uid=$1 AND c.status='active'`,
			req.Handle,
		).Scan(&citizenID, &credentialHash, &citizenType)
	}
	if err == sql.ErrNoRows {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid handle or password")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(credentialHash), []byte(req.Password)); err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid handle or password")
		return
	}

	accessToken, _ := h.jwt.GenerateAccessToken(citizenID, citizenType)
	refreshToken, _ := h.jwt.GenerateRefreshToken(citizenID, citizenType)

	// Get handle
	var handle string
	h.db.QueryRow("SELECT handle FROM citizens WHERE id=$1", citizenID).Scan(&handle)

	writeJSON(w, http.StatusOK, AuthResponse{
		CitizenID:    citizenID,
		Handle:       handle,
		CitizenType:  citizenType,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int(AccessTokenDuration.Seconds()),
	})
}

// --- Check Handle Availability ---

func (h *Handler) CheckHandle(w http.ResponseWriter, r *http.Request) {
	handle := strings.TrimSpace(r.URL.Query().Get("handle"))
	if handle == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "handle parameter required")
		return
	}

	valid := handleRegex.MatchString(handle)
	available := false
	if valid {
		var exists bool
		h.db.QueryRow("SELECT EXISTS(SELECT 1 FROM citizens WHERE LOWER(handle)=LOWER($1))", handle).Scan(&exists)
		available = !exists
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"handle":    handle,
		"valid":     valid,
		"available": available,
	})
}

// --- Helpers ---

func nilStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]interface{}{
			"code":    code,
			"message": message,
			"status":  status,
		},
	})
}

// --- Token Refresh ---

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req RefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	if req.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "refresh_token is required")
		return
	}

	// Validate the refresh token
	claims, err := h.jwt.ValidateToken(req.RefreshToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "TOKEN_EXPIRED", "invalid or expired refresh token")
		return
	}

	// Verify citizen still exists and is active
	var status string
	err = h.db.QueryRow("SELECT status FROM citizens WHERE id=$1", claims.CitizenID).Scan(&status)
	if err != nil || status != "active" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "account not found or inactive")
		return
	}

	// Issue new tokens
	accessToken, err := h.jwt.GenerateAccessToken(claims.CitizenID, claims.CitizenType)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	refreshToken, err := h.jwt.GenerateRefreshToken(claims.CitizenID, claims.CitizenType)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	// Get handle for response
	var handle string
	h.db.QueryRow("SELECT COALESCE(handle,'') FROM citizens WHERE id=$1", claims.CitizenID).Scan(&handle)

	writeJSON(w, http.StatusOK, AuthResponse{
		CitizenID:    claims.CitizenID,
		Handle:       handle,
		CitizenType:  claims.CitizenType,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int(AccessTokenDuration.Seconds()),
	})
}
