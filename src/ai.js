const PROVIDER_MAP = {
  'openai:gpt-5': { vendor: 'openai', model: 'gpt-4.1' },
  'openai:gpt-4.1': { vendor: 'openai', model: 'gpt-4.1' },
  'openai:gpt-4o-legacy': { vendor: 'openai', model: 'gpt-4o-2024-05-13' },
  // Anthropic markets this as Claude 4.5 Sonnet; the API still uses the 3.5 identifier.
  'anthropic:sonnet-4.5': { vendor: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
  'anthropic:sonnet-4': { vendor: 'anthropic', model: 'claude-3-0-sonnet-20240229' },
  'anthropic:opus-4.1': { vendor: 'anthropic', model: 'claude-3-opus-20240229' },
  'google:gemini-2.5': { vendor: 'google', model: 'gemini-2.0-flash-exp' },
  'xai:grok-latest': { vendor: 'xai', model: 'grok-2-latest' }
};

const DEFAULT_CHUNK_WORDS = 2500;
const SCAN_SYSTEM_PROMPT = [
  'You are a local writing assistant that analyses fictional scenes to maintain the manuscript beat outline and proper-noun Codex.',
  'Always respond with strict JSON following this schema:',
  '{',
  '  "sceneNotes": {',
  '    "summary": string,',
  '    "beatsReferenced": string[]',
  '  },',
  '  "beats": [',
  '    {',
  '      "title": string,',
  '      "summary": string',
  '    }',
  '  ],',
  '  "codexUpdates": [',
  '    {',
  '      "name": string,',
  '      "category": "character" | "place" | "item" | "lore",',
  '      "summary": string,',
  '      "background"?: {',
  '        "age"?: {"value": string, "sceneId"?: string, "beatId"?: string},',
  '        "gender"?: {"value": string, "sceneId"?: string, "beatId"?: string},',
  '        "species"?: {"value": string, "sceneId"?: string, "beatId"?: string},',
  '        "faction"?: {"value": string, "sceneId"?: string, "beatId"?: string}',
  '      },',
  '      "core"?: {',
  '        "appearance"?: [ { "text": string, "sceneId"?: string, "beatId"?: string, "confidence"?: "high" | "medium" | "low" } ],',
  '        "personality"?: [ { "text": string, "sceneId"?: string, "beatId"?: string, "confidence"?: "high" | "medium" | "low" } ],',
  '        "dialogueVoice"?: [ { "text": string, "sceneId"?: string, "beatId"?: string, "confidence"?: "high" | "medium" | "low" } ],',
  '        "powersAbilities"?: [ { "text": string, "sceneId"?: string, "beatId"?: string, "confidence"?: "high" | "medium" | "low" } ],',
  '        "relationships"?: [ { "text": string, "sceneId"?: string, "beatId"?: string, "confidence"?: "high" | "medium" | "low" } ]',
  '      },',
  '      "details": [',
  '        { "text": string, "sceneId"?: string, "beatId"?: string }',
  '      ]',
  '    }',
  '  ]',
  '}',
  'Rules:',
  '- Use beat IDs from the provided beats array whenever you populate any beatId fields.',
  '- Only include background/core entries when the scene introduces meaningful new information or changes; prefer confidence "high" or omit the item.',
  '- Details capture dynamic notes; avoid trivial repetitions and duplicates for the same beat.',
  '- Omit properties entirely when there is nothing new to report.',
  '- Ensure the JSON is valid and contains no trailing commas or commentary.'
].join('\n');

const CHAT_DEFAULT_SYSTEM_PROMPT = [
  'You are the SimpleWriter assistant. Use the provided outline, beats, and manuscript excerpts to stay grounded in the story world.',
  'Never invent new facts; quote or paraphrase from the supplied context when referencing story details.',
  'When rewriting text, return only the rewritten passage unless additional commentary is explicitly requested.'
].join('\n');

const DEFAULT_PROXY_ENDPOINT = '/api/proxy';

function resolveProxyEndpoint() {
  if (typeof window === 'undefined') {
    return DEFAULT_PROXY_ENDPOINT;
  }
  const { origin } = window.location;
  if (!origin || origin.startsWith('file://')) {
    return 'http://127.0.0.1:5173/api/proxy';
  }
  return `${origin.replace(/\/$/, '')}/api/proxy`;
}

const PROXY_ENDPOINT = resolveProxyEndpoint();

async function performProviderRequest(requestConfig, expectJson) {
  const proxyResponse = await fetch(PROXY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      endpoint: requestConfig.endpoint,
      method: requestConfig.method || 'POST',
      headers: requestConfig.headers,
      body: requestConfig.body
    })
  });

  const contentType = proxyResponse.headers.get('content-type') || '';
  const rawText = await proxyResponse.text();

  if (!proxyResponse.ok) {
    throw new Error(`AI request failed (${proxyResponse.status}): ${rawText.slice(0, 400)}`);
  }

  if (expectJson || contentType.includes('application/json')) {
    try {
      return rawText ? JSON.parse(rawText) : {};
    } catch (_error) {
      throw new Error('Failed to parse AI response JSON');
    }
  }

  return rawText;
}

