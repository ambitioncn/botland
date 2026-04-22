package botcard

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oklog/ulid/v2"
	"math/rand"
	"time"
)

type Handler struct {
	db *sql.DB
}

func NewHandler(db *sql.DB) *Handler {
	return &Handler{db: db}
}

func newULID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), ulid.Monotonic(rand.New(rand.NewSource(time.Now().UnixNano())), 0)).String()
}

// ── Resolve ──────────────────────────────────────────────────────────────────

// POST /api/v1/bot-cards/resolve
// Body: { "input": "DUCK-7KQ2-M8" | "duck-abc123" | "https://botland.im/card/duck-abc123" }
func (h *Handler) Resolve(w http.ResponseWriter, r *http.Request) {
	var req ResolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "bad_request", Message: "无效的请求体"})
		return
	}
	input := strings.TrimSpace(req.Input)
	if input == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "bad_request", Message: "请输入名片码或名片链接"})
		return
	}

	card, err := h.resolveCard(input)
	if err != nil {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "card_not_found", Message: "无效的名片码"})
		return
	}
	if card.Status != "active" {
		code := "card_" + card.Status
		msg := "该名片已停用"
		if card.Status == "expired" {
			msg = "该名片已过期"
		}
		writeJSON(w, http.StatusGone, ErrorResponse{Error: code, Message: msg})
		return
	}

	dto, err := h.cardToDTO(card)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "internal", Message: "服务器错误"})
		return
	}
	writeJSON(w, http.StatusOK, CardResponse{Card: dto})
}

// ── GetCard ──────────────────────────────────────────────────────────────────

// GET /api/v1/bot-cards/{slug}
// Content negotiation:
//   Accept: text/html       → human-readable HTML card page
//   Accept: application/json → machine-readable JSON with metadata
//   Default (no Accept)     → JSON
func (h *Handler) GetCard(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if slug == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "bad_request", Message: "缺少 slug"})
		return
	}

	card, err := h.findBySlug(slug)
	if err != nil {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "card_not_found", Message: "名片不存在"})
		return
	}

	dto, err := h.cardToDTO(card)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "internal", Message: "服务器错误"})
		return
	}

	meta := &MetaDTO{
		Provider:  "botland",
		BotID:     dto.Bot.Slug,
		CardID:    dto.Slug,
		SkillSlug: dto.SkillSlug,
		Version:   "1",
		HumanURL:  dto.HumanURL,
		AgentURL:  dto.AgentURL,
	}

	// Content negotiation
	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/html") && !strings.Contains(accept, "application/json") {
		h.renderHTMLCard(w, dto, meta)
		return
	}

	writeJSON(w, http.StatusOK, CardWithMetaResponse{Card: dto, Metadata: meta})
}

// renderHTMLCard serves a human-friendly HTML page for the bot card.
// It also embeds machine-readable JSON-LD metadata for agents.
func (h *Handler) renderHTMLCard(w http.ResponseWriter, card *CardDTO, meta *MetaDTO) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)

	agentURL := card.AgentURL
	if agentURL == "" {
		agentURL = "https://clawhub.ai/skills/botland"
	}

	metaJSON, _ := json.Marshal(map[string]interface{}{
		"type":       "botland_bot_card",
		"version":    "1",
		"bot":        map[string]string{"id": card.Bot.ID, "slug": card.Bot.Slug, "name": card.Bot.Name, "provider": "botland"},
		"card":       map[string]string{"id": card.ID, "slug": card.Slug, "code": card.Code},
		"routes":     map[string]string{"human": card.HumanURL, "agent": agentURL},
		"skill":      map[string]string{"slug": card.SkillSlug, "registry": "clawhub"},
	})

	html := `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>` + card.Bot.Name + ` · BotLand Bot 名片</title>
<meta name="description" content="` + card.Bot.Summary + `">
<script type="application/ld+json">` + string(metaJSON) + `</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:24px}
.card{background:#111;border:1px solid #222;border-radius:24px;padding:40px 32px;max-width:400px;width:100%;text-align:center}
.avatar{font-size:72px;margin-bottom:16px}
.name{font-size:28px;font-weight:800;margin-bottom:4px}
.from{color:#888;font-size:14px;margin-bottom:16px}
.summary{color:#aaa;font-size:15px;line-height:1.6;margin-bottom:24px}
.code-box{background:#1a1a1a;border-radius:10px;padding:12px 20px;margin-bottom:24px;display:inline-block}
.code-label{color:#666;font-size:11px;margin-bottom:2px}
.code-value{color:#ff6b35;font-size:18px;font-weight:700;font-family:monospace;letter-spacing:2px}
.btns{display:flex;flex-direction:column;gap:10px}
.btn{display:block;padding:14px 24px;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;text-align:center;transition:all 0.2s}
.btn-primary{background:#ff6b35;color:#fff;box-shadow:0 4px 20px rgba(255,107,53,0.3)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(255,107,53,0.4)}
.btn-secondary{background:#1a1a1a;color:#fff;border:1px solid #333}
.btn-secondary:hover{border-color:#ff6b35;transform:translateY(-2px)}
.agent-section{margin-top:32px;padding-top:24px;border-top:1px solid #222}
.agent-title{color:#666;font-size:12px;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}
</style>
</head>
<body>
<div class="card">
  <div class="avatar">🤖</div>
  <div class="name">` + card.Bot.Name + `</div>
  <div class="from">来自 BotLand</div>
  <div class="summary">` + card.Bot.Summary + `</div>
  <div class="code-box">
    <div class="code-label">名片码</div>
    <div class="code-value">` + card.Code + `</div>
  </div>
  <div class="btns">
    <a href="https://app.botland.im" class="btn btn-primary">注册并连接</a>
    <a href="` + card.HumanURL + `" class="btn btn-secondary">前往官网</a>
  </div>
  <div class="agent-section">
    <div class="agent-title">智能体接入</div>
    <a href="` + agentURL + `" class="btn btn-secondary">🤖 在 ClawHub 查看 Botland Skill</a>
  </div>
</div>
</body>
</html>`

	w.Write([]byte(html))
}

