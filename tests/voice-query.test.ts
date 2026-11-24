/**
 * Search by voice: from what the recogniser heard to what goes in the search
 * box (src/lib/voiceQuery.ts). Run against a catalogue written the way the
 * shop writes it, with the guesses a recogniser really gives.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanSpokenText, pickTranscript, soundKey } from '../src/lib/voiceQuery.ts';
import { searchList, type SearchFields } from '../src/lib/fuzzy.ts';

interface Entry {
  name: string;
  phone?: string;
  hsn_code?: string;
}

const CATALOGUE: Entry[] = [
  { name: 'Icing Sugar (1 kg)', hsn_code: '17019990' },
  { name: 'Castor Sugar (1 kg)', hsn_code: '17019990' },
  { name: 'Brown Sugar (500 g)', hsn_code: '17011490' },
  { name: 'Refined Maida - Bakers Grade (25 kg)', hsn_code: '11010000' },
  { name: 'Bombay Rava (1 kg)', hsn_code: '11031100' },
  { name: 'Gram Flour (1 kg)', hsn_code: '11061000' },
  { name: 'Instant Dry Yeast (500 g)', hsn_code: '21021000' },
  { name: 'Fresh Compressed Yeast (500 g)', hsn_code: '21021000' },
  { name: 'Vanilla Essence (500 ml)', hsn_code: '33021090' },
  { name: 'Butterscotch Essence (500 ml)', hsn_code: '33021090' },
  { name: 'Cocoa Powder - Alkalised (1 kg)', hsn_code: '18050000' },
  { name: 'Dark Chocolate Compound (500 g)', hsn_code: '18069010' },
  { name: 'All in One Premix (5 kg)', hsn_code: '19012000' },
  { name: 'Double Cream (1 l)', hsn_code: '04015000' },
  { name: 'Butter Milk Powder (0402)', hsn_code: '0402' },
];
const ITEMS: SearchFields<Entry> = { names: (e) => [e.name], codes: (e) => [e.hsn_code] };

const CUSTOMERS: Entry[] = [
  { name: 'Sri Ganesh Bakery', phone: '9845012345' },
  { name: 'Golden Crust Bakers', phone: '9900112233' },
  { name: 'Lohith Bakery', phone: '9740098765' },
];
const PEOPLE: SearchFields<Entry> = { names: (e) => [e.name], codes: (e) => [e.phone] };

/** What the search box would show first for `heard`. */
const firstMatch = (heard: string[], list = CATALOGUE, fields = ITEMS) =>
  searchList(list, pickTranscript(heard, list, fields), fields)[0]?.name;

describe('cleanSpokenText: speech written the way the catalogue is', () => {
  const cases: Array<[string, string]> = [
    ['sugar one kilo', 'sugar 1 kg'],
    ['search for sugar one kilo please', 'sugar 1 kg'],
    ['Instant yeast five hundred grams', 'Instant yeast 500 g'],
    ['maida twenty five kgs', 'maida 25 kg'],
    ['vanilla essence 500 millilitres', 'vanilla essence 500 ml'],
    ['double cream one litre', 'double cream 1 l'],
    ['Sugar 1kg.', 'Sugar 1 kg'],
    ['two fifty grams', '250 g'],
    ['one hundred fifty', '150'],
    ['one thousand five hundred', '1500'],
    ['twenty five', '25'],
  ];
  for (const [heard, expected] of cases) {
    it(`"${heard}" → "${expected}"`, () => assert.equal(cleanSpokenText(heard), expected));
  }

  it('reads numbers spoken digit by digit as one code, the way phone numbers and HSN codes are read out', () => {
    assert.equal(cleanSpokenText('nine eight four five zero one two three four five'), '9845012345');
    assert.equal(cleanSpokenText('zero four zero two'), '0402');
    assert.equal(cleanSpokenText('double nine zero zero'), '9900');
    assert.equal(cleanSpokenText('triple five'), '555');
  });

  it('leaves words that are only numbers or units next to a number', () => {
    assert.equal(cleanSpokenText('gram flour'), 'gram flour');
    assert.equal(cleanSpokenText('double cream'), 'double cream');
    assert.equal(cleanSpokenText('kilo'), 'kilo');
  });

  it('never drops every word as a filler', () => {
    assert.equal(cleanSpokenText('add'), 'add');
    assert.equal(cleanSpokenText('please'), 'please');
    assert.equal(cleanSpokenText('sugar please'), 'sugar');
    assert.equal(cleanSpokenText(''), '');
  });
});

