import { randomUUID } from 'node:crypto'
import multer from 'multer'
import { badRequest, HttpError } from '../lib/errors.js'
import { supabaseAdmin } from '../lib/supabase.js'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf',
}

/** Files are kept in memory just long enough to pass them on to Supabase Storage */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (EXTENSIONS[file.mimetype]) cb(null, true)
    else cb(badRequest('Only JPG, PNG, WEBP, HEIC or PDF files are allowed'))
  },
})

/** Upload into "<userId>/<random>.<ext>" in a private bucket and return the stored path */
export async function saveFile(bucket: string, userId: string, file: Express.Multer.File, imagesOnly = false) {
  if (imagesOnly && !IMAGE_TYPES.includes(file.mimetype)) throw badRequest(`${file.fieldname} must be a photo`)
  const path = `${userId}/${randomUUID()}.${EXTENSIONS[file.mimetype]}`
  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, file.buffer, { contentType: file.mimetype })
  if (error) throw new HttpError(502, `Could not store the file: ${error.message}`)
  return path
}

export async function deleteFiles(bucket: string, paths: string[]) {
  if (paths.length) await supabaseAdmin.storage.from(bucket).remove(paths)
}

/** Private files are only ever shown through short-lived links (10 minutes) */
export async function signedUrl(bucket: string, path: string | null) {
  if (!path) return null
  const { data } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 600)
  return data?.signedUrl ?? null
}