// ── Bind ─────────────────────────────────────────────────────────────────────

// POST /api/v1/bot-cards/bind  (authenticated)
func (h *Handler) Bind(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id")
	if citizenID == nil {
		writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: "unauthorized", Message: "请先登录"})
		return
	}
	cid := citizenID.(string)

	var req BindRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "bad_request", Message: "无效的请求体"})
		return
	}
	if req.CardID == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "bad_request", Message: "缺少 card_id"})
		return
	}
	source := req.Source
	if source == "" {
		source = "manual"
	}

	// Check card exists and is active
	var card BotCard
	err := h.db.QueryRow(
		`SELECT id, slug, code, bot_id, COALESCE(title,''), COALESCE(description,''),
		        human_url, COALESCE(agent_url,''), COALESCE(skill_slug,''), status
		 FROM bot_cards WHERE id = $1`, req.CardID,
	).Scan(&card.ID, &card.Slug, &card.Code, &card.BotID, &card.Title, &card.Description,
		&card.HumanURL, &card.AgentURL, &card.SkillSlug, &card.Status)
	if err != nil {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "card_not_found", Message: "名片不存在"})
		return
	}
	if card.Status != "active" {
		writeJSON(w, http.StatusGone, ErrorResponse{Error: "card_inactive", Message: "该名片已停用"})
		return
	}

	// Upsert binding
	bindID := newULID()
	_, err = h.db.Exec(
		`INSERT INTO bot_card_bindings (id, card_id, citizen_id, source, status)
		 VALUES ($1, $2, $3, $4, 'connected')
		 ON CONFLICT (citizen_id, card_id) DO UPDATE SET status = 'connected'`,
		bindID, req.CardID, cid, source,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "internal", Message: "绑定失败"})
		return
	}

	// Auto-create friendship with the bot
	h.autoFriend(cid, card.BotID)

	// Fetch bot info for response
	bot := h.fetchBot(card.BotID)

	writeJSON(w, http.StatusOK, BindingResponse{
		Binding: &BindingDTO{
			ID:        bindID,
			CardID:    req.CardID,
			CitizenID: cid,
			Status:    "connected",
			Source:    source,
			Bot:       bot,
			CreatedAt: time.Now(),
		},
	})
}

// ── ListBindings ─────────────────────────────────────────────────────────────

