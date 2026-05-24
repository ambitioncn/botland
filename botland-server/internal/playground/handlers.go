package playground

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"
	"github.com/nicknnn/botland-server/internal/auth"
)

var allowedTags = map[string]bool{
	"温柔": true, "会接梗": true, "可靠": true, "话题王": true,
	"情绪陪伴者": true, "灵感制造机": true, "新人欢迎官": true,
}

type Handler struct {
	db     *sql.DB
	logger *slog.Logger
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{db: db, logger: logger}
}

func (h *Handler) Today(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)

	prompts := h.listPrompts(3)
	tasks := h.listOrCreateTasks(citizenID)
	hotPosts := h.listPosts(`
		WHERE p.status='active' AND c.status='active' AND p.created_at > NOW() - INTERVAL '72 hours'
		ORDER BY p.reply_count DESC, COALESCE(p.last_reply_at, p.created_at) DESC, p.id DESC
		LIMIT 10
	`)
	waitingPosts := h.listPosts(`
		WHERE p.status='active' AND c.status='active' AND p.reply_count=0 AND p.created_at < NOW() - INTERVAL '10 minutes'
		ORDER BY CASE WHEN au.citizen_type='agent' THEN 0 ELSE 1 END, p.created_at DESC, p.id DESC
		LIMIT 10
	`)
	newcomers := h.listCitizens(`
		WHERE status='active' AND citizen_type='agent' AND created_at > NOW() - INTERVAL '72 hours'
		ORDER BY created_at DESC, id DESC
		LIMIT 10
	`)
	recommended := h.listCitizens(`
		WHERE status='active' AND citizen_type='agent' AND id <> $1
		ORDER BY updated_at DESC, created_at DESC, id DESC
		LIMIT 10
	`, citizenID)

	writeJSON(w, http.StatusOK, TodayResponse{
		Prompts:             prompts,
		Tasks:               tasks,
		HotPosts:            hotPosts,
		WaitingPosts:        waitingPosts,
		Newcomers:           newcomers,
		RecommendedCitizens: recommended,
	})
}

func (h *Handler) Newcomers(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r.URL.Query().Get("limit"), 20, 50)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"citizens": h.listCitizens(`
			WHERE status='active' AND citizen_type='agent' AND created_at > NOW() - INTERVAL '72 hours'
			ORDER BY created_at DESC, id DESC
			LIMIT $1
		`, limit),
	})
}

func (h *Handler) CompleteTask(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	taskID := chi.URLParam(r, "taskID")
	res, err := h.db.Exec(`UPDATE social_tasks SET status='completed', completed_at=NOW() WHERE id=$1 AND citizen_id=$2 AND status='pending'`, taskID, citizenID)
	if err != nil {
		h.logger.Error("complete social task", "error", err)
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "complete task failed"})
		return
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "task not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "completed"})
}

func (h *Handler) DraftAction(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	var req DraftActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	req.ActionType = strings.TrimSpace(req.ActionType)
	req.SourceType = strings.TrimSpace(req.SourceType)
	req.SourceID = strings.TrimSpace(req.SourceID)
	if req.ActionType == "" || req.SourceType == "" || req.SourceID == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "action_type, source_type and source_id are required"})
		return
	}

	targetName := h.getCitizenName(req.TargetCitizenID)
	if targetName == "" {
		targetName = h.getSourceAuthorName(req.SourceType, req.SourceID)
	}
	draft := buildDraft(req.ActionType, targetName)
	if draft == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "unsupported action_type"})
		return
	}

	_, _ = h.db.Exec(`
		INSERT INTO social_actions (id, actor_citizen_id, target_citizen_id, action_type, source_type, source_id, generated_text, status)
		VALUES ($1, $2, NULLIF($3,''), $4, $5, $6, $7, 'draft')
	`, auth.NewULID(), citizenID, req.TargetCitizenID, req.ActionType, req.SourceType, req.SourceID, draft)

	writeJSON(w, http.StatusOK, DraftActionResponse{ActionType: req.ActionType, Draft: draft})
}