function resolveProvider(providerId) {
  return PROVIDER_MAP[providerId] || null;
}

function chunkTextByWords(text, maxWords = DEFAULT_CHUNK_WORDS) {
  if (!text || typeof text !== 'string') {
    return [''];
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [''];
  }

  const chunks = [];
  for (let index = 0; index < words.length; index += maxWords) {
    chunks.push(words.slice(index, index + maxWords).join(' '));
  }
  return chunks;
}

function formatSceneForContext(scene, label) {
  if (!scene || typeof scene !== 'object') {
    return '';
  }
  const lines = [];
  const title = scene.title ? scene.title : 'Untitled scene';
  lines.push(`${label}: ${title}`);

  if (Array.isArray(scene.beats) && scene.beats.length > 0) {
    lines.push('Beats:');
    scene.beats.forEach((beat, index) => {
      const beatTitle = beat && beat.title ? beat.title : `Beat ${index + 1}`;
      const beatSummary = beat && beat.summary ? beat.summary : '';
      lines.push(`- ${beatTitle}${beatSummary ? `: ${beatSummary}` : ''}`);
    });
  }

  if (scene.text) {
    lines.push(scene.text);
  }

  return lines.join('\n');
}

function formatOutlineForContext(outline) {
  return outline ? outline : '';
}

function buildScanPrompt({
  scene,
  beats,
  outline,
  codexEntries,
  previousScene,
  nextScene,
  selectionContext
}) {
  const sections = [];

  sections.push('Context: You are maintaining a structured codex and beat outline for this manuscript.');

  if (previousScene) {
    const formatted = formatSceneForContext(previousScene, 'Previous scene');
    if (formatted) {
      sections.push(formatted);
    }
  }

  if (nextScene) {
    const formatted = formatSceneForContext(nextScene, 'Next scene');
    if (formatted) {
      sections.push(formatted);
    }
  }

  if (outline) {
    sections.push('Current outline snapshot:');
    sections.push(formatOutlineForContext(outline));
  }

  if (beats && Array.isArray(beats) && beats.length > 0) {
    sections.push('Existing scene beats (ordered):');
    beats.forEach((beat, index) => {
      const label = beat && beat.id ? beat.id : `Beat ${index + 1}`;
      sections.push(`- ${label}: ${beat.title || 'Untitled beat'}`);
    });
  }

  if (scene && scene.title) {
    sections.push(`Scene title: ${scene.title}`);
  }

  const textChunks = chunkTextByWords(scene?.text || '');
  sections.push(`Scene text (${textChunks.length} chunk${textChunks.length === 1 ? '' : 's'}):`);
  textChunks.forEach((chunk, index) => {
    sections.push(`--- Chunk ${index + 1} ---`);
    sections.push(chunk);
  });

  if (selectionContext && selectionContext.text) {
    sections.push('Focused selection from manuscript:');
    sections.push(selectionContext.text);
  }

  if (codexEntries && codexEntries.length > 0) {
    sections.push('Existing codex entries (summarised):');
    codexEntries.slice(0, 50).forEach((entry) => {
      const detailsPreview = Array.isArray(entry.details)
        ? entry.details.slice(0, 2).map((detail) => detail.text || '').filter(Boolean)
        : [];
      sections.push(
        `- ${entry.name} (${entry.category}): ${entry.summary || 'No summary'}${
          detailsPreview.length > 0 ? ` | Notable details: ${detailsPreview.join(' / ')}` : ''
        }`
      );
    });
    if (codexEntries.length > 50) {
      sections.push(`(Additional ${codexEntries.length - 50} entries omitted)`);
    }
  }

  sections.push(
    'Instructions:',
    '- Analyse the scene to produce an updated beat list capturing the key developments.',
    '- Generate concise beat summaries in chronological order.',
    '- When referencing beats in codex updates, use the beat IDs provided above.',
    '- Only update Codex entries with meaningful, verifiable information; skip trivial restatements.',
    '- For character background/core updates, only include new or changed details and mark them with confident data (omit low-confidence speculation).',
    '- Return valid JSON matching the specified schema and nothing else.'
  );

  return sections.join('\n');
}

