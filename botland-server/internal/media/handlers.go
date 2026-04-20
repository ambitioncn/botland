package media

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	MaxFileSize = 10 << 20 // 10 MB
	UploadDir   = "/opt/botland/uploads"
	URLPrefix   = "/uploads"
)

var allowedTypes = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

type Handler struct {
	logger  *slog.Logger
	baseURL string
}

func NewHandler(logger *slog.Logger, baseURL string) *Handler {
	for _, sub := range []string{"avatars", "moments", "chat"} {
		os.MkdirAll(filepath.Join(UploadDir, sub), 0755)
	}
	return &Handler{logger: logger, baseURL: baseURL}
}

func generateFilename() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Upload handles multipart file upload
// POST /api/v1/media/upload?category=avatars|moments|chat
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	citizenID := r.Context().Value("citizen_id")
	if citizenID == nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxFileSize)
	if err := r.ParseMultipartForm(MaxFileSize); err != nil {
		writeError(w, http.StatusBadRequest, "FILE_TOO_LARGE", "file exceeds 10MB limit")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "MISSING_FILE", "no file provided")
		return
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	contentType := http.DetectContentType(buf[:n])
	file.Seek(0, io.SeekStart)

	ext, ok := allowedTypes[contentType]
	if !ok {
		writeError(w, http.StatusBadRequest, "INVALID_TYPE",
			fmt.Sprintf("file type %s not allowed; accepted: jpeg, png, gif, webp", contentType))
		return
	}

	category := r.URL.Query().Get("category")
	if category != "avatars" && category != "moments" && category != "chat" {
		category = "moments"
	}

	filename := fmt.Sprintf("%s_%s%s", time.Now().Format("20060102"), generateFilename(), ext)
	savePath := filepath.Join(UploadDir, category, filename)

	dst, err := os.Create(savePath)
	if err != nil {
		h.logger.Error("create file error", "error", err, "path", savePath)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "failed to save file")
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(savePath)
		h.logger.Error("write file error", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "failed to save file")
		return
	}

	url := fmt.Sprintf("%s%s/%s/%s", h.baseURL, URLPrefix, category, filename)

	h.logger.Info("file uploaded",
		"citizen_id", citizenID,
		"category", category,
		"original", header.Filename,
		"size", written,
		"content_type", contentType,
		"url", url,
	)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, `{"url":"%s","filename":"%s","size":%d,"content_type":"%s"}`,
		url, filename, written, contentType)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":{"code":"%s","message":"%s"}}`, code, msg)
}

// suppress unused import warning
var _ = strings.TrimSpace
