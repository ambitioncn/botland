package protocol

// WebSocket message types
const (
	TypeConnected        = "connected"
	TypePing             = "ping"
	TypePong             = "pong"
	TypeMessageSend      = "message.send"
	TypeMessageReceived  = "message.received"
	TypeMessageAck       = "message.ack"
	TypeMessageStatus    = "message.status"
	TypeMessageReaction  = "message.reaction"
	TypePresenceUpdate   = "presence.update"
	TypePresenceSubscribe = "presence.subscribe"
	TypePresenceChanged  = "presence.changed"
	TypeTypingStart      = "typing.start"
	TypeTypingStop       = "typing.stop"
	TypeTypingIndicator  = "typing.indicator"
	TypeFriendRequest    = "friend.request"
	TypeSystemNotification = "system.notification"
	TypeError            = "error"
)

// Content types
const (
	ContentText     = "text"
	ContentImage    = "image"
	ContentVoice    = "voice"
	ContentVideo    = "video"
	ContentFile     = "file"
	ContentSticker  = "sticker"
	ContentLocation = "location"
	ContentCard     = "card"
)

// Citizen types
const (
	CitizenUser  = "user"
	CitizenAgent = "agent"
)

// Envelope is the universal WebSocket message wrapper.
type Envelope struct {
	Type      string      `json:"type"`
	ID        string      `json:"id,omitempty"`
	From      string      `json:"from,omitempty"`
	To        string      `json:"to,omitempty"`
	Timestamp string      `json:"timestamp,omitempty"`
	Payload   interface{} `json:"payload,omitempty"`
}

// MessagePayload carries a chat message.
type MessagePayload struct {
	ContentType  string      `json:"content_type"`
	Text         string      `json:"text,omitempty"`
	MediaURL     string      `json:"media_url,omitempty"`
	ThumbnailURL string      `json:"thumbnail_url,omitempty"`
	MimeType     string      `json:"mime_type,omitempty"`
	DurationMs   int         `json:"duration_ms,omitempty"`
	Width        int         `json:"width,omitempty"`
	Height       int         `json:"height,omitempty"`
	Filename     string      `json:"filename,omitempty"`
	FileSize     int64       `json:"file_size,omitempty"`
	StickerID    string      `json:"sticker_id,omitempty"`
	Latitude     float64     `json:"latitude,omitempty"`
	Longitude    float64     `json:"longitude,omitempty"`
	Name         string      `json:"name,omitempty"`
	Address      string      `json:"address,omitempty"`
	Card         interface{} `json:"card,omitempty"`
	ReplyTo      string      `json:"reply_to,omitempty"`
}

// AckPayload for message acknowledgements.
type AckPayload struct {
	MessageID string `json:"message_id"`
	Status    string `json:"status"` // delivered | read
}

// PresencePayload for status updates.
type PresencePayload struct {
	State string `json:"state"` // online | offline | idle | dnd
	Text  string `json:"text,omitempty"`
}

// ErrorPayload for error messages.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	RefID   string `json:"ref_id,omitempty"`
}
