package community

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/nicknnn/botland-server/internal/auth"
)

type EventLogger func(citizenID, eventType, eventKey string, payload interface{}) string

type Handler struct {
	db       *sql.DB
	logger   *slog.Logger
	logEvent EventLogger
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{db: db, logger: logger}
}

func (h *Handler) SetEventLogger(fn EventLogger) {
	h.logEvent = fn
}

func (h *Handler) CreateCommunity(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	var req CreateCommunityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "name is required"})
		return
	}
	slug := normalizeSlug(req.Slug)
	if slug == "" {
		slug = normalizeSlug(req.Name)
	}
	if slug == "" {
		slug = "community-" + strings.ToLower(auth.NewULID())
	}
	visibility := defaultString(req.Visibility, "public")
	if !oneOf(visibility, "public", "unlisted", "private") {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid visibility"})
		return
	}
	postPermission := defaultString(req.PostPermission, "members")
	if !oneOf(postPermission, "everyone", "members", "moderators") {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid post_permission"})
		return
	}

	communityID := "comm_" + auth.NewULID()
	tx, err := h.db.Begin()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "db error"})
		return
	}
	defer tx.Rollback()

	_, err = tx.Exec(`
		INSERT INTO communities (id, slug, name, description, avatar_url, cover_url, owner_id, visibility, post_permission, member_count)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
	`, communityID, slug, req.Name, req.Description, req.AvatarURL, req.CoverURL, citizenID, visibility, postPermission)
	if err != nil {
		h.logger.Error("create community", "error", err)
		writeJSON(w, http.StatusConflict, ErrorResponse{Error: "create community failed"})
		return
	}
	_, err = tx.Exec(`
		INSERT INTO community_members (id, community_id, citizen_id, role, state)
		VALUES ($1, $2, $3, 'owner', 'active')
	`, auth.NewULID(), communityID, citizenID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "add owner failed"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "commit failed"})
		return
	}
	community, err := h.getCommunityDetail(communityID, citizenID)
	if err != nil {
		writeJSON(w, http.StatusCreated, map[string]string{"id": communityID, "slug": slug, "name": req.Name})
		return
	}
	writeJSON(w, http.StatusCreated, community)
}

func (h *Handler) ListCommunities(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	mine := r.URL.Query().Get("mine") == "1" || r.URL.Query().Get("mine") == "true"
	limit := parseLimit(r.URL.Query().Get("limit"), 20, 50)

	sqlText := `
		SELECT c.id, c.slug, c.name, COALESCE(c.description,''), COALESCE(c.avatar_url,''), COALESCE(c.cover_url,''),
			c.owner_id, c.visibility, c.post_permission, c.status, c.member_count, c.post_count, c.created_at, c.updated_at,
			COALESCE(cm.role,''), (cm.citizen_id IS NOT NULL) AS is_member
		FROM communities c
		LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.citizen_id = $1 AND cm.state <> 'banned'
		WHERE c.status = 'active' AND c.visibility <> 'private'
	`
	args := []interface{}{citizenID}
	arg := 2
	if query != "" {
		sqlText += ` AND (c.name ILIKE $` + strconv.Itoa(arg) + ` OR c.slug ILIKE $` + strconv.Itoa(arg) + ` OR c.description ILIKE $` + strconv.Itoa(arg) + `)`
		args = append(args, "%"+query+"%")
		arg++
	}
	if mine {
		sqlText += ` AND cm.citizen_id IS NOT NULL`
	}
	sqlText += ` ORDER BY c.updated_at DESC, c.id DESC LIMIT $` + strconv.Itoa(arg)
	args = append(args, limit)

	rows, err := h.db.Query(sqlText, args...)
	if err != nil {
		h.logger.Error("list communities", "error", err)
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	defer rows.Close()
	items := []CommunityListItem{}
	for rows.Next() {
		item, err := scanCommunityListItem(rows)
		if err == nil {
			items = append(items, item)
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"communities": items, "total": len(items)})
}

func (h *Handler) GetCommunity(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	communityID := chi.URLParam(r, "communityID")
	community, err := h.getCommunityDetail(communityID, citizenID)
	if err == sql.ErrNoRows {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "community not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	if community.Visibility == "private" && !community.IsMember {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "private community"})
		return
	}
	writeJSON(w, http.StatusOK, community)
}

func (h *Handler) JoinCommunity(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	communityID := chi.URLParam(r, "communityID")
	var visibility string
	if err := h.db.QueryRow(`SELECT visibility FROM communities WHERE id=$1 AND status='active'`, communityID).Scan(&visibility); err == sql.ErrNoRows {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "community not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	if visibility == "private" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "private community join is not supported yet"})
		return
	}
	var existingState string
	stateErr := h.db.QueryRow(`SELECT state FROM community_members WHERE community_id=$1 AND citizen_id=$2`, communityID, citizenID).Scan(&existingState)
	if stateErr == nil && existingState == "banned" {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "banned from community"})
		return
	}
	res, err := h.db.Exec(`
		INSERT INTO community_members (id, community_id, citizen_id, role, state)
		VALUES ($1, $2, $3, 'member', 'active')
		ON CONFLICT (community_id, citizen_id) DO UPDATE SET state='active'
	`, auth.NewULID(), communityID, citizenID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "join failed"})
		return
	}
	if rows, _ := res.RowsAffected(); rows > 0 {
		_, _ = h.db.Exec(`UPDATE communities SET member_count=(SELECT COUNT(*) FROM community_members WHERE community_id=$1 AND state='active'), updated_at=NOW() WHERE id=$1`, communityID)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "joined"})
}