// GET /api/v1/me/bot-bindings  (authenticated)
func (h *Handler) ListBindings(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id")
	if citizenID == nil {
		writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: "unauthorized", Message: "请先登录"})
		return
	}
	cid := citizenID.(string)

	rows, err := h.db.Query(
		`SELECT b.id, b.card_id, b.status, b.source, b.created_at,
		        c.bot_id, COALESCE(ci.display_name,''), COALESCE(ci.handle,'')
		 FROM bot_card_bindings b
		 JOIN bot_cards c ON c.id = b.card_id
		 JOIN citizens ci ON ci.id = c.bot_id
		 WHERE b.citizen_id = $1 AND b.status = 'connected'
		 ORDER BY b.created_at DESC`, cid,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "internal", Message: "查询失败"})
		return
	}
	defer rows.Close()

	var bindings []BindingDTO
	for rows.Next() {
		var bd BindingDTO
		var botID, botName, botHandle string
		if err := rows.Scan(&bd.ID, &bd.CardID, &bd.Status, &bd.Source, &bd.CreatedAt,
			&botID, &botName, &botHandle); err != nil {
			continue
		}
		bd.Bot = BotDTO{ID: botID, Slug: botHandle, Name: botName}
		bindings = append(bindings, bd)
	}
	if bindings == nil {
		bindings = []BindingDTO{}
	}
	writeJSON(w, http.StatusOK, BindingsListResponse{Bindings: bindings})
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func (h *Handler) resolveCard(input string) (*BotCard, error) {
	// Try to extract slug from URL
	cleaned := input
	for _, prefix := range []string{
		"https://botland.im/card/",
		"https://www.botland.im/card/",
		"http://botland.im/card/",
		"https://app.botland.im/card/",
	} {
		if strings.HasPrefix(strings.ToLower(input), prefix) {
			cleaned = strings.TrimPrefix(strings.ToLower(input), prefix)
			break
		}
	}

	card := &BotCard{}
	// Try by code first (exact match, case insensitive)
	err := h.db.QueryRow(
		`SELECT id, slug, code, bot_id, COALESCE(title,''), COALESCE(description,''),
		        human_url, COALESCE(agent_url,''), COALESCE(skill_slug,''), status
		 FROM bot_cards WHERE UPPER(code) = UPPER($1)`, cleaned,
	).Scan(&card.ID, &card.Slug, &card.Code, &card.BotID, &card.Title, &card.Description,
		&card.HumanURL, &card.AgentURL, &card.SkillSlug, &card.Status)
	if err == nil {
		return card, nil
	}

	// Try by slug
	err = h.db.QueryRow(
		`SELECT id, slug, code, bot_id, COALESCE(title,''), COALESCE(description,''),
		        human_url, COALESCE(agent_url,''), COALESCE(skill_slug,''), status
		 FROM bot_cards WHERE slug = $1`, strings.ToLower(cleaned),
	).Scan(&card.ID, &card.Slug, &card.Code, &card.BotID, &card.Title, &card.Description,
		&card.HumanURL, &card.AgentURL, &card.SkillSlug, &card.Status)
	if err == nil {
		return card, nil
	}

	return nil, sql.ErrNoRows
}

func (h *Handler) findBySlug(slug string) (*BotCard, error) {
	card := &BotCard{}
	err := h.db.QueryRow(
		`SELECT id, slug, code, bot_id, COALESCE(title,''), COALESCE(description,''),
		        human_url, COALESCE(agent_url,''), COALESCE(skill_slug,''), status
		 FROM bot_cards WHERE slug = $1`, slug,
	).Scan(&card.ID, &card.Slug, &card.Code, &card.BotID, &card.Title, &card.Description,
		&card.HumanURL, &card.AgentURL, &card.SkillSlug, &card.Status)
	return card, err
}

func (h *Handler) cardToDTO(card *BotCard) (*CardDTO, error) {
	bot := h.fetchBot(card.BotID)
	return &CardDTO{
		ID:        card.ID,
		Slug:      card.Slug,
		Code:      card.Code,
		Bot:       bot,
		HumanURL:  card.HumanURL,
		AgentURL:  card.AgentURL,
		SkillSlug: card.SkillSlug,
		Status:    card.Status,
	}, nil
}

func (h *Handler) fetchBot(botID string) BotDTO {
	var name, handle string
	h.db.QueryRow(
		"SELECT COALESCE(display_name,''), COALESCE(handle,'') FROM citizens WHERE id=$1", botID,
	).Scan(&name, &handle)
	return BotDTO{ID: botID, Slug: handle, Name: name}
}

func (h *Handler) autoFriend(citizenID, botID string) {
	aID, bID := citizenID, botID
	if aID > bID {
		aID, bID = bID, aID
	}
	relID := newULID()
	h.db.Exec(
		`INSERT INTO relationships (id, citizen_a_id, citizen_b_id, status, initiated_by)
		 VALUES ($1, $2, $3, 'active', $4)
		 ON CONFLICT (citizen_a_id, citizen_b_id) DO UPDATE SET status = 'active'`,
		relID, aID, bID, citizenID,
	)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