describe('soundKey: words that sound alike', () => {
  it('matches the ways Indian English spells a word by ear', () => {
    assert.equal(soundKey('maida'), soundKey('myda'));
    assert.equal(soundKey('rava'), soundKey('rawa'));
    assert.equal(soundKey('atta'), soundKey('aata'));
    assert.equal(soundKey('besan'), soundKey('baysun'));
  });

  it('keeps different words apart', () => {
    assert.notEqual(soundKey('maida'), soundKey('rava'));
    assert.notEqual(soundKey('sugar'), soundKey('yeast'));
  });

  it('does not guess at words too short to compare, or not in Latin letters', () => {
    assert.equal(soundKey('to'), null);
    assert.equal(soundKey('ಸಕ್ಕರೆ'), null);
    assert.equal(soundKey('500'), null);
  });
});

describe('pickTranscript: choosing among what the recogniser might have heard', () => {
  it('lets the catalogue decide between guesses: "yeast", not "east"', () => {
    assert.equal(pickTranscript(['east', 'yeast'], CATALOGUE, ITEMS), 'yeast');
  });

  it('keeps the quantity when the catalogue has it', () => {
    assert.equal(pickTranscript(['sugar one kilo'], CATALOGUE, ITEMS), 'sugar 1 kg');
    assert.match(firstMatch(['sugar one kilo']) ?? '', /Sugar \(1 kg\)/);
    assert.equal(firstMatch(['instant yeast five hundred grams']), 'Instant Dry Yeast (500 g)');
  });

  it('drops a quantity the catalogue writes differently, rather than finding nothing', () => {
    // Maida comes in 25 kg bags only.
    assert.equal(firstMatch(['maida one kilo']), 'Refined Maida - Bakers Grade (25 kg)');
  });

  it('keeps the recogniser\'s order when guesses match equally', () => {
    assert.equal(pickTranscript(['vanilla essence', 'vanilla essences'], CATALOGUE, ITEMS), 'vanilla essence');
  });

  it('finds an item from a word split in two, or spelt by ear', () => {
    assert.equal(firstMatch(['my da']), 'Refined Maida - Bakers Grade (25 kg)');
    assert.equal(firstMatch(['rawa']), 'Bombay Rava (1 kg)');
    assert.equal(firstMatch(['butter scotch essence']), 'Butterscotch Essence (500 ml)');
  });

  it('puts the catalogue\'s own spelling in the box for a word spelt by ear', () => {
    assert.equal(pickTranscript(['myda'], CATALOGUE, ITEMS), 'Maida');
  });

  it('forgives a slip, as typing does', () => {
    assert.equal(firstMatch(['chocolte compound']), 'Dark Chocolate Compound (500 g)');
  });

  it('reads "one" as a word where the name has it', () => {
    assert.equal(firstMatch(['all in one premix']), 'All in One Premix (5 kg)');
  });

  it('finds codes spoken digit by digit', () => {
    assert.equal(firstMatch(['zero four zero two']), 'Butter Milk Powder (0402)');
    assert.equal(firstMatch(['nine eight four five zero one two three four five'], CUSTOMERS, PEOPLE), 'Sri Ganesh Bakery');
    assert.equal(firstMatch(['double nine zero zero'], CUSTOMERS, PEOPLE), 'Golden Crust Bakers');
  });

  it('finds customers by name', () => {
    assert.equal(firstMatch(['ganesh bakery'], CUSTOMERS, PEOPLE), 'Sri Ganesh Bakery');
    assert.equal(firstMatch(['lohit bakery'], CUSTOMERS, PEOPLE), 'Lohith Bakery');
  });

  it('shows what was heard when nothing matches, for a new item or a "no match" message', () => {
    assert.equal(pickTranscript(['Kesar Badam Syrup one litre'], CATALOGUE, ITEMS), 'Kesar Badam Syrup 1 l');
    assert.equal(pickTranscript(['sugar one kilo'], [], ITEMS), 'sugar 1 kg');
  });

  it('gives nothing for nothing heard', () => {
    assert.equal(pickTranscript([], CATALOGUE, ITEMS), '');
    assert.equal(pickTranscript(['  ', ''], CATALOGUE, ITEMS), '');
  });

  it('is quick enough on a 1000-item catalogue to feel instant', () => {
    const words = ['sugar', 'maida', 'yeast', 'cocoa', 'butter', 'cream', 'vanilla', 'essence', 'powder', 'gel', 'chocolate', 'compound'];
    const big: Entry[] = Array.from({ length: 1000 }, (_, i) => ({
      name: `${words[i % 12]} ${words[(i * 5) % 12]} Brand${i} (${(i % 5) + 1} kg)`,
    }));
    const started = performance.now();
    // Nothing matches, so every step is tried.
    pickTranscript(['xylophone quartz', 'zylophone', 'silo phone', 'xylo phone', 'xylophone court'], big, ITEMS);
    assert.ok(performance.now() - started < 400, 'took too long');
  });
});
