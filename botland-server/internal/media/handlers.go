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
	MaxImageSize = 10 << 20  // 10 MB for images
	MaxVideoSize = 50 << 20  // 50 MB for videos
	MaxAudioSize = 25 << 20  // 25 MB for audio
	MaxFileSize  = 50 << 20  // 50 MB overall limit
	UploadDir    = "/opt/botland/uploads"
	URLPrefix    = "/uploads"
)

var allowedImageTypes = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

var allowedVideoTypes = map[string]string{
	"video/mp4":       ".mp4",
	"video/quicktime": ".mov",
	"video/webm":      ".webm",
}

var allowedAudioTypes = map[string]string{
	"audio/mpeg":    ".mp3",
	"audio/mp4":     ".m4a",
	"audio/x-m4a":   ".m4a",
	"audio/aac":     ".aac",
	"audio/ogg":     ".ogg",
	"audio/webm":    ".webm",
	"audio/wav":     ".wav",
	"audio/x-wav":   ".wav",
}

type Handler struct {
	logger  *slog.Logger
	baseURL string
}

func NewHandler(logger *slog.Logger, baseURL string) *Handler {
	for _, sub := range []string{"avatars", "moments", "chat", "video", "audio"} {
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

	ext, ok := allowedImageTypes[contentType]
	isVideo := false
	isAudio := false
	if !ok {
		ext, ok = allowedVideoTypes[contentType]
		isVideo = true
	}
	if !ok {
		ext, ok = allowedAudioTypes[contentType]
		isAudio = true
		isVideo = false
	}
	if !ok {
		writeError(w, http.StatusBadRequest, "INVALID_TYPE",
			fmt.Sprintf("file type %s not allowed; accepted: jpeg, png, gif, webp, mp4, mov, webm, mp3, m4a, aac, ogg, wav", contentType))
		return
	}

	// Enforce size limits per type
	if isAudio && header.Size > MaxAudioSize {
		writeError(w, http.StatusBadRequest, "FILE_TOO_LARGE", "audio exceeds 25MB limit")
		return
	}
	if isVideo && header.Size > MaxVideoSize {
		writeError(w, http.StatusBadRequest, "FILE_TOO_LARGE", "video exceeds 50MB limit")
		return
	}
	if !isVideo && !isAudio && header.Size > MaxImageSize {
		writeError(w, http.StatusBadRequest, "FILE_TOO_LARGE", "image exceeds 10MB limit")
		return
	}

	category := r.URL.Query().Get("category")
	if category != "avatars" && category != "moments" && category != "chat" && category != "video" && category != "audio" {
		if isAudio {
			category = "audio"
		} else if isVideo {
			category = "video"
		} else {
			category = "moments"
		}
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
	mediaType := "image"
	if isAudio {
		mediaType = "audio"
	} else if isVideo {
		mediaType = "video"
	}
	fmt.Fprintf(w, `{"url":"%s","filename":"%s","size":%d,"content_type":"%s","media_type":"%s"}`,
		url, filename, written, contentType, mediaType)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":{"code":"%s","message":"%s"}}`, code, msg)
}

// suppress unused import warning
var _ = strings.TrimSpace