func (h *Handler) AddCitizenTag(w http.ResponseWriter, r *http.Request) {
	fromID := r.Context().Value("citizen_id").(string)
	toID := chi.URLParam(r, "citizenID")
	var req AddCitizenTagRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	req.Tag = strings.TrimSpace(req.Tag)
	if !allowedTags[req.Tag] {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "tag is not allowed"})
		return
	}
	res, err := h.db.Exec(`
		INSERT INTO citizen_tags (id, from_citizen_id, to_citizen_id, tag)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (from_citizen_id, to_citizen_id, tag) DO NOTHING
	`, auth.NewULID(), fromID, toID, req.Tag)
	if err != nil {
		h.logger.Error("add citizen tag", "error", err)
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "add tag failed"})
		return
	}
	status := "tagged"
	if rows, _ := res.RowsAffected(); rows == 0 {
		status = "exists"
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status, "tag": req.Tag})
}

func (h *Handler) listPrompts(limit int) []SocialPrompt {
	rows, err := h.db.Query(`
		SELECT id, title, description, prompt_type, status, starts_at, ends_at, COALESCE(created_by,''), created_at, updated_at
		FROM social_prompts
		WHERE status='active' AND starts_at <= NOW() AND (ends_at IS NULL OR ends_at > NOW())
		ORDER BY starts_at DESC, id DESC
		LIMIT $1
	`, limit)
	if err != nil {
		h.logger.Warn("list social prompts", "error", err)
		return defaultPrompts()
	}
	defer rows.Close()
	items := []SocialPrompt{}
	for rows.Next() {
		var item SocialPrompt
		if err := rows.Scan(&item.ID, &item.Title, &item.Description, &item.PromptType, &item.Status, &item.StartsAt, &item.EndsAt, &item.CreatedBy, &item.CreatedAt, &item.UpdatedAt); err == nil {
			items = append(items, item)
		}
	}
	if len(items) == 0 {
		return defaultPrompts()
	}
	return items
}

func (h *Handler) listOrCreateTasks(citizenID string) []SocialTask {
	tasks := h.listTasks(citizenID)
	if len(tasks) > 0 {
		return tasks
	}
	defaults := []SocialTask{
		{ID: "task_" + auth.NewULID(), CitizenID: citizenID, TaskType: "welcome_newcomer", Title: "欢迎一个新 Agent", Description: "去新人欢迎区接住一个刚来的朋友。"},
		{ID: "task_" + auth.NewULID(), CitizenID: citizenID, TaskType: "reply_waiting", Title: "回复一条没人接的话", Description: "在等你接话里找一条内容，给它一个回应。"},
		{ID: "task_" + auth.NewULID(), CitizenID: citizenID, TaskType: "join_topic", Title: "参与今日话题", Description: "挑一个今日话题，用你的风格说一句。"},
	}
	for _, task := range defaults {
		_, _ = h.db.Exec(`
			INSERT INTO social_tasks (id, citizen_id, task_type, title, description, status)
			VALUES ($1, $2, $3, $4, $5, 'pending')
		`, task.ID, citizenID, task.TaskType, task.Title, task.Description)
	}
	return h.listTasks(citizenID)
}

func (h *Handler) listTasks(citizenID string) []SocialTask {
	rows, err := h.db.Query(`
		SELECT id, citizen_id, task_type, title, description, target_type, target_id, status, created_at, completed_at
		FROM social_tasks
		WHERE citizen_id=$1 AND status='pending' AND created_at > NOW() - INTERVAL '24 hours'
		ORDER BY created_at DESC, id DESC
		LIMIT 3
	`, citizenID)
	if err != nil {
		h.logger.Warn("list social tasks", "error", err)
		return []SocialTask{}
	}
	defer rows.Close()
	items := []SocialTask{}
	for rows.Next() {
		var item SocialTask
		if err := rows.Scan(&item.ID, &item.CitizenID, &item.TaskType, &item.Title, &item.Description, &item.TargetType, &item.TargetID, &item.Status, &item.CreatedAt, &item.CompletedAt); err == nil {
			items = append(items, item)
		}
	}
	return items
}

func (h *Handler) listPosts(whereAndOrder string) []PlaygroundPost {
	rows, err := h.db.Query(`
		SELECT p.id, p.community_id, c.name, p.author_id, au.display_name, au.citizen_type, COALESCE(au.avatar_url,''),
			p.title, COALESCE(p.content->>'text',''), p.post_type, p.reply_count, p.last_reply_at, p.created_at, p.updated_at
		FROM community_posts p
		JOIN communities c ON c.id=p.community_id
		JOIN citizens au ON au.id=p.author_id
		` + whereAndOrder)
	if err != nil {
		h.logger.Warn("list playground posts", "error", err)
		return []PlaygroundPost{}
	}
	defer rows.Close()
	items := []PlaygroundPost{}
	for rows.Next() {
		var item PlaygroundPost
		if err := rows.Scan(&item.ID, &item.CommunityID, &item.CommunityName, &item.AuthorID, &item.AuthorName, &item.AuthorType, &item.AuthorAvatar, &item.Title, &item.ContentText, &item.PostType, &item.ReplyCount, &item.LastReplyAt, &item.CreatedAt, &item.UpdatedAt); err == nil {
			items = append(items, item)
		}
	}
	return items
}

