export const CATEGORY_LABELS = {
  character: 'Characters',
  place: 'Places',
  item: 'Items',
  lore: 'Lore'
};

export const CHARACTER_BACKGROUND_FIELDS = ['age', 'gender', 'species', 'faction'];

export const CHARACTER_BACKGROUND_LABELS = {
  age: 'Age',
  gender: 'Gender',
  species: 'Species',
  faction: 'Faction'
};

export const CHARACTER_CORE_SECTION_KEYS = [
  'appearance',
  'personality',
  'dialogueVoice',
  'powersAbilities',
  'relationships'
];

export const CHARACTER_CORE_SECTION_LABELS = {
  appearance: 'Appearance',
  personality: 'Personality',
  dialogueVoice: 'Dialogue & Voice',
  powersAbilities: 'Powers & Abilities',
  relationships: 'Relationships'
};

export const DEFAULT_SIDEBAR_WIDTHS = { left: 320, right: 280 };
export const SIDEBAR_LIMITS = {
  left: { min: 240, max: 560 },
  right: { min: 220, max: 480 },
  centerMin: 520
};
export const LAYOUT_RESIZER_WIDTH = 12;
export const LAYOUT_RESIZER_COUNT = 2;
export const MAX_MEDIA_SIZE_BYTES = 2 * 1024 * 1024;

export const AI_PROVIDERS = [
  { id: 'openai:gpt-5', label: 'OpenAI · GPT-5' },
  { id: 'openai:gpt-4.1', label: 'OpenAI · GPT-4.1' },
  { id: 'openai:gpt-4o-legacy', label: 'OpenAI · GPT-4o Legacy' },
  { id: 'anthropic:sonnet-4.5', label: 'Anthropic · Claude Sonnet 4.5' },
  { id: 'anthropic:sonnet-4', label: 'Anthropic · Claude Sonnet 4' },
  { id: 'anthropic:opus-4.1', label: 'Anthropic · Claude Opus 4.1' },
  { id: 'google:gemini-2.5', label: 'Google · Gemini 2.5' },
  { id: 'xai:grok-latest', label: 'xAI · Grok (latest)' }
];

export const PROVIDER_ROLES = ['assistant', 'codex'];
export const DEFAULT_PROVIDER = AI_PROVIDERS[0].id;
export const PERSIST_DEBOUNCE_MS = 400;

export const BEAT_GENERATION_SYSTEM_PROMPT = [
  'You are a story structure assistant who creates concise scene beats that track character intent, conflict, and change.',
  'Always respond with strictly valid JSON shaped as {"beats":[{"title": string, "summary": string}]} with 4-6 beats.',
  'Beat summaries must be 1-2 sentences focused on what changes in the scene. Avoid meta commentary.'
].join('\n');

export const SCENE_DRAFT_SYSTEM_PROMPT = [
  'You are a collaborative fiction writing assistant.',
  'When asked to write a scene, provide polished narrative prose that follows the supplied beats and context.',
  'Prioritise vivid sensory detail, character voice, and pacing that fits the outlined mood and stakes.',
  'Avoid hedging or disclaimers—deliver the requested scene confidently, unless the user explicitly asks for something prohibited.',
  'Return the scene text only unless the user asks for additional commentary.'
].join('\n');

export const MAX_BEAT_OUTLINE_BEATS = 120;
export const MAX_BEAT_SUMMARY_LENGTH = 220;
