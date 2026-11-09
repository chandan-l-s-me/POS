import React from 'react';
import { itemKannada } from '../i18n';
import { cn } from '../lib/utils';

/**
 * An item's name in a list, table or card. On a Kannada screen: the Kannada
 * name, with the English one (what is typed and searched) small underneath.
 * Otherwise just the name. `truncate` keeps each line to one line.
 */
export const ItemName: React.FC<{ name: string | null | undefined; truncate?: boolean }> = ({ name, truncate = false }) => {
  const english = name ?? '';
  const kannada = itemKannada(english);
  if (!kannada) return <>{english}</>;
  return (
    <>
      <span lang="kn" className={cn('block', truncate && 'truncate')}>{kannada}</span>
      <span lang="en" className={cn('block text-[0.8em] font-normal leading-tight text-gray-500', truncate && 'truncate')}>
        {english}
      </span>
    </>
  );
};
