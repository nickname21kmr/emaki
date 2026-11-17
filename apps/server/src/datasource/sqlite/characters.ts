/**
 * 角色编辑、合并已搬到 domain/catalog/characters.ts，按标签新建角色在 domain/catalog/characterCatalog.ts（P3b：编目表只由 domain/catalog/ 写）。
 * 这里只给还没改 import 的调用方转一下，调用方都改过来以后删掉这个文件。
 */
export { insertDanbooruCharacter } from '../../domain/catalog/characterCatalog.ts';
