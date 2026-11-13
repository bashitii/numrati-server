-- Numrati database schema
--
-- Supabase is used as the database (plus Auth for logins and Storage for documents).
-- All business rules live in the Express server (src/), not in SQL functions.
--
-- Row Level Security is switched ON for every table with NO policies. That blocks the
-- public Supabase Data API completely, so the only way in is through our server, which
-- connects directly to Postgres with DATABASE_URL.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.user_role as enum ('buyer', 'seller', 'admin');
create type public.verification_status as enum ('unverified', 'pending', 'verified', 'rejected');
create type public.plate_category as enum ('special', 'exclusive', 'sequential', 'repeated', 'regular');
create type public.governorate as enum (
  'amman', 'irbid', 'zarqa', 'aqaba', 'balqa', 'karak',
  'madaba', 'mafraq', 'jerash', 'ajloun', 'tafilah', 'maan'
);
create type public.listing_status as enum ('pending', 'active', 'rejected', 'suspended', 'sold', 'removed');
create type public.review_status as enum ('pending', 'approved', 'rejected');
create type public.purchase_status as enum ('pending', 'accepted', 'declined', 'cancelled');
create type public.report_status as enum ('new', 'review', 'closed');
create type public.report_reason as enum (
  'suspicious_price', 'fake_listing', 'unverified_seller', 'duplicate', 'incorrect_details', 'scam', 'other'
);

-- ---------------------------------------------------------------------------
-- Users (login itself is Supabase Auth: auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 80),
  phone text check (phone ~ '^\+?[0-9]{8,15}$'),
  role public.user_role not null default 'buyer',
  verification_status public.verification_status not null default 'unverified',
  verified_at timestamptz,
  banned_at timestamptz,
  ban_reason text check (char_length(ban_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Plate listings
-- ---------------------------------------------------------------------------
create table public.plates (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id) on delete cascade,
  code text not null check (code ~ '^[0-9]{1,2}-[0-9]{1,5}$'),
  category public.plate_category not null,
  governorate public.governorate not null,
  price integer not null check (price between 50 and 5000000),
  estimated_value integer check (estimated_value between 1 and 50000000),
  status public.listing_status not null default 'pending',
  featured boolean not null default false,
  views_count integer not null default 0,
  favorites_count integer not null default 0,
  rejection_reason text check (char_length(rejection_reason) <= 500),
  -- private: only the seller and admins ever see these (the server filters them out)
  owner_name text not null check (char_length(btrim(owner_name)) between 2 and 80),
  owner_national_id text not null check (owner_national_id ~ '^[0-9]{10}$'),
  ownership_doc_path text,
  risk_score smallint not null default 0 check (risk_score between 0 and 100),
  risk_flags text[] not null default '{}',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  published_at timestamptz,
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The same plate number cannot have two open listings at once
create unique index plates_one_open_listing_per_code on public.plates (code) where status in ('pending', 'active');
create index plates_status_created_idx on public.plates (status, created_at desc);
create index plates_seller_idx on public.plates (seller_id);
create index plates_price_idx on public.plates (price);

create table public.price_history (
  id bigint generated always as identity primary key,
  plate_id uuid not null references public.plates (id) on delete cascade,
  old_price integer not null,
  new_price integer not null,
  changed_at timestamptz not null default now()
);
create index price_history_plate_idx on public.price_history (plate_id, changed_at);

create table public.favorites (
  user_id uuid not null references public.profiles (id) on delete cascade,
  plate_id uuid not null references public.plates (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, plate_id)
);
create index favorites_plate_idx on public.favorites (plate_id);

-- One counted view per person, per plate, per day
create table public.plate_views (
  plate_id uuid not null references public.plates (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  viewed_on date not null default current_date,
  primary key (plate_id, viewer_id, viewed_on)
);

-- ---------------------------------------------------------------------------
-- Chat and purchase requests
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  plate_id uuid not null references public.plates (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  seller_id uuid not null references public.profiles (id) on delete cascade,
  last_message text,
  last_message_at timestamptz,
  buyer_last_read_at timestamptz not null default now(),
  seller_last_read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (plate_id, buyer_id),
  check (buyer_id <> seller_id)
);
create index conversations_buyer_idx on public.conversations (buyer_id, last_message_at desc);
create index conversations_seller_idx on public.conversations (seller_id, last_message_at desc);

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, id);
create index messages_sender_idx on public.messages (sender_id, created_at);

create table public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  plate_id uuid not null references public.plates (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  seller_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  offered_price integer not null check (offered_price between 1 and 50000000),
  message text check (char_length(message) <= 500),
  status public.purchase_status not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (buyer_id <> seller_id)
);
create unique index purchase_requests_one_pending on public.purchase_requests (plate_id, buyer_id) where status = 'pending';
create index purchase_requests_seller_idx on public.purchase_requests (seller_id, created_at desc);
create index purchase_requests_buyer_idx on public.purchase_requests (buyer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Notifications (the client turns `type` + `data` into Arabic or English text)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in (
    'message', 'favorite', 'price_change', 'purchase_request', 'purchase_update',
    'listing_approved', 'listing_rejected', 'listing_suspended',
    'verification_approved', 'verification_rejected', 'report_update', 'account_banned'
  )),
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_created_idx on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Trust: ID verification, reports, admin audit log
-- ---------------------------------------------------------------------------
create table public.verification_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  id_front_path text not null,
  id_back_path text not null,
  selfie_path text not null,
  status public.review_status not null default 'pending',
  admin_note text check (char_length(admin_note) <= 500),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index verification_one_pending_per_user on public.verification_requests (user_id) where status = 'pending';

create table public.reports (
  id bigint generated always as identity primary key,
  reporter_id uuid references public.profiles (id) on delete set null,
  plate_id uuid references public.plates (id) on delete cascade,
  reported_user_id uuid references public.profiles (id) on delete cascade,
  reason public.report_reason not null,
  details text check (char_length(details) <= 1000),
  status public.report_status not null default 'new',
  admin_note text check (char_length(admin_note) <= 500),
  handled_by uuid references public.profiles (id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  check (plate_id is not null or reported_user_id is not null)
);
create index reports_status_idx on public.reports (status, created_at desc);

create table public.admin_actions (
  id bigint generated always as identity primary key,
  admin_id uuid references public.profiles (id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index admin_actions_created_idx on public.admin_actions (created_at desc);

-- ---------------------------------------------------------------------------
-- Saved price estimates
-- ---------------------------------------------------------------------------
create table public.price_estimates (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  code text not null check (code ~ '^[0-9]{1,2}-[0-9]{1,5}$'),
  category public.plate_category not null,
  governorate public.governorate not null,
  traits jsonb not null default '{}',
  low integer not null,
  high integer not null,
  suggested integer not null,
  confidence smallint check (confidence between 0 and 100),
  factors jsonb not null default '[]',
  model_version text not null default 'rules-v0',
  created_at timestamptz not null default now()
);
create index price_estimates_user_idx on public.price_estimates (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Lock the public Data API: RLS on, no policies. Only the server (direct DB
-- connection) and the service-role key can read or write.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'plates', 'price_history', 'favorites', 'plate_views', 'conversations', 'messages',
    'purchase_requests', 'notifications', 'verification_requests', 'reports', 'admin_actions', 'price_estimates'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Private file buckets. The server uploads with the service-role key and hands
-- out short-lived signed links, so no storage policies are needed.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('verification-docs', 'verification-docs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  ('ownership-docs', 'ownership-docs', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
