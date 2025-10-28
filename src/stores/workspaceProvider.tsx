import { PropsWithChildren } from 'react';
import { OutlineStoreProvider } from './outlineStore';
import { SceneStoreProvider } from './sceneStore';
import { CodexStoreProvider } from './codexStore';

export function WorkspaceProvider({ children }: PropsWithChildren) {
  return (
    <OutlineStoreProvider>
      <SceneStoreProvider>
        <CodexStoreProvider>{children}</CodexStoreProvider>
      </SceneStoreProvider>
    </OutlineStoreProvider>
  );
}
