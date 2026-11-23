import {cleanSlug, randomSlug, validSlug} from '../src/slugWords';

test('random slugs are adjective-animal and valid', () => {
  for (let i = 0; i < 200; i++) {
    const s = randomSlug();
    expect(validSlug(s)).toBe(true);
    expect(s.split('-')).toHaveLength(2);
  }
});

test('slugs are cleaned up as typed and checked like the server does', () => {
  expect(cleanSlug('Smart Bunny!!')).toBe('smart-bunny-');
  expect(cleanSlug('--Quiet  Otter')).toBe('quiet-otter');
  expect(validSlug('smart-bunny')).toBe(true);
  expect(validSlug('smart-bunny-2')).toBe(true);
  expect(validSlug('smart--bunny')).toBe(false);
  expect(validSlug('smart-bunny-')).toBe(false);
  expect(validSlug('ab')).toBe(false);
  expect(validSlug('a'.repeat(49))).toBe(false);
});
