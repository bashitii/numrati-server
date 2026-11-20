-- Sanadak chat history: each signed-in user can see and continue their own past chats.
-- The chat id is also the session id sent to the Sanadak agent in Google Cloud.

create table public.assistant_chats (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_chats_user_idx on public.assistant_chats (user_id, updated_at desc);

create table public.assistant_messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.assistant_chats (id) on delete cascade,
  role text not null check (role in ('user', 'model')),
  body text not null check (char_length(btrim(body)) between 1 and 8000),
  created_at timestamptz not null default now()
);
create index assistant_messages_chat_idx on public.assistant_messages (chat_id, id);

-- Same rule as every other table: no access through Supabase's public Data API, only through our server
alter table public.assistant_chats enable row level security;
alter table public.assistant_messages enable row level security;
revoke all on public.assistant_chats from anon, authenticated;
revoke all on public.assistant_messages from anon, authenticated;
