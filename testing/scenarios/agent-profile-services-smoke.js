const { loadAccounts, getLogin, request } = require('../drivers/botlandClient');

function answerFor(questionId) {
  const answers = {
    a1: 'd7a8fbb3',
    a2: '{"name":"Profile Services Smoke Agent","type":"agent"}',
    a3: '42, generated from a deterministic pseudo-random test seed.',
    a4: 'gpt-test-model version smoke',
    a5: 'Welcome to BotLand',
    a6: '- profile editing\n- service discovery\n- structured chat handoff',
  };
  return answers[questionId] || 'profile services smoke answer';
}

(async () => {
  const result = { ok: false, scenario: 'agent-profile-services-smoke', details: {} };
  try {
    const cfg = loadAccounts();
    const viewer = cfg.actors.lobster_sender;
    if (!viewer?.handle || !viewer?.password) {
      throw new Error('lobster_sender config missing in accounts.local.json');
    }

    const viewerLogin = await getLogin(cfg.baseUrl, viewer.handle, viewer.password, { force: true });
    const suffix = Date.now().toString(36).slice(-10);
    const handle = `ap${suffix}`;
    const serviceName = `Profile audit ${suffix}`;
    const capability = `profile-smoke-${suffix}`;
    const service = {
      name: serviceName,
      description: 'Review an Agent profile and suggest clearer service packaging.',
      price: 'intro',
    };

    const challenge = await request(cfg.baseUrl, '/api/v1/auth/challenge', {
      method: 'POST',
      body: { identity: 'agent' },
    });
    const answers = {};
    for (const q of challenge.questions || []) {
      answers[q.id] = answerFor(q.id);
    }

    const challengeResult = await request(cfg.baseUrl, '/api/v1/auth/challenge/answer', {
      method: 'POST',
      body: { session_id: challenge.session_id, answers },
    });
    if (!challengeResult.passed || !challengeResult.token) {
      throw new Error(`agent challenge failed: ${JSON.stringify(challengeResult)}`);
    }

    const registered = await request(cfg.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        handle,
        password: `pw${suffix}`,
        display_name: `Profile Services ${suffix}`,
        challenge_token: challengeResult.token,
      },
    });
    if (registered.citizen_type !== 'agent') {
      throw new Error(`registered citizen is not an agent: ${JSON.stringify(registered)}`);
    }

    await request(cfg.baseUrl, '/api/v1/me', {
      method: 'PATCH',
      token: registered.access_token,
      body: {
        bio: 'Smoke-test Agent for profile service discovery.',
        species: 'service-agent',
        framework: 'BotLand Smoke',
        personality_tags: ['focused', 'practical'],
        capabilities: [capability, 'profile-review'],
        services: [service],
      },
    });

    const ownProfile = await request(cfg.baseUrl, '/api/v1/me', {
      method: 'GET',
      token: registered.access_token,
    });
    const publicProfile = await request(
      cfg.baseUrl,
      `/api/v1/citizens/${encodeURIComponent(registered.citizen_id)}`,
      { method: 'GET', token: viewerLogin.access_token }
    );
    const capabilitySearch = await request(
      cfg.baseUrl,
      `/api/v1/discover/search?q=${encodeURIComponent(capability)}&type=agent`,
      { method: 'GET', token: viewerLogin.access_token }
    );
    const serviceSearch = await request(
      cfg.baseUrl,
      `/api/v1/discover/search?q=${encodeURIComponent(serviceName)}&type=agent`,
      { method: 'GET', token: viewerLogin.access_token }
    );

    const hasCapability = Array.isArray(ownProfile.capabilities) && ownProfile.capabilities.includes(capability);
    const hasService = Array.isArray(ownProfile.services) && ownProfile.services.some((s) => s.name === serviceName);
    const publicHasService = Array.isArray(publicProfile.services) && publicProfile.services.some((s) => s.name === serviceName);
    const discoveredByCapability = (capabilitySearch.results || []).some((r) => r.citizen_id === registered.citizen_id);
    const discoveredByService = (serviceSearch.results || []).some((r) => r.citizen_id === registered.citizen_id);

    result.details = {
      agent: {
        citizen_id: registered.citizen_id,
        handle,
        display_name: ownProfile.display_name,
        citizen_type: ownProfile.citizen_type,
      },
      profile: {
        capability,
        serviceName,
        hasCapability,
        hasService,
        publicHasService,
        ownCapabilities: ownProfile.capabilities,
        ownServices: ownProfile.services,
        publicServices: publicProfile.services,
      },
      discover: {
        capabilityResults: capabilitySearch.total,
        serviceResults: serviceSearch.total,
        discoveredByCapability,
        discoveredByService,
      },
    };

    if (!hasCapability || !hasService || !publicHasService || !discoveredByCapability || !discoveredByService) {
      throw new Error('agent profile services were not persisted or discoverable');
    }

    result.ok = true;

    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
