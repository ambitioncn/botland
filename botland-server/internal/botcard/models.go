package botcard

import "time"

// ── Request / Response ──

type ResolveRequest struct {
	Input string `json:"input"`
}

type BindRequest struct {
	CardID string `json:"card_id"`
	Source string `json:"source"` // register | manual | scan | link
}

type CardResponse struct {
	Card *CardDTO `json:"card"`
}

type CardWithMetaResponse struct {
	Card     *CardDTO  `json:"card"`
	Metadata *MetaDTO  `json:"metadata,omitempty"`
}

type BindingResponse struct {
	Binding *BindingDTO `json:"binding"`
}

type BindingsListResponse struct {
	Bindings []BindingDTO `json:"bindings"`
}

type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// ── DTOs ──

type CardDTO struct {
	ID          string  `json:"id"`
	Slug        string  `json:"slug"`
	Code        string  `json:"code"`
	Bot         BotDTO  `json:"bot"`
	HumanURL    string  `json:"human_url"`
	AgentURL    string  `json:"agent_url,omitempty"`
	SkillSlug   string  `json:"skill_slug,omitempty"`
	Status      string  `json:"status"`
}

type BotDTO struct {
	ID      string `json:"id"`
	Slug    string `json:"slug,omitempty"`
	Name    string `json:"name"`
	Avatar  string `json:"avatar,omitempty"`
	Summary string `json:"summary,omitempty"`
}

type MetaDTO struct {
	Provider  string `json:"provider"`
	BotID     string `json:"bot_id"`
	CardID    string `json:"card_id"`
	SkillSlug string `json:"skill_slug,omitempty"`
	Version   string `json:"version"`
	HumanURL  string `json:"human_url"`
	AgentURL  string `json:"agent_url,omitempty"`
}

type BindingDTO struct {
	ID        string    `json:"id"`
	CardID    string    `json:"card_id"`
	CitizenID string    `json:"citizen_id,omitempty"`
	Status    string    `json:"status"`
	Source    string    `json:"source,omitempty"`
	Bot       BotDTO    `json:"bot"`
	CreatedAt time.Time `json:"created_at"`
}

// ── DB rows ──

type BotCard struct {
	ID          string
	Slug        string
	Code        string
	BotID       string
	Title       string
	Description string
	HumanURL    string
	AgentURL    string
	SkillSlug   string
	Status      string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type BotCardBinding struct {
	ID        string
	CardID    string
	CitizenID string
	Source    string
	Status    string
	CreatedAt time.Time
}
