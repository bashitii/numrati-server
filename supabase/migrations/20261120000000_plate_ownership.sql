-- Two kinds of listings:
--   owned  a plate a person owns and wants to resell (chat + purchase request with the seller)
--   dvld   a number DVLD still sells and nobody has bought yet (official price, bought at DVLD)
-- DVLD plates belong to a special "DVLD" account that nobody can sign in to; admins manage them.
alter table public.plates
  add column ownership text not null default 'owned' check (ownership in ('owned', 'dvld'));

create index plates_ownership_status_idx on public.plates (ownership, status);
