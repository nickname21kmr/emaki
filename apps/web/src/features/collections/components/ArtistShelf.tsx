import type { Artist } from '@emaki/shared';
import { Link } from 'react-router';
import { Thumb } from '@/components/media/Thumb';
import { formatCount } from '@/lib/format';

/**
 * 合集页的「画师」：识别出来的画师，按张数排。点进去是图库按这位画师筛选。
 * 认不出画师的图不在这里。
 */
export function ArtistShelf({ list }: { list: Artist[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-5 gap-y-7">
      {list.map((a) => (
        <li key={a.tag}>
          <Link to={`/gallery?artist=${encodeURIComponent(a.tag)}`} className="group block focus-visible:outline-none">
            <div className="aspect-[3/4] overflow-hidden rounded-lg bg-sunken shadow-sm ring-1 ring-line transition-[box-shadow,transform] duration-300 group-hover:-translate-y-0.5 group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-shu">
              {a.cover && (
                <Thumb image={a.cover} width={480} className="size-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.03]" blurBadge="corner" />
              )}
            </div>
            <div className="mt-2.5 truncate text-[13.5px] font-medium" title={[a.name, ...a.aliases].join(' / ')}>
              {a.name}
            </div>
            <div className="truncate text-xs text-fg-muted">
              <span className="tabular">{formatCount(a.imageCount)} 张</span>
              {/* 有推特显示账号；名字是日文名时再给出标签，方便对照 */}
              <span className="ml-1.5 text-fg-subtle">{a.twitter ? `@${a.twitter}` : a.name !== a.tag.replace(/_/g, ' ') ? a.tag : ''}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
