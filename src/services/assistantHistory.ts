// Saves Sanadak chats for signed-in users, so they can open and continue them later.
import { query, queryOne, transaction } from '../db/pool.js'
import { forbidden, notFound } from '../lib/errors.js'

/** The chat's title is the first question, shortened */
function makeTitle(question: string) {
  const oneLine = question.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine
}

/** Save one question and Sanadak's answer. Creates the chat the first time. */
export async function saveExchange(chatId: string, userId: string, question: string, answer: string) {
  await transaction(async (db) => {
    await db.query(
      `insert into assistant_chats (id, user_id, title) values ($1, $2, $3)
       on conflict (id) do nothing`,
      [chatId, userId, makeTitle(question)],
    )
    const chat = await queryOne<{ user_id: string }>('select user_id from assistant_chats where id = $1', [chatId], db)
    // Someone else's chat id: never write into it
    if (chat?.user_id !== userId) throw forbidden('This chat belongs to another account')

    await db.query(
      `insert into assistant_messages (chat_id, role, body) values ($1, 'user', $2), ($1, 'model', $3)`,
      [chatId, question, answer.slice(0, 8000)],
    )
    await db.query('update assistant_chats set updated_at = now() where id = $1', [chatId])
  })
}

/** Does this chat id belong to someone else? (a new id belongs to nobody yet) */
export async function isSomeoneElsesChat(chatId: string, userId: string | null) {
  const chat = await queryOne<{ user_id: string }>('select user_id from assistant_chats where id = $1', [chatId])
  return chat !== null && chat.user_id !== userId
}

export function listChats(userId: string) {
  return query(
    `select c.id, c.title, c.created_at as "createdAt", c.updated_at as "updatedAt",
            (select count(*)::int from assistant_messages m where m.chat_id = c.id and m.role = 'user') as questions
     from assistant_chats c
     where c.user_id = $1
     order by c.updated_at desc
     limit 100`,
    [userId],
  )
}

export async function getChat(chatId: string, userId: string) {
  const chat = await queryOne(
    `select id, title, created_at as "createdAt", updated_at as "updatedAt"
     from assistant_chats where id = $1 and user_id = $2`,
    [chatId, userId],
  )
  if (!chat) throw notFound('Chat not found')
  const messages = await query(
    `select role, body as text, created_at as "createdAt"
     from assistant_messages where chat_id = $1 order by id`,
    [chatId],
  )
  return { ...chat, messages }
}

export async function deleteChat(chatId: string, userId: string) {
  const deleted = await queryOne('delete from assistant_chats where id = $1 and user_id = $2 returning id', [chatId, userId])
  if (!deleted) throw notFound('Chat not found')
}
