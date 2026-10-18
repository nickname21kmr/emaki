import { describe, expect, it } from 'vitest';
import { editedSource, sourceEditSchema } from './editSource.ts';

describe('manual source', () => {
  it.each(['https://www.pixiv.net/artworks/98785437?x=1', 'https://www.pixiv.net/en/artworks/98785437', 'https://www.pixiv.net/member_illust.php?illust_id=98785437'])('canonicalizes %s', url => {
    expect(editedSource({ url, artist: ' Killy ' }, 'unknown.jpg')).toEqual({ manual: true, source: {
      site: 'pixiv', postId: '98785437', url: 'https://www.pixiv.net/artworks/98785437', artist: 'Killy',
    } });
  });
  it.each(['javascript:alert(1)', 'file:///C:/test', 'https://user:secret@example.com', 'not-a-url'])('rejects unsafe URL %s', url => {
    expect(sourceEditSchema.safeParse({ url }).success).toBe(false);
  });
  it('does not trust lookalike domains', () => {
    expect(editedSource({ url: 'https://pixiv.net.example.com/artworks/98785437' }, '').source?.site).toBe('other');
  });
  it('distinguishes manual clear from restoring automatic parsing', () => {
    expect(editedSource(null, '98785437_p0.jpg')).toEqual({ source: null, manual: true });
    expect(editedSource('auto', '98785437_p0.jpg')).toMatchObject({ manual: false, source: { site: 'pixiv', postId: '98785437' } });
    expect(editedSource('auto', 'unknown.jpg')).toEqual({ manual: false, source: null });
  });
});
