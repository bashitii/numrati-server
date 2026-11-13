import { Router } from 'express'
import { query, queryOne, transaction } from '../db/pool.js'
import { badRequest } from '../lib/errors.js'
import { BUCKETS } from '../lib/supabase.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { deleteFiles, saveFile, upload } from '../services/storage.js'

export const verificationRouter = Router()
verificationRouter.use(requireAuth)

// GET /api/verification  My verification status and latest request
verificationRouter.get('/', async (req, res) => {
  const user = currentUser(req)
  const latest = await queryOne(
    `select id, status, admin_note as "adminNote", created_at as "createdAt", reviewed_at as "reviewedAt"
     from verification_requests where user_id = $1 order by created_at desc limit 1`,
    [user.id],
  )
  res.json({ status: user.verificationStatus, latest })
})

// POST /api/verification  multipart/form-data: idFront, idBack, selfie (photos)
verificationRouter.post(
  '/',
  upload.fields([{ name: 'idFront', maxCount: 1 }, { name: 'idBack', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]),
  async (req, res) => {
    const user = currentUser(req)
    if (user.verificationStatus === 'verified') throw badRequest('Your account is already verified')
    if (user.verificationStatus === 'pending') throw badRequest('Your documents are already waiting for review')

    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>
    const idFront = files.idFront?.[0]
    const idBack = files.idBack?.[0]
    const selfie = files.selfie?.[0]
    if (!idFront || !idBack || !selfie) throw badRequest('Please attach idFront, idBack and selfie photos')
    if ([idFront, idBack, selfie].some((f) => f.size > 5 * 1024 * 1024)) throw badRequest('Each photo must be under 5 MB')

    const paths: string[] = []
    try {
      for (const file of [idFront, idBack, selfie]) paths.push(await saveFile(BUCKETS.verification, user.id, file, true))
      const request = await transaction(async (db) => {
        const row = await queryOne(
          `insert into verification_requests (user_id, id_front_path, id_back_path, selfie_path)
           values ($1, $2, $3, $4) returning id, status, created_at as "createdAt"`,
          [user.id, ...paths],
          db,
        )
        await query(`update profiles set verification_status = 'pending', updated_at = now() where id = $1`, [user.id], db)
        return row
      })
      res.status(201).json({ request, message: 'Documents sent for review' })
    } catch (error) {
      await deleteFiles(BUCKETS.verification, paths)
      throw error
    }
  },
)
