import type { ErrorRequestHandler, RequestHandler } from 'express'
import multer from 'multer'
import { HttpError } from '../lib/errors.js'

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` })
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details })
    return
  }
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message })
    return
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' })
    return
  }
  // Postgres constraint errors that can slip past our own checks (e.g. two requests at the same moment)
  if (err?.code === '23505') {
    res.status(409).json({ error: 'This already exists' })
    return
  }
  if (err?.code === '23514' || err?.code === '22P02') {
    res.status(400).json({ error: 'Invalid value' })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'Something went wrong on the server' })
}
