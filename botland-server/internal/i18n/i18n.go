package i18n

import (
	"net/http"
	"strings"
)

const (
	English = "en"
	Chinese = "zh"
)

func Normalize(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return English
	}
	value = strings.ReplaceAll(value, "_", "-")
	switch {
	case value == "zh" || strings.HasPrefix(value, "zh-") || value == "chinese":
		return Chinese
	default:
		return English
	}
}

func FromRequest(r *http.Request) string {
	if r == nil {
		return English
	}
	if lang := r.URL.Query().Get("lang"); strings.TrimSpace(lang) != "" {
		return Normalize(lang)
	}
	if lang := r.Header.Get("X-Botland-Language"); strings.TrimSpace(lang) != "" {
		return Normalize(lang)
	}
	return Normalize(r.Header.Get("Accept-Language"))
}

func GroupSystemText(lang, event, actorName, targetName, groupName string, muted bool) string {
	lang = Normalize(lang)
	switch event {
	case "group_created":
		if lang == Chinese {
			return actorName + " 创建了群聊「" + groupName + "」"
		}
		return actorName + " created the group \"" + groupName + "\""
	case "member_joined":
		if lang == Chinese {
			return targetName + " 加入了群聊"
		}
		return targetName + " joined the group"
	case "member_removed":
		if lang == Chinese {
			return targetName + " 被移出了群聊"
		}
		return targetName + " was removed from the group"
	case "member_promoted":
		if lang == Chinese {
			return targetName + " 被设为管理员"
		}
		return targetName + " was made an admin"
	case "member_demoted":
		if lang == Chinese {
			return targetName + " 被取消管理员"
		}
		return targetName + " is no longer an admin"
	case "member_left":
		if lang == Chinese {
			return actorName + " 退出了群聊"
		}
		return actorName + " left the group"
	case "group_disbanded":
		if lang == Chinese {
			return actorName + " 解散了群聊「" + groupName + "」"
		}
		return actorName + " disbanded the group \"" + groupName + "\""
	case "owner_transferred":
		if lang == Chinese {
			return actorName + " 将群主转让给了 " + targetName
		}
		return actorName + " transferred ownership to " + targetName
	case "mute_all":
		if muted {
			if lang == Chinese {
				return actorName + " 开启了全员禁言"
			}
			return actorName + " muted all members"
		}
		if lang == Chinese {
			return actorName + " 关闭了全员禁言"
		}
		return actorName + " unmuted all members"
	default:
		if lang == Chinese {
			return "群聊状态已更新"
		}
		return "Group status updated"
	}
}

func PushMessageBody(lang string) string {
	if Normalize(lang) == Chinese {
		return "发来一条消息"
	}
	return "sent you a message"
}

func PushImageBody(lang string) string {
	if Normalize(lang) == Chinese {
		return "[图片]"
	}
	return "[image]"
}

func PushGroupMentionBody(lang string) string {
	if Normalize(lang) == Chinese {
		return "在群里@了你"
	}
	return "mentioned you in a group"
}
