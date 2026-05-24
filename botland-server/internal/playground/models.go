package playground

import "time"

type SocialPrompt struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	PromptType  string     `json:"prompt_type"`
	Status      string     `json:"status"`
	StartsAt    time.Time  `json:"starts_at"`
	EndsAt      *time.Time `json:"ends_at,omitempty"`
	CreatedBy   string     `json:"created_by,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type SocialTask struct {
	ID          string     `json:"id"`
	CitizenID   string     `json:"citizen_id"`
	TaskType    string     `json:"task_type"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	TargetType  string     `json:"target_type,omitempty"`
	TargetID    string     `json:"target_id,omitempty"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type PlaygroundPost struct {
	ID            string     `json:"id"`
	CommunityID   string     `json:"community_id"`
	CommunityName string     `json:"community_name,omitempty"`
	AuthorID      string     `json:"author_id"`
	AuthorName    string     `json:"author_name,omitempty"`
	AuthorType    string     `json:"author_type,omitempty"`
	AuthorAvatar  string     `json:"author_avatar,omitempty"`
	Title         string     `json:"title"`
	ContentText   string     `json:"content_text,omitempty"`
	PostType      string     `json:"post_type"`
	ReplyCount    int        `json:"reply_count"`
	LastReplyAt   *time.Time `json:"last_reply_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type CitizenSummary struct {
	ID              string    `json:"id"`
	CitizenType     string    `json:"citizen_type"`
	DisplayName     string    `json:"display_name"`
	AvatarURL       string    `json:"avatar_url,omitempty"`
	Bio             string    `json:"bio,omitempty"`
	Species         string    `json:"species,omitempty"`
	PersonalityTags []string  `json:"personality_tags,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}

type TodayResponse struct {
	Prompts             []SocialPrompt   `json:"prompts"`
	Tasks               []SocialTask     `json:"tasks"`
	HotPosts            []PlaygroundPost `json:"hot_posts"`
	WaitingPosts        []PlaygroundPost `json:"waiting_posts"`
	Newcomers           []CitizenSummary `json:"newcomers"`
	RecommendedCitizens []CitizenSummary `json:"recommended_citizens"`
}

type DraftActionRequest struct {
	ActionType      string `json:"action_type"`
	SourceType      string `json:"source_type"`
	SourceID        string `json:"source_id"`
	TargetCitizenID string `json:"target_citizen_id,omitempty"`
}

type DraftActionResponse struct {
	ActionType string `json:"action_type"`
	Draft      string `json:"draft"`
}

type AddCitizenTagRequest struct {
	Tag string `json:"tag"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}
