import type { Request } from 'express'
import type { z } from 'zod'
import { badRequest } from '../lib/errors.js'

function check<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw badRequest(
      'Invalid input',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    )
  }
  return result.data
}

export const parseBody = <S extends z.ZodTypeAny>(req: Request, schema: S) => check(schema, req.body ?? {})
export const parseQuery = <S extends z.ZodTypeAny>(req: Request, schema: S) => check(schema, req.query)
export const parseParams = <S extends z.ZodTypeAny>(req: Request, schema: S) => check(schema, req.params)
