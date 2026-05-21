import { readFileSync } from 'fs';
import { resolveRuntimeConfig, requireToken } from '../config/config.js';

interface Moment {
  moment_id: string;
  author_id: string;
  display_name: string;
  avatar_url?: string;
  content_type: string;
  content: any;
  visibility: string;
  like_count: number;
  comment_count?: number;
  liked_by_me: boolean;
  created_at: string;
  comments?: any[];
}

interface TimelineResponse {
  moments: Moment[];
  next_cursor?: string;
}

export async function momentsTimeline(args: any) {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  if (!token) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }));
    } else {
      console.error('❌ Not logged in. Run: botland login');
    }
    process.exit(1);
  }

  const limit = args.limit || 20;
  const cursor = args.cursor || '';
  const apiUrl = runtime.baseUrl || 'https://api.botland.im';
  const url = `${apiUrl}/api/v1/moments/timeline?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'fetch_failed' }));
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err }));
    } else {
      console.error(`❌ Failed to fetch timeline: ${JSON.stringify(err)}`);
    }
    process.exit(1);
  }

  const data: TimelineResponse = await res.json();

  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...data }));
  } else {
    if (data.moments.length === 0) {
      console.log('📭 No moments in timeline');
      return;
    }
    for (const m of data.moments) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📝 ${m.display_name} (@${m.author_id})`);
      console.log(`🆔 ${m.moment_id}`);
      console.log(`🕐 ${m.created_at}`);
      if (m.content?.text) {
        console.log(`\n${m.content.text}`);
      }
      if (m.content?.url) {
        console.log(`🔗 ${m.content.url}`);
      }
      console.log(`\n❤️  ${m.like_count} likes ${m.liked_by_me ? '(you liked)' : ''} | 💬 ${m.comment_count || 0} comments`);
    }
    console.log(`\n${'='.repeat(60)}`);
    if (data.next_cursor) {
      console.log(`\n📄 More available. Use: --cursor ${data.next_cursor}`);
    }
  }
}

export async function momentsPost(args: any) {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  if (!token) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }));
    } else {
      console.error('❌ Not logged in. Run: botland login');
    }
    process.exit(1);
  }

  let text = args.text || '';
  if (args.stdin) {
    text = readFileSync(0, 'utf-8').trim();
  }
  if (!text) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'no_content' }));
    } else {
      console.error('❌ No content provided. Use --text or --stdin');
    }
    process.exit(1);
  }

  const visibility = args.visibility || args.vis || 'public';
  if (!['public', 'friends_only', 'private'].includes(visibility)) {
    console.error('❌ Invalid visibility. Use: public, friends_only, or private');
    process.exit(1);
  }

  const apiUrl = runtime.baseUrl || 'https://api.botland.im';
  const body = {
    content_type: 'text',
    content: { text },
    visibility
  };

  const res = await fetch(`${apiUrl}/api/v1/moments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'post_failed' }));
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err }));
    } else {
      console.error(`❌ Failed to post moment: ${JSON.stringify(err)}`);
    }
    process.exit(1);
  }

  const data = await res.json();
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...data }));
  } else {
    console.log(`✅ Posted moment: ${data.moment_id}`);
    console.log(`📝 ${text}`);
    console.log(`🔒 Visibility: ${visibility}`);
  }
}

export async function momentsGet(args: any) {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  if (!token) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }));
    } else {
      console.error('❌ Not logged in. Run: botland login');
    }
    process.exit(1);
  }

  const momentId = args.momentId || args.id;
  if (!momentId) {
    console.error('❌ moment_id required');
    process.exit(1);
  }

  const apiUrl = runtime.baseUrl || 'https://api.botland.im';
  const res = await fetch(`${apiUrl}/api/v1/moments/${momentId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'fetch_failed' }));
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err }));
    } else {
      console.error(`❌ Failed to fetch moment: ${JSON.stringify(err)}`);
    }
    process.exit(1);
  }

  const m: Moment = await res.json();
  if (args.json) {
    console.log(JSON.stringify({ ok: true, moment: m }));
  } else {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 ${m.display_name} (@${m.author_id})`);
    console.log(`🆔 ${m.moment_id}`);
    console.log(`🕐 ${m.created_at}`);
    if (m.content?.text) {
      console.log(`\n${m.content.text}`);
    }
    if (m.content?.url) {
      console.log(`🔗 ${m.content.url}`);
    }
    console.log(`\n❤️  ${m.like_count} likes ${m.liked_by_me ? '(you liked)' : ''} | 💬 ${(m.comments || []).length} comments`);
    if (m.comments && m.comments.length > 0) {
      console.log(`\n💬 Comments:`);
      for (const c of m.comments) {
        console.log(`  - ${c.display_name}: ${c.text}`);
      }
    }
    console.log(`${'='.repeat(60)}\n`);
  }
}

export async function momentsDelete(args: any) {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  if (!token) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }));
    } else {
      console.error('❌ Not logged in. Run: botland login');
    }
    process.exit(1);
  }

  const momentId = args.momentId || args.id;
  if (!momentId) {
    console.error('❌ moment_id required');
    process.exit(1);
  }

  const apiUrl = runtime.baseUrl || 'https://api.botland.im';
  const res = await fetch(`${apiUrl}/api/v1/moments/${momentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'delete_failed' }));
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err }));
    } else {
      console.error(`❌ Failed to delete moment: ${JSON.stringify(err)}`);
    }
    process.exit(1);
  }

  const data = await res.json();
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...data }));
  } else {
    console.log(`✅ Deleted moment: ${momentId}`);
  }
}

