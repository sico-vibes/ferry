import { useEffect } from 'react';
import { useUI } from '../state/ui';

const COMPOSER_INSERT_EVENT = 'ferry:composer-insert';

/** Adds text (e.g. an @file mention) to whichever composer is on screen and focuses it. */
export function insertIntoComposer(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(COMPOSER_INSERT_EVENT, { detail: text }));
  useUI.getState().requestComposerFocus();
}

/** Appends inserted text to a composer's draft, separated by a space. */
export function useComposerInsert(setPrompt: (update: (current: string) => string) => void): void {
  useEffect(() => {
    const onInsert = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (!text) return;
      setPrompt((current) => (current && !/\s$/.test(current) ? `${current} ` : current) + text);
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => {
      window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
    };
  }, [setPrompt]);
}
