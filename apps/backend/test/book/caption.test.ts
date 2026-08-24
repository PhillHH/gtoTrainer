import { describe, expect, it } from 'vitest';
import { isCaptionLine, parseCaption } from '../../src/book/caption.js';

describe('Bildunterschriften zerlegen', () => {
  it('liest Etikett, Nummer, Spot und Prozentwerte', () => {
    const caption = parseCaption([
      '*Hand Range 99: SB vs BB (25bb)*',
      '*• All-in 1.8% / • Raise 3.3x 30% /*',
      '*• Limp 50.3% / • Fold 17.9%*',
    ]);
    expect(caption.label).toBe('Hand Range');
    expect(caption.number).toBe(99);
    expect(caption.spot).toBe('SB vs BB (25bb)');
    expect(caption.actions).toEqual([
      { action: 'All-in', percent: 1.8 },
      { action: 'Raise 3.3x', percent: 30 },
      { action: 'Limp', percent: 50.3 },
      { action: 'Fold', percent: 17.9 },
    ]);
  });

  it('haelt den Rohtext unveraendert fest', () => {
    const lines = ['*Hand Range 98:*', '*SB vs BB 15bb (Limp vs 3x Raise)*'];
    expect(parseCaption(lines).raw).toBe(lines.join('\n'));
  });

  it('setzt eine ueber mehrere Zeilen umbrochene Unterschrift zusammen', () => {
    const caption = parseCaption(['*Hand Range 98:*', '*SB vs BB 15bb (Limp vs 3x Raise)*']);
    expect(caption.number).toBe(98);
    expect(caption.spot).toBe('SB vs BB 15bb (Limp vs 3x Raise)');
  });

  it('kommt mit falsch gesetzten Kursivzeichen zurecht', () => {
    // So steht es in der Quelle: das schliessende * sitzt vor dem Symbol.
    const caption = parseCaption(['*Table 113: UTG C-betting Range Breakdown on A*Q3']);
    expect(caption.label).toBe('Table');
    expect(caption.number).toBe(113);
  });

  it('gibt eine Unterschrift ohne erkennbare Struktur unveraendert zurueck', () => {
    const caption = parseCaption(['*Ein Satz ganz ohne Nummerierung.*']);
    expect(caption.label).toBeNull();
    expect(caption.number).toBeNull();
    expect(caption.spot).toBe('Ein Satz ganz ohne Nummerierung.');
    expect(caption.actions).toEqual([]);
    expect(caption.raw).toBe('*Ein Satz ganz ohne Nummerierung.*');
  });

  it('normalisiert Komma-Dezimaltrenner in Prozentwerten', () => {
    expect(parseCaption(['*• Fold 17,9%*']).actions).toEqual([{ action: 'Fold', percent: 17.9 }]);
  });

  it('unterscheidet Unterschrift von fettem Zwischentitel', () => {
    expect(isCaptionLine('*Table 45: Frequenzen*')).toBe(true);
    expect(isCaptionLine('**Total Range**')).toBe(false);
    expect(isCaptionLine('Normaler Text')).toBe(false);
  });
});
