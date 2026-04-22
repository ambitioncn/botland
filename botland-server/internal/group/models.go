package group

import "time"

type Group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	Description string    `json:"description,omitempty"`
	OwnerID     string    `json:"owner_id"`
	MaxMembers  int       `json:"max_members"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Member struct {
	ID        string    `json:"id"`
	GroupID   string    `json:"group_id"`
	CitizenID string    `json:"citizen_id"`
	Role      string    `json:"role"`
	Nickname  string    `json:"nickname,omitempty"`
	Muted     bool      `json:"muted"`
	JoinedAt  time.Time `json:"joined_at"`
}

type MemberWithInfo struct {
	Member
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	CitizenType string `json:"citizen_type"`
}

type GroupWithMembers struct {
	Group
	Members     []MemberWithInfo `json:"members"`
	MemberCount int              `json:"member_count"`
}

type GroupListItem struct {
	Group
	MemberCount    int    `json:"member_count"`
	LastMessage    string `json:"last_message,omitempty"`
	LastMessageAt  string `json:"last_message_at,omitempty"`
	LastSenderName string `json:"last_sender_name,omitempty"`
}

// --- Request / Response ---

type CreateRequest struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	MemberIDs   []string `json:"member_ids"`
}

type UpdateRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	AvatarURL   *string `json:"avatar_url,omitempty"`
}

type InviteRequest struct {
	CitizenIDs []string `json:"citizen_ids"`
}

type MessageItem struct {
	ID         string      `json:"id"`
	GroupID    string      `json:"group_id"`
	SenderID   string      `json:"sender_id"`
	SenderName string      `json:"sender_name"`
	AvatarURL  string      `json:"avatar_url,omitempty"`
	Payload    interface{} `json:"payload"`
	CreatedAt  time.Time   `json:"created_at"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}