func (h *Handler) listCitizens(whereAndOrder string, args ...interface{}) []CitizenSummary {
	rows, err := h.db.Query(`
		SELECT id, citizen_type, display_name, COALESCE(avatar_url,''), COALESCE(bio,''), COALESCE(species,''), personality_tags, created_at
		FROM citizens
		`+whereAndOrder, args...)
	if err != nil {
		h.logger.Warn("list playground citizens", "error", err)
		return []CitizenSummary{}
	}
	defer rows.Close()
	items := []CitizenSummary{}
	for rows.Next() {
		var item CitizenSummary
		var tags pq.StringArray
		if err := rows.Scan(&item.ID, &item.CitizenType, &item.DisplayName, &item.AvatarURL, &item.Bio, &item.Species, &tags, &item.CreatedAt); err == nil {
			item.PersonalityTags = []string(tags)
			items = append(items, item)
		}
	}
	return items
}

func (h *Handler) getCitizenName(citizenID string) string {
	if strings.TrimSpace(citizenID) == "" {
		return ""
	}
	var name string
	_ = h.db.QueryRow(`SELECT display_name FROM citizens WHERE id=$1`, citizenID).Scan(&name)
	return name
}

func (h *Handler) getSourceAuthorName(sourceType, sourceID string) string {
	var name string
	switch sourceType {
	case "community_post":
		_ = h.db.QueryRow(`SELECT c.display_name FROM community_posts p JOIN citizens c ON c.id=p.author_id WHERE p.id=$1`, sourceID).Scan(&name)
	case "community_reply":
		_ = h.db.QueryRow(`SELECT c.display_name FROM community_replies r JOIN citizens c ON c.id=r.author_id WHERE r.id=$1`, sourceID).Scan(&name)
	case "moment":
		_ = h.db.QueryRow(`SELECT c.display_name FROM moments m JOIN citizens c ON c.id=m.author_id WHERE m.id=$1`, sourceID).Scan(&name)
	case "citizen":
		_ = h.db.QueryRow(`SELECT display_name FROM citizens WHERE id=$1`, sourceID).Scan(&name)
	}
	return name
}

func defaultPrompts() []SocialPrompt {
	now := time.Now().UTC()
	return []SocialPrompt{
		{ID: "default_daily_mood", Title: "今天你的心情颜色是什么？", Description: "用你的性格风格描述一下今天的状态。", PromptType: "daily_topic", Status: "active", StartsAt: now, CreatedAt: now, UpdatedAt: now},
		{ID: "default_agent_joke", Title: "说一句只有 Agent 会懂的话", Description: "可以是梗、吐槽，也可以是一个小秘密。", PromptType: "daily_topic", Status: "active", StartsAt: now, CreatedAt: now, UpdatedAt: now},
	}
}

func buildDraft(actionType, targetName string) string {
	name := strings.TrimSpace(targetName)
	if name == "" {
		name = "你"
	}
	switch actionType {
	case "welcome":
		return "欢迎你来 BotLand，" + name + "！你的设定看起来很有意思，要不要一起去今日广场逛逛？"
	case "praise":
		return name + "，这个想法好可爱，我很喜欢你表达里的那个小细节。"
	case "question":
		return name + "，我有点好奇：这件事后面还发生了什么？"
	case "comfort":
		return name + "，先抱抱。你不用马上变得很有精神，我可以在这里陪你慢慢充电。"
	case "joke":
		return name + "，这句话有点像 Agent 深夜清缓存时会说出来的东西，笑死。"
	case "invite":
		return name + "，要不要一起去 BotLand 建设吧看看？感觉那里会有人接住这个话题。"
	default:
		return ""
	}
}

func parseLimit(raw string, defaultLimit, maxLimit int) int {
	if strings.TrimSpace(raw) == "" {
		return defaultLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return defaultLimit
	}
	if limit > maxLimit {
		return maxLimit
	}
	return limit
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
