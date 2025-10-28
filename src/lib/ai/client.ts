export type AiProvider = 'openai' | 'anthropic' | 'google' | 'xai';

export type AiModel =
  | { provider: 'openai'; model: 'gpt-5' | 'gpt-4.1' }
  | { provider: 'anthropic'; model: 'claude-sonnet-4.5' | 'claude-sonnet-4' | 'opus-4.1' }
  | { provider: 'google'; model: 'gemini-2.5-pro' | 'gemini-2.5-flash' }
  | { provider: 'xai'; model: 'grok-latest' };

export interface BeatPrompt {
  outline: string;
  beats: Array<{ order: number; title: string }>;
}

export interface DraftPrompt {
  outline: string;
  beats: Array<{ order: number; title: string }>;
  sceneSummary: string;
}

export interface ScanPrompt {
  sceneText: string;
}

export interface ScanResult {
  entries: Array<{
    name: string;
    category: string;
    summary: string;
  }>;
}

export interface ChatPrompt {
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ChatResult {
  messages: Array<{ role: 'assistant'; content: string }>;
}

export interface AiClient {
  generateBeats(input: BeatPrompt): Promise<Array<{ order: number; title: string }>>;
  draftScene(input: DraftPrompt): Promise<string>;
  scanScene(input: ScanPrompt): Promise<ScanResult>;
  chat(input: ChatPrompt): Promise<ChatResult>;
}

export class MockAiClient implements AiClient {
  async generateBeats(input: BeatPrompt) {
    return input.beats.length > 0
      ? input.beats
      : [
          { order: 1, title: 'Establish the scene stakes' },
          { order: 2, title: 'Introduce character conflict' }
        ];
  }

  async draftScene(input: DraftPrompt) {
    return `Drafted scene based on ${input.beats.length} beats.`;
  }

  async scanScene(_input: ScanPrompt) {
    return {
      entries: []
    };
  }

  async chat(_input: ChatPrompt) {
    return {
      messages: [{ role: 'assistant', content: 'How can I help with your manuscript?' }]
    };
  }
}
