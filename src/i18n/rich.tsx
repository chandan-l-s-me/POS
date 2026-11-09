import React from 'react';
import { t, type TranslationVars } from './index';

/**
 * A translated sentence with parts of it styled: `tRich('Set {setting} in the
 * {file} file.', { setting: <code>BACKUP_DIR</code>, file: <code>.env</code> })`.
 * The whole sentence is one entry, so a language can move the parts where its
 * grammar needs them; the parts drop into their {placeholders}.
 */
export const tRich = (text: string, parts: Record<string, React.ReactNode>, vars?: TranslationVars): React.ReactNode => {
  const sentence = t(text, vars);
  return sentence.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <React.Fragment key={index}>{name && name in parts ? parts[name] : piece}</React.Fragment>;
  });
};