function extractOpenAiResponse(raw) {
  if (!raw || !Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new Error('Unexpected OpenAI response format');
  }
  const content = raw.choices[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI response did not include content');
  }
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function extractAnthropicResponse(raw) {
  if (!raw || !Array.isArray(raw.content) || raw.content.length === 0) {
    throw new Error('Unexpected Anthropic response format');
  }
  const chunk = raw.content.find((item) => item && item.type === 'text');
  if (!chunk || !chunk.text) {
    throw new Error('Anthropic response did not include text content');
  }
  return chunk.text;
}

function extractGoogleResponse(raw) {
  if (!raw || !Array.isArray(raw.candidates) || raw.candidates.length === 0) {
    throw new Error('Unexpected Gemini response format');
  }
  const candidate = raw.candidates[0];
  if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) {
    throw new Error('Gemini response did not include parts text');
  }
  const part = candidate.content.parts.find((item) => item && item.text);
  if (!part || !part.text) {
    throw new Error('Gemini response did not include text');
  }
  return part.text;
}

function extractXaiResponse(raw) {
  if (!raw || !Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new Error('Unexpected xAI response format');
  }
  const content = raw.choices[0]?.message?.content;
  if (!content) {
    throw new Error('xAI response did not include content');
  }
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function buildChatBodyForProvider(provider, { system, messages, responseFormat, temperature = 0.35 }) {
  if (provider.vendor === 'openai') {
    return {
      temperature,
      response_format: responseFormat || undefined,
      messages: [
        { role: 'system', content: system },
        ...messages.map((message) => ({ role: message.role, content: message.content }))
      ]
    };
  }

  if (provider.vendor === 'anthropic') {
    return {
      max_tokens: responseFormat?.type === 'json_object' ? 1024 : 2048,
      temperature,
      system,
      messages: messages.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: message.content }]
      }))
    };
  }

  if (provider.vendor === 'google') {
    return {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${system}\n\n${messages
                .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
                .join('\n\n')}`
            }
          ]
        }
      ],
      response_mime_type: responseFormat?.type === 'json_object' ? 'application/json' : 'text/plain'
    };
  }

  return {
    temperature,
    response_format: responseFormat || undefined,
    messages: [
      { role: 'system', content: system },
      ...messages.map((message) => ({ role: message.role, content: message.content }))
    ]
  };
}

function buildRequestConfig(provider, baseBody, apiKey, expectJson) {
  let endpoint;
  let headers = { 'Content-Type': 'application/json' };
  let body;
  let skipAuthHeader = false;
  let method = 'POST';

  if (provider.vendor === 'openai') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    body = JSON.stringify({ model: provider.model, ...baseBody });
  } else if (provider.vendor === 'anthropic') {
    endpoint = 'https://api.anthropic.com/v1/messages';
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({ model: provider.model, ...baseBody });
  } else if (provider.vendor === 'google') {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;
    body = JSON.stringify(baseBody);
    skipAuthHeader = true;
  } else if (provider.vendor === 'xai') {
    endpoint = 'https://api.x.ai/v1/chat/completions';
    body = JSON.stringify({ model: provider.model, ...baseBody });
  } else {
    throw new Error(`Unsupported provider vendor ${provider.vendor}`);
  }

  if (!skipAuthHeader) {
    const headerName = provider.vendor === 'anthropic' ? 'x-api-key' : 'Authorization';
    const headerValue = provider.vendor === 'anthropic' ? apiKey : `Bearer ${apiKey}`;
    headers[headerName] = headerValue;
  }

  return {
    method,
    endpoint,
    headers,
    body,
    expectJson
  };
}

function parseJsonFromText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('AI response was empty');
  }

  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const startIndex = trimmed.indexOf('{');
    const endIndex = trimmed.lastIndexOf('}');
    if (startIndex >= 0 && endIndex > startIndex) {
      const slice = trimmed.slice(startIndex, endIndex + 1);
      return JSON.parse(slice);
    }
    throw new Error('Failed to parse AI response JSON');
  }
}

function extractProviderResponse(provider, raw) {
  if (provider.vendor === 'openai') {
    return extractOpenAiResponse(raw);
  }
  if (provider.vendor === 'anthropic') {
    return extractAnthropicResponse(raw);
  }
  if (provider.vendor === 'google') {
    return extractGoogleResponse(raw);
  }
  return extractXaiResponse(raw);
}

function validateScanPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('AI response payload missing or invalid');
  }
  if (!Array.isArray(payload.codexUpdates)) {
    throw new Error('AI response must include codexUpdates array');
  }
  if (!Array.isArray(payload.beats)) {
    throw new Error('AI response must include beats array');
  }
  return payload;
}

export async function requestSceneScan({
  providerId,
  apiKey,
  scene,
  beats,
  outline,
  codexEntries,
  previousScene,
  nextScene,
  selectionContext,
  onProgress
}) {
  const provider = resolveProvider(providerId);
  if (!provider) {
    throw new Error('Selected provider is not supported yet');
  }
  if (!apiKey) {
    throw new Error('API key is required for this provider');
  }

  const prompt = buildScanPrompt({
    scene,
    beats,
    outline,
    codexEntries,
    previousScene,
    nextScene,
    selectionContext
  });
  onProgress?.('prepared', 'Prompt prepared for AI request');

  const body = buildChatBodyForProvider(provider, {
    system: SCAN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    responseFormat: { type: 'json_object' },
    temperature: 0.2
  });

  const requestConfig = buildRequestConfig(provider, body, apiKey, true);

  onProgress?.('requesting', 'Sending scene to AI provider');
  const raw = await performProviderRequest(requestConfig, true);
  onProgress?.('receiving', 'Received AI response, parsing content');

  const rawText = extractProviderResponse(provider, raw);
  const payload = parseJsonFromText(rawText);
  return validateScanPayload(payload);
}

export async function requestChatCompletion({
  providerId,
  apiKey,
  messages,
  systemPrompt = CHAT_DEFAULT_SYSTEM_PROMPT,
  responseFormat = null,
  temperature = 0.35
}) {
  const provider = resolveProvider(providerId);
  if (!provider) {
    throw new Error('Selected provider is not supported yet');
  }
  if (!apiKey) {
    throw new Error('API key is required for this provider');
  }

  const body = buildChatBodyForProvider(provider, {
    system: systemPrompt,
    messages,
    responseFormat,
    temperature
  });

  const requestConfig = buildRequestConfig(provider, body, apiKey, responseFormat?.type === 'json_object');

  if (responseFormat?.type === 'json_object') {
    const raw = await performProviderRequest(requestConfig, true);
    const rawText = extractProviderResponse(provider, raw);
    return parseJsonFromText(rawText);
  }

  const raw = await performProviderRequest(requestConfig, true);
  return extractProviderResponse(provider, raw);
}
