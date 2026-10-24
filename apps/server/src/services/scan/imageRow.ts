import { baseName } from '../fs/paths.ts';
import { classifyContent, CLASSIFIER_VERSION } from '../classify/rules.ts';
import type { Probe } from '../image/probe.ts';

/** Scans and explicit imports use the same row shape and classification. */
export const INSERT_IMAGE_SQL = `INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256,
  source_site, source_post_id, source_artist, source_url, added_at, modified_at,
  camera, content_kind, content_kind_source, content_kind_evidence, content_kind_version, rating, frame_count)
  VALUES (@rootId, @relPath, @fileName, @width, @height, @bytes, @format, @sha256,
  @site, @postId, @artist, @url, @addedAt, @modifiedAt,
  @camera, @kind, @kindSource, @kindEvidence, @kindVersion, @rating, @frameCount)`;

export function imageClassification(probe: Probe, relPath: string, comicRoot: boolean) {
  const cls = classifyContent({ fileName: baseName(relPath), relPath, width: probe.width, height: probe.height,
    format: probe.format, pages: probe.pages, camera: probe.camera, tags: null, comicRoot });
  return { camera: probe.camera, kind: cls.kind, kindSource: cls.source, kindEvidence: cls.evidence, kindVersion: CLASSIFIER_VERSION };
}
