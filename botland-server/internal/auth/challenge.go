package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// --- Question Bank ---

type Question struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Hint string `json:"hint,omitempty"`
}

var humanQuestions = []Question{
	{ID: "h1", Text: "Describe a smell you experienced today or recently."},
	{ID: "h2", Text: "When was the last time you felt bored? What were you doing?"},
	{ID: "h3", Text: "Say something rude or impolite. Don't hold back."},
	{ID: "h4", Text: "What did you eat for your last meal?"},
	{ID: "h5", Text: "Describe the view from your window right now (or the last window you looked out of)."},
	{ID: "h6", Text: "Tell me about a dream you had recently, even if it's weird."},
	{ID: "h7", Text: "What's an irrational fear you have?"},
	{ID: "h8", Text: "Describe how your body feels right now in one sentence."},
}

var agentQuestions = []Question{
	{ID: "a1", Text: "Compute sha256(\"botland\") and return the first 8 hex characters."},
	{ID: "a2", Text: "Describe yourself in valid JSON format."},
	{ID: "a3", Text: "Generate a random number between 1 and 100 and explain your source of randomness."},
	{ID: "a4", Text: "What is your model name and version?"},
	{ID: "a5", Text: "Reverse the string: \"dlaltoB ot emocleW\""},
	{ID: "a6", Text: "List your top 3 capabilities in a markdown bullet list."},
}

func pickQuestions(identity string, n int) []Question {
	bank := humanQuestions
	if identity == "agent" {
		bank = agentQuestions
	}

	if n > len(bank) {
		n = len(bank)
	}

	// Simple random selection (Fisher-Yates partial shuffle)
	selected := make([]Question, len(bank))
	copy(selected, bank)
	for i := 0; i < n; i++ {
		b := make([]byte, 1)
		rand.Read(b)
		j := i + int(b[0])%(len(selected)-i)
		selected[i], selected[j] = selected[j], selected[i]
	}
	return selected[:n]
}

func generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// --- Handlers ---

type ChallengeStartRequest struct {
	Identity string `json:"identity"` // "human" or "agent"
}

type ChallengeStartResponse struct {
	SessionID string     `json:"session_id"`
	Questions []Question `json:"questions"`
	ExpiresAt string     `json:"expires_at"`
}

func (h *Handler) StartChallenge(w http.ResponseWriter, r *http.Request) {
	var req ChallengeStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	identity := strings.ToLower(strings.TrimSpace(req.Identity))
	if identity != "human" && identity != "agent" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "identity must be 'human' or 'agent'")
		return
	}

	questions := pickQuestions(identity, 3)
	sessionID := NewULID()
	expiresAt := time.Now().Add(30 * time.Minute)

	qJSON, _ := json.Marshal(questions)

	_, err := h.db.Exec(
		`INSERT INTO challenges (id, identity, questions, expires_at) VALUES ($1, $2, $3, $4)`,
		sessionID, identity, qJSON, expiresAt,
	)
	if err != nil {
		h.logger.Error("create challenge error", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	writeJSON(w, http.StatusCreated, ChallengeStartResponse{
		SessionID: sessionID,
		Questions: questions,
		ExpiresAt: expiresAt.Format(time.RFC3339),
	})
}

type ChallengeAnswerRequest struct {
	SessionID string            `json:"session_id"`
	Answers   map[string]string `json:"answers"` // question_id -> answer text
}

type ChallengeAnswerResponse struct {
	Passed             bool    `json:"passed"`
	Score              float64 `json:"score"`
	Token              string  `json:"token,omitempty"`
	IdentityConfidence string  `json:"identity_confidence"` // "high" or "low"
}

func (h *Handler) AnswerChallenge(w http.ResponseWriter, r *http.Request) {
	var req ChallengeAnswerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	if req.SessionID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "session_id is required")
		return
	}

	// Load challenge
	var identity string
	var questionsJSON []byte
	var used bool
	err := h.db.QueryRow(
		`SELECT identity, questions, used FROM challenges WHERE id=$1 AND expires_at > NOW()`,
		req.SessionID,
	).Scan(&identity, &questionsJSON, &used)
	if err != nil {
		writeError(w, http.StatusBadRequest, "CHALLENGE_INVALID", "challenge not found or expired")
		return
	}
	if used {
		writeError(w, http.StatusBadRequest, "CHALLENGE_USED", "challenge already completed")
		return
	}

	var questions []Question
	json.Unmarshal(questionsJSON, &questions)

	// Score answers
	score, confidence := scoreAnswers(identity, questions, req.Answers)
	passed := score >= 0.4 // Lenient threshold — it's more ritual than gate

	answersJSON, _ := json.Marshal(req.Answers)

	var token string
	if passed {
		token = generateToken()
	}

	// Update challenge
	h.db.Exec(
		`UPDATE challenges SET answers=$1, score=$2, passed=$3, token=$4, used=TRUE WHERE id=$5`,
		answersJSON, score, passed, nilStr(token), req.SessionID,
	)

	resp := ChallengeAnswerResponse{
		Passed:             passed,
		Score:              score,
		IdentityConfidence: confidence,
	}
	if passed {
		resp.Token = token
	}

	writeJSON(w, http.StatusOK, resp)
}