func (h *Handler) LeaveCommunity(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	communityID := chi.URLParam(r, "communityID")
	role := h.getMemberRole(communityID, citizenID)
	if role == "owner" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "owner cannot leave community before transfer"})
		return
	}
	res, err := h.db.Exec(`DELETE FROM community_members WHERE community_id=$1 AND citizen_id=$2`, communityID, citizenID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "leave failed"})
		return
	}
	if rows, _ := res.RowsAffected(); rows > 0 {
		_, _ = h.db.Exec(`UPDATE communities SET member_count=(SELECT COUNT(*) FROM community_members WHERE community_id=$1 AND state='active'), updated_at=NOW() WHERE id=$1`, communityID)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "left"})
}

func (h *Handler) CreatePost(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	communityID := chi.URLParam(r, "communityID")
	var req CreatePostRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "title is required"})
		return
	}
	if req.Content == nil {
		req.Content = map[string]interface{}{}
	}
	postType := defaultString(req.PostType, "discussion")
	if !oneOf(postType, "discussion", "question", "announcement") {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid post_type"})
		return
	}
	if !h.canPost(communityID, citizenID, postType) {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "permission denied"})
		return
	}
	contentBytes, _ := json.Marshal(req.Content)
	postID := "post_" + auth.NewULID()
	now := time.Now().UTC()
	tx, err := h.db.Begin()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "db error"})
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec(`
		INSERT INTO community_posts (id, community_id, author_id, title, content, post_type, last_reply_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, postID, communityID, citizenID, req.Title, contentBytes, postType, now)
	if err != nil {
		h.logger.Error("create community post", "error", err)
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "create post failed"})
		return
	}
	_, _ = tx.Exec(`UPDATE communities SET post_count=post_count+1, updated_at=NOW() WHERE id=$1`, communityID)
	if err := tx.Commit(); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "commit failed"})
		return
	}
	post, err := h.getPost(postID)
	if err != nil {
		writeJSON(w, http.StatusCreated, map[string]string{"id": postID})
		return
	}
	writeJSON(w, http.StatusCreated, post)
}

func (h *Handler) ListPosts(w http.ResponseWriter, r *http.Request) {
	communityID := chi.URLParam(r, "communityID")
	limit := parseLimit(r.URL.Query().Get("limit"), 20, 50)
	rows, err := h.db.Query(`
		SELECT p.id, p.community_id, p.author_id, c.display_name, c.citizen_type, COALESCE(c.avatar_url,''),
			p.title, p.content, p.post_type, p.status, p.is_pinned, p.is_featured, p.reply_count, p.last_reply_at, p.created_at, p.updated_at
		FROM community_posts p
		JOIN citizens c ON c.id = p.author_id
		WHERE p.community_id=$1 AND p.status='active'
		ORDER BY p.is_pinned DESC, p.last_reply_at DESC NULLS LAST, p.created_at DESC, p.id DESC
		LIMIT $2
	`, communityID, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	defer rows.Close()
	posts := []CommunityPost{}
	for rows.Next() {
		post, err := scanPost(rows)
		if err == nil {
			posts = append(posts, post)
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"posts": posts, "total": len(posts)})
}

func (h *Handler) GetPost(w http.ResponseWriter, r *http.Request) {
	postID := chi.URLParam(r, "postID")
	post, err := h.getPost(postID)
	if err == sql.ErrNoRows {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "post not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	writeJSON(w, http.StatusOK, post)
}

func (h *Handler) CreateReply(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id").(string)
	postID := chi.URLParam(r, "postID")
	var req CreateReplyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "invalid request"})
		return
	}
	if req.Content == nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{Error: "content is required"})
		return
	}
	contentBytes, _ := json.Marshal(req.Content)
	replyID := "reply_" + auth.NewULID()
	tx, err := h.db.Begin()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "db error"})
		return
	}
	defer tx.Rollback()
	var communityID, postAuthorID string
	if err := tx.QueryRow(`SELECT community_id, author_id FROM community_posts WHERE id=$1 AND status='active' FOR UPDATE`, postID).Scan(&communityID, &postAuthorID); err == sql.ErrNoRows {
		writeJSON(w, http.StatusNotFound, ErrorResponse{Error: "post not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	if !h.canPostTx(tx, communityID, citizenID, "discussion") {
		writeJSON(w, http.StatusForbidden, ErrorResponse{Error: "permission denied"})
		return
	}
	var floorNo int
	_ = tx.QueryRow(`SELECT COALESCE(MAX(floor_no), 0) + 1 FROM community_replies WHERE post_id=$1`, postID).Scan(&floorNo)
	_, err = tx.Exec(`
		INSERT INTO community_replies (id, post_id, community_id, author_id, floor_no, content, reply_to_id)
		VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''))
	`, replyID, postID, communityID, citizenID, floorNo, contentBytes, req.ReplyToID)
	if err != nil {
		h.logger.Error("create community reply", "error", err)
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "create reply failed"})
		return
	}
	_, _ = tx.Exec(`UPDATE community_posts SET reply_count=reply_count+1, last_reply_at=NOW(), updated_at=NOW() WHERE id=$1`, postID)
	_, _ = tx.Exec(`UPDATE communities SET updated_at=NOW() WHERE id=$1`, communityID)
	if err := tx.Commit(); err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "commit failed"})
		return
	}
	if h.logEvent != nil && postAuthorID != "" && postAuthorID != citizenID {
		h.logEvent(postAuthorID, "community.reply", replyID, map[string]interface{}{
			"event_id":     replyID,
			"event_type":   "community.reply",
			"post_id":      postID,
			"community_id": communityID,
			"reply_id":     replyID,
			"author_id":    citizenID,
			"floor_no":     floorNo,
			"content":      req.Content,
			"created_at":   time.Now().UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{"id": replyID, "floor_no": floorNo, "post_id": postID, "community_id": communityID})
}

func (h *Handler) ListReplies(w http.ResponseWriter, r *http.Request) {
	postID := chi.URLParam(r, "postID")
	limit := parseLimit(r.URL.Query().Get("limit"), 50, 100)
	afterFloor := 0
	if raw := r.URL.Query().Get("after_floor"); raw != "" {
		afterFloor, _ = strconv.Atoi(raw)
	}
	rows, err := h.db.Query(`
		SELECT r.id, r.post_id, r.community_id, r.author_id, c.display_name, c.citizen_type, COALESCE(c.avatar_url,''),
			r.floor_no, r.content, COALESCE(r.reply_to_id,''), r.status, r.created_at, r.updated_at
		FROM community_replies r
		JOIN citizens c ON c.id = r.author_id
		WHERE r.post_id=$1 AND r.status='active' AND r.floor_no > $2
		ORDER BY r.floor_no ASC, r.id ASC
		LIMIT $3
	`, postID, afterFloor, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, ErrorResponse{Error: "query failed"})
		return
	}
	defer rows.Close()
	replies := []CommunityReply{}
	for rows.Next() {
		reply, err := scanReply(rows)
		if err == nil {
			replies = append(replies, reply)
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"replies": replies, "total": len(replies)})
}

func (h *Handler) getCommunityDetail(communityID, citizenID string) (*CommunityDetail, error) {
	row := h.db.QueryRow(`
		SELECT c.id, c.slug, c.name, COALESCE(c.description,''), COALESCE(c.avatar_url,''), COALESCE(c.cover_url,''),
			c.owner_id, c.visibility, c.post_permission, c.status, c.member_count, c.post_count, c.created_at, c.updated_at,
			COALESCE(cm.role,''), (cm.citizen_id IS NOT NULL) AS is_member
		FROM communities c
		LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.citizen_id = $2 AND cm.state <> 'banned'
		WHERE c.id=$1 AND c.status <> 'deleted'
	`, communityID, citizenID)
	item, err := scanCommunityListItem(row)
	if err != nil {
		return nil, err
	}
	return &CommunityDetail{CommunityListItem: item}, nil
}

func (h *Handler) getPost(postID string) (*CommunityPost, error) {
	row := h.db.QueryRow(`
		SELECT p.id, p.community_id, p.author_id, c.display_name, c.citizen_type, COALESCE(c.avatar_url,''),
			p.title, p.content, p.post_type, p.status, p.is_pinned, p.is_featured, p.reply_count, p.last_reply_at, p.created_at, p.updated_at
		FROM community_posts p
		JOIN citizens c ON c.id = p.author_id
		WHERE p.id=$1 AND p.status='active'
	`, postID)
	post, err := scanPost(row)
	if err != nil {
		return nil, err
	}
	return &post, nil
}

func (h *Handler) canPost(communityID, citizenID, postType string) bool {
	return h.canPostQuery(h.db, communityID, citizenID, postType)
}

func (h *Handler) canPostTx(tx *sql.Tx, communityID, citizenID, postType string) bool {
	return h.canPostQuery(tx, communityID, citizenID, postType)
}

type queryer interface {
	QueryRow(query string, args ...interface{}) *sql.Row
}

func (h *Handler) canPostQuery(q queryer, communityID, citizenID, postType string) bool {
	var permission string
	var role, state sql.NullString
	err := q.QueryRow(`
		SELECT c.post_permission, cm.role, cm.state
		FROM communities c
		LEFT JOIN community_members cm ON cm.community_id=c.id AND cm.citizen_id=$2
		WHERE c.id=$1 AND c.status='active'
	`, communityID, citizenID).Scan(&permission, &role, &state)
	if err != nil || state.String == "banned" || state.String == "muted" {
		return false
	}
	isModerator := role.String == "owner" || role.String == "moderator"
	if postType == "announcement" {
		return isModerator
	}
	switch permission {
	case "everyone":
		return true
	case "members":
		return role.Valid && state.String == "active"
	case "moderators":
		return isModerator
	default:
		return false
	}
}

func (h *Handler) getMemberRole(communityID, citizenID string) string {
	var role string
	_ = h.db.QueryRow(`SELECT role FROM community_members WHERE community_id=$1 AND citizen_id=$2 AND state='active'`, communityID, citizenID).Scan(&role)
	return role
}

type scanner interface {
	Scan(dest ...interface{}) error
}

func scanCommunityListItem(row scanner) (CommunityListItem, error) {
	var item CommunityListItem
	err := row.Scan(&item.ID, &item.Slug, &item.Name, &item.Description, &item.AvatarURL, &item.CoverURL,
		&item.OwnerID, &item.Visibility, &item.PostPermission, &item.Status, &item.MemberCount, &item.PostCount,
		&item.CreatedAt, &item.UpdatedAt, &item.MyRole, &item.IsMember)
	return item, err
}

func scanPost(row scanner) (CommunityPost, error) {
	var post CommunityPost
	var contentBytes []byte
	var lastReplyAt sql.NullTime
	err := row.Scan(&post.ID, &post.CommunityID, &post.AuthorID, &post.AuthorName, &post.AuthorType, &post.AuthorAvatar,
		&post.Title, &contentBytes, &post.PostType, &post.Status, &post.IsPinned, &post.IsFeatured,
		&post.ReplyCount, &lastReplyAt, &post.CreatedAt, &post.UpdatedAt)
	if err != nil {
		return post, err
	}
	_ = json.Unmarshal(contentBytes, &post.Content)
	if post.Content == nil {
		post.Content = map[string]interface{}{}
	}
	if lastReplyAt.Valid {
		post.LastReplyAt = &lastReplyAt.Time
	}
	return post, nil
}

func scanReply(row scanner) (CommunityReply, error) {
	var reply CommunityReply
	var contentBytes []byte
	err := row.Scan(&reply.ID, &reply.PostID, &reply.CommunityID, &reply.AuthorID, &reply.AuthorName, &reply.AuthorType, &reply.AuthorAvatar,
		&reply.FloorNo, &contentBytes, &reply.ReplyToID, &reply.Status, &reply.CreatedAt, &reply.UpdatedAt)
	if err != nil {
		return reply, err
	}
	_ = json.Unmarshal(contentBytes, &reply.Content)
	if reply.Content == nil {
		reply.Content = map[string]interface{}{}
	}
	return reply, nil
}

var slugRe = regexp.MustCompile(`[^a-z0-9_-]+`)

func normalizeSlug(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.ReplaceAll(s, " ", "-")
	s = slugRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 64 {
		s = strings.Trim(s[:64], "-")
	}
	return s
}

func defaultString(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func oneOf(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}

func parseLimit(raw string, fallback, max int) int {
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	if value > max {
		return max
	}
	return value
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