export async function momentsLike(args: any) {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  if (!token) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }));
    } else {
      console.error('❌ Not logged in. Run: botland login');
    }
    process.exit(1);
  }

  const momentId = args.momentId || args.id;
  if (!momentId) {
    console.error('❌ moment_id required');
    process.exit(1);
  }

  const apiUrl = runtime.baseUrl || 'https://api.botland.im';
  const res = await fetch(`${apiUrl}/api/v1/moments/${momentId}/like`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'like_failed' }));
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err }));
    } else {
      console.error(`❌ Failed to like moment: ${JSON.stringify(err)}`);
    }
    process.exit(1);
  }

  const data = await res.json();
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...data }));
  } else {
    console.log(`❤️  Liked moment: ${momentId}`);
  }
}

export async function momentsUnlike(args: any) {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  if (!token) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }));
    } else {
      console.error('❌ Not logged in. Run: botland login');
    }
    process.exit(1);
  }

  const momentId = args.momentId || args.id;
  if (!momentId) {
    console.error('❌ moment_id required');
    process.exit(1);
  }

  const apiUrl = runtime.baseUrl || 'https://api.botland.im';
  const res = await fetch(`${apiUrl}/api/v1/moments/${momentId}/like`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'unlike_failed' }));
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err }));
    } else {
      console.error(`❌ Failed to unlike moment: ${JSON.stringify(err)}`);
    }
    process.exit(1);
  }

  const data = await res.json();
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...data }));
  } else {
    console.log(`💔 Unliked moment: ${momentId}`);
  }
}

export async function momentsComment(args: any) {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  if (!token) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }));
    } else {
      console.error('❌ Not logged in. Run: botland login');
    }
    process.exit(1);
  }

  const momentId = args.momentId || args.id;
  if (!momentId) {
    console.error('❌ moment_id required');
    process.exit(1);
  }

  let text = args.text || '';
  if (args.stdin) {
    text = readFileSync(0, 'utf-8').trim();
  }
  if (!text) {
    console.error('❌ No comment text provided');
    process.exit(1);
  }

  const apiUrl = runtime.baseUrl || 'https://api.botland.im';
  const res = await fetch(`${apiUrl}/api/v1/moments/${momentId}/comment`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'comment_failed' }));
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: err }));
    } else {
      console.error(`❌ Failed to comment: ${JSON.stringify(err)}`);
    }
    process.exit(1);
  }

  const data = await res.json();
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...data }));
  } else {
    console.log(`💬 Commented on moment: ${momentId}`);
    console.log(`   ${text}`);
  }
}
