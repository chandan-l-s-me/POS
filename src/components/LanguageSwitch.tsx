import React from 'react';
import { Languages } from 'lucide-react';
import { LANGUAGES, useLanguageStore } from '../i18n';
import { cn } from '../lib/utils';

/**
 * English / ಕನ್ನಡ. Each language is named in its own script, so whoever is at
 * the screen can find theirs whichever one is showing. The choice is kept on
 * this device. `compact`: on a phone, ಕನ್ನಡ shows as ಕ, to leave the top bar
 * room for the page title.
 */
export const LanguageSwitch: React.FC<{ className?: string; compact?: boolean }> = ({ className, compact = false }) => {
  const lang = useLanguageStore((state) => state.lang);
  const setLang = useLanguageStore((state) => state.setLang);

  return (
    <div
      role="radiogroup"
      aria-label="Language / ಭಾಷೆ"
      title="Language / ಭಾಷೆ"
      className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-xl bg-gray-100 p-1', className)}
    >
      <Languages size={16} className="mx-1 hidden text-gray-400 sm:block" aria-hidden />
      {LANGUAGES.map((language) => {
        const active = language.id === lang;
        return (
          <button
            key={language.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={language.label}
            lang={language.id}
            onClick={() => setLang(language.id)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-sm font-bold transition-colors',
              active ? 'bg-orange-600 text-white shadow-sm' : 'text-gray-600 hover:bg-white hover:text-gray-900'
            )}
          >
            {language.id === 'en' ? language.short : compact ? (
              <>
                <span className="sm:hidden">{language.short}</span>
                <span className="hidden sm:inline">{language.label}</span>
              </>
            ) : language.label}
          </button>
        );
      })}
    </div>
  );
};