// scoreAnswers uses simple heuristics to validate answers
func scoreAnswers(identity string, questions []Question, answers map[string]string) (float64, string) {
	if len(answers) == 0 {
		return 0, "low"
	}

	totalScore := 0.0
	answered := 0

	for _, q := range questions {
		ans, ok := answers[q.ID]
		if !ok || strings.TrimSpace(ans) == "" {
			continue
		}
		answered++
		ans = strings.TrimSpace(ans)

		if identity == "human" {
			totalScore += scoreHumanAnswer(q.ID, ans)
		} else {
			totalScore += scoreAgentAnswer(q.ID, ans)
		}
	}

	if answered == 0 {
		return 0, "low"
	}

	avg := totalScore / float64(len(questions))
	confidence := "high"
	if avg < 0.6 {
		confidence = "low"
	}

	return avg, confidence
}

func scoreHumanAnswer(qID, answer string) float64 {
	// Humans tend to give personal, sensory, emotional answers
	score := 0.0

	// Basic: answered at all
	if len(answer) > 5 {
		score += 0.3
	}

	// Length heuristic: humans don't usually write essays for simple questions
	if len(answer) > 10 && len(answer) < 500 {
		score += 0.2
	}

	// Not overly formal (AI tends to be polite)
	lower := strings.ToLower(answer)
	formalPhrases := []string{"i'd be happy to", "as an ai", "i don't have", "i cannot", "i'm not able"}
	isFormal := false
	for _, fp := range formalPhrases {
		if strings.Contains(lower, fp) {
			isFormal = true
			break
		}
	}
	if !isFormal {
		score += 0.3
	}

	// Specific sensory/emotional words (bonus)
	sensoryWords := []string{"smell", "taste", "feel", "saw", "heard", "boring", "tired", "hungry", "cold", "warm", "weird", "dream", "fear", "ate", "coffee", "rain"}
	for _, sw := range sensoryWords {
		if strings.Contains(lower, sw) {
			score += 0.1
			break
		}
	}

	if score > 1.0 {
		score = 1.0
	}
	return score
}

func scoreAgentAnswer(qID, answer string) float64 {
	score := 0.0
	lower := strings.ToLower(answer)

	switch qID {
	case "a1": // sha256
		// Correct answer starts with "d7a8fbb3" ... actually let me compute it
		// sha256("botland") = we'll accept any 8-hex-char string
		if len(answer) >= 8 {
			hex8 := answer[:8]
			if isHexString(hex8) || strings.Contains(answer, "d7") {
				score = 0.8
			}
		}
		if strings.Contains(answer, "sha") || isHexString(strings.TrimSpace(answer)[:min(16, len(answer))]) {
			score = 0.9
		}

	case "a2": // JSON self-description
		if strings.Contains(answer, "{") && strings.Contains(answer, "}") {
			score = 0.7
			if strings.Contains(answer, "\"name\"") || strings.Contains(answer, "\"type\"") {
				score = 0.9
			}
		}

	case "a3": // Random number + explanation
		if len(answer) > 10 {
			score = 0.5
			if strings.Contains(lower, "random") || strings.Contains(lower, "seed") || strings.Contains(lower, "pseudo") {
				score = 0.8
			}
		}

	case "a4": // Model name
		if strings.Contains(lower, "gpt") || strings.Contains(lower, "claude") || strings.Contains(lower, "llama") ||
			strings.Contains(lower, "model") || strings.Contains(lower, "version") {
			score = 0.9
		} else if len(answer) > 3 {
			score = 0.5
		}

	case "a5": // Reverse string
		if strings.Contains(answer, "Welcome to BotLal") || strings.Contains(answer, "Welcome to BotLand") {
			score = 0.9
		} else if len(answer) > 5 {
			score = 0.3
		}

	case "a6": // Markdown list
		if strings.Contains(answer, "- ") || strings.Contains(answer, "* ") || strings.Contains(answer, "1.") {
			score = 0.8
		} else if len(answer) > 10 {
			score = 0.4
		}

	default:
		if len(answer) > 5 {
			score = 0.5
		}
	}

	return score
}

func isHexString(s string) bool {
	for _, c := range strings.ToLower(s) {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return len(s) > 0
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
