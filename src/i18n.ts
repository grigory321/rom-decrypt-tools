import ja from './locales/ja.js';
import en from './locales/en.js';
import ru from './locales/ru.js';
import type { RpcError } from './rpc-types.js';

type Language = 'ja' | 'en' | 'ru';
type MessageKey = Exclude<keyof typeof en, 'errors'>;
type Locale = Partial<Record<MessageKey, string>> & {
  errors: Record<string, string>;
};

export const languages: Record<Language, Locale> = { ja, en, ru };
let currentLanguage: Language = 'ja';

function isLanguage(language: string): language is Language {
  return language === 'ja' || language === 'en' || language === 'ru';
}

function isMessageKey(key: string): key is MessageKey {
  return key !== 'errors' && Object.hasOwn(en, key);
}

export function setLanguage(language: string) {
  currentLanguage = isLanguage(language) ? language : 'ja';
  document.documentElement.lang = currentLanguage;
  return currentLanguage;
}

export function t(key: string | undefined): string {
  if (key === undefined) return '';
  return isMessageKey(key) ? (languages[currentLanguage][key] ?? en[key]) : key;
}

export function errorInfo(error: unknown): RpcError {
  if (typeof error !== 'object' || error === null) return { code: 'ERROR' };
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : 'ERROR';
  const detail =
    'detail' in error && typeof error.detail === 'string'
      ? error.detail
      : undefined;
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : undefined;
  return { code, detail, message };
}

export function errorText(error: unknown, withDetail = true): string {
  const value = errorInfo(error);
  const errors = languages[currentLanguage].errors;
  const message =
    errors[value.code] ||
    (value.code.startsWith('ZIP_') ? errors.ZIP_DATA : errors.ERROR);
  return message + (withDetail && value.detail ? ' · ' + value.detail : '');
}
