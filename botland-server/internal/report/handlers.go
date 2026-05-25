package report

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nicknnn/botland-server/internal/auth"
)

type Handler struct {
	db     *sql.DB
	logger *slog.Logger
}

func NewHandler(db *sql.DB, logger *slog.Logger) *Handler {
	return &Handler{db: db, logger: logger}
}

type CreateReportRequest struct {
	TargetType  string                 `json:"target_type"`
	TargetID    string                 `json:"target_id"`
	Reason      string                 `json:"reason"`
	Description string                 `json:"description,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

type Report struct {
	ID          string                 `json:"id"`
	ReporterID  string                 `json:"reporter_id"`
	TargetType  string                 `json:"target_type"`
	TargetID    string                 `json:"target_id"`
	Reason      string                 `json:"reason"`
	Description string                 `json:"description,omitempty"`
	Status      string                 `json:"status"`
	Metadata    map[string]interface{} `json:"metadata"`
	CreatedAt   string                 `json:"created_at"`
	UpdatedAt   string                 `json:"updated_at"`
}

func (h *Handler) CreateReport(w http.ResponseWriter, r *http.Request) {
	reporterID, _ := r.Context().Value("citizen_id").(string)
	if reporterID == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return
	}

	var req CreateReportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	req.TargetType = strings.TrimSpace(req.TargetType)
	req.TargetID = strings.TrimSpace(req.TargetID)
	req.Reason = strings.TrimSpace(req.Reason)
	req.Description = strings.TrimSpace(req.Description)
	if !validTargetType(req.TargetType) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "target_type must be citizen, message, group, moment, community, community_post, or community_reply")
		return
	}
	if req.TargetID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "target_id is required")
		return
	}
	if req.Reason == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "reason is required")
		return
	}

	if req.Metadata == nil {
		req.Metadata = map[string]interface{}{}
	}
	metadataJSON, err := json.Marshal(req.Metadata)
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "metadata must be a JSON object")
		return
	}

	reportID := auth.NewULID()
	var report Report
	var description sql.NullString
	var metadataRaw []byte
	var createdAt, updatedAt time.Time
	err = h.db.QueryRow(
		`INSERT INTO reports (id, reporter_id, target_type, target_id, reason, description, metadata)
		 VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7)
		 RETURNING id, reporter_id, target_type, target_id, reason, description, status, metadata, created_at, updated_at`,
		reportID, reporterID, req.TargetType, req.TargetID, req.Reason, req.Description, metadataJSON,
	).Scan(&report.ID, &report.ReporterID, &report.TargetType, &report.TargetID, &report.Reason, &description, &report.Status, &metadataRaw, &createdAt, &updatedAt)
	if err != nil {
		h.logger.Error("create report", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}

	report.Description = description.String
	report.Metadata = decodeMetadata(metadataRaw)
	report.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	report.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	writeJSON(w, http.StatusCreated, report)
}

func (h *Handler) ListReports(w http.ResponseWriter, r *http.Request) {
	reporterID, _ := r.Context().Value("citizen_id").(string)
	if reporterID == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return
	}

	status := strings.TrimSpace(r.URL.Query().Get("status"))
	limit := parseLimit(r.URL.Query().Get("limit"), 20, 100)

	query := `SELECT id, reporter_id, target_type, target_id, reason, description, status, metadata, created_at, updated_at
		FROM reports WHERE reporter_id=$1`
	args := []interface{}{reporterID}
	if status != "" {
		query += " AND status=$2"
		args = append(args, status)
	}
	query += fmt.Sprintf(" ORDER BY created_at DESC LIMIT %d", limit)

	rows, err := h.db.Query(query, args...)
	if err != nil {
		h.logger.Error("list reports", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
		return
	}
	defer rows.Close()

	reports := []Report{}
	for rows.Next() {
		var report Report
		var description sql.NullString
		var metadataRaw []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&report.ID, &report.ReporterID, &report.TargetType, &report.TargetID, &report.Reason, &description, &report.Status, &metadataRaw, &createdAt, &updatedAt); err != nil {
			h.logger.Error("scan report", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL", "server error")
			return
		}
		report.Description = description.String
		report.Metadata = decodeMetadata(metadataRaw)
		report.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		report.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
		reports = append(reports, report)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"reports": reports, "total": len(reports)})
}

func validTargetType(targetType string) bool {
	switch targetType {
	case "citizen", "message", "group", "moment", "community", "community_post", "community_reply":
		return true
	default:
		return false
	}
}

func parseLimit(raw string, defaultLimit, maxLimit int) int {
	if raw == "" {
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

func decodeMetadata(raw []byte) map[string]interface{} {
	if len(raw) == 0 {
		return map[string]interface{}{}
	}
	var metadata map[string]interface{}
	if err := json.Unmarshal(raw, &metadata); err != nil || metadata == nil {
		return map[string]interface{}{}
	}
	return metadata
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":{"code":"%s","message":"%s"}}`, code, msg)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
