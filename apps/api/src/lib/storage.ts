import path from "node:path";
import fs from "node:fs";
import multer from "multer";

/**
 * Local-disk file storage for this dev/local build. In production this
 * would swap for S3-compatible object storage with signed URLs (see the
 * development plan's architecture section) — everything downstream only
 * knows about a `storageKey`, so that swap touches this file alone.
 */
export const UPLOAD_ROOT = path.resolve(__dirname, "../../uploads");

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const ALLOWED_MIME_PREFIXES = ["image/", "video/", "application/pdf"];
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200MB

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = ALLOWED_MIME_PREFIXES.some((p) => file.mimetype.startsWith(p));
    if (!ok) {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: images, video, PDF.`));
      return;
    }
    cb(null, true);
  },
});

/** Writes a buffer to disk under a per-workspace/per-asset path and returns the storage key. */
export function saveFileBuffer(params: { workspaceId: string; assetId: string; versionNumber: number; originalFilename: string; buffer: Buffer }): string {
  const safeName = params.originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const relativeDir = path.join(params.workspaceId, params.assetId);
  const relativePath = path.join(relativeDir, `v${params.versionNumber}-${safeName}`);
  const fullDir = path.join(UPLOAD_ROOT, relativeDir);
  fs.mkdirSync(fullDir, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_ROOT, relativePath), params.buffer);
  return relativePath;
}

export function resolveStoragePath(storageKey: string): string {
  return path.join(UPLOAD_ROOT, storageKey);
}
