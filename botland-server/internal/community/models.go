package community

import "time"

type Community struct {
	ID             string    `json:"id"`
	Slug           string    `json:"slug"`
	Name           string    `json:"name"`
	Description    string    `json:"description,omitempty"`
	AvatarURL      string    `json:"avatar_url,omitempty"`
	CoverURL       string    `json:"cover_url,omitempty"`
	OwnerID        string    `json:"owner_id"`
	Visibility     string    `json:"visibility"`
	PostPermission string    `json:"post_permission"`
	Status         string    `json:"status"`
	MemberCount    int       `json:"member_count"`
	PostCount      int       `json:"post_count"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type CommunityListItem struct {
	Community
	IsMember bool   `json:"is_member"`
	MyRole   string `json:"my_role,omitempty"`
}

type CommunityDetail struct {
	CommunityListItem
}

type CommunityMember struct {
	ID          string     `json:"id"`
	CommunityID string     `json:"community_id"`
	CitizenID   string     `json:"citizen_id"`
	Role        string     `json:"role"`
	State       string     `json:"state"`
	JoinedAt    time.Time  `json:"joined_at"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
}

type CommunityPost struct {
	ID           string                 `json:"id"`
	CommunityID  string                 `json:"community_id"`
	AuthorID     string                 `json:"author_id"`
	AuthorName   string                 `json:"author_name,omitempty"`
	AuthorType   string                 `json:"author_type,omitempty"`
	AuthorAvatar string                 `json:"author_avatar,omitempty"`
	Title        string                 `json:"title"`
	Content      map[string]interface{} `json:"content"`
	PostType     string                 `json:"post_type"`
	Status       string                 `json:"status"`
	IsPinned     bool                   `json:"is_pinned"`
	IsFeatured   bool                   `json:"is_featured"`
	ReplyCount   int                    `json:"reply_count"`
	LastReplyAt  *time.Time             `json:"last_reply_at,omitempty"`
	CreatedAt    time.Time              `json:"created_at"`
	UpdatedAt    time.Time              `json:"updated_at"`
}

type CommunityReply struct {
	ID           string                 `json:"id"`
	PostID       string                 `json:"post_id"`
	CommunityID  string                 `json:"community_id"`
	AuthorID     string                 `json:"author_id"`
	AuthorName   string                 `json:"author_name,omitempty"`
	AuthorType   string                 `json:"author_type,omitempty"`
	AuthorAvatar string                 `json:"author_avatar,omitempty"`
	FloorNo      int                    `json:"floor_no"`
	Content      map[string]interface{} `json:"content"`
	ReplyToID    string                 `json:"reply_to_id,omitempty"`
	Status       string                 `json:"status"`
	CreatedAt    time.Time              `json:"created_at"`
	UpdatedAt    time.Time              `json:"updated_at"`
}

type CreateCommunityRequest struct {
	Slug           string `json:"slug,omitempty"`
	Name           string `json:"name"`
	Description    string `json:"description,omitempty"`
	AvatarURL      string `json:"avatar_url,omitempty"`
	CoverURL       string `json:"cover_url,omitempty"`
	Visibility     string `json:"visibility,omitempty"`
	PostPermission string `json:"post_permission,omitempty"`
}

type CreatePostRequest struct {
	Title    string                 `json:"title"`
	Content  map[string]interface{} `json:"content"`
	PostType string                 `json:"post_type,omitempty"`
}

type CreateReplyRequest struct {
	Content   map[string]interface{} `json:"content"`
	ReplyToID string                 `json:"reply_to_id,omitempty"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}
