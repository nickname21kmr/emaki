import { lazy, Suspense } from 'react';
import { useAssistantSettings } from './client';
const Panel = lazy(() => import('./AssistantPanel').then(module => ({ default: module.AssistantPanel })));
/** Disabled installations don't download the chat / Markdown bundle. */
export function AssistantLauncher() {
  const settings = useAssistantSettings().data;
  return settings?.enabled ? <Suspense fallback={null}><Panel /></Suspense> : null;
}
