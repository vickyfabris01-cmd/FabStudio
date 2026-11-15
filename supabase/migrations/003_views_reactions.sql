-- FabStudio Phase 3: views per account, Like and Love as independent buttons.
-- ACTION: run ONCE in Supabase > SQL Editor, AFTER 002_phase2.sql. Safe to run again.
--
-- What changes
--   * "plays" become "views". The existing play totals carry over as the starting view counts.
--   * A view is recorded once per account (guest or real) per poem.
--   * Reactions are only Like and Love, and a person can give both to the same poem.
--   * Old Emotional and Funny reactions stay in the table but are no longer shown or counted.

-- 1. Counters: rename plays to views, drop the two retired reaction counters.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'counters' and column_name = 'n_plays') then
    alter table public.counters rename column n_plays to n_views;
  end if;
end $$;

-- The public view depends on the columns, so it is rebuilt below.
drop view if exists public.items_public;
alter table public.counters drop column if exists n_emotional;
alter table public.counters drop column if exists n_funny;

-- 2. Reactions: one row per (poem, person, type). NOT VALID keeps old rows without re-checking them.
alter table public.reactions drop constraint if exists reactions_pkey;
alter table public.reactions add primary key (item_id, user_id, type);
alter table public.reactions drop constraint if exists reactions_type_check;
alter table public.reactions add constraint reactions_type_check check (type in ('love','like')) not valid;

-- 3. Views: who has viewed what. Written only through record_view().
create table if not exists public.views (
  item_id uuid not null references public.published_items(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);
create index if not exists views_user_idx on public.views (user_id);
alter table public.views enable row level security;
revoke all on public.views from anon, authenticated;

-- 4. Counters are recalculated from the real rows. Only Like and Love count as reactions.
create or replace function public.recompute_counters(p uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.counters set
    n_love      = (select count(*) from public.reactions where item_id = p and type = 'love'),
    n_like      = (select count(*) from public.reactions where item_id = p and type = 'like'),
    n_reactions = (select count(*) from public.reactions where item_id = p and type in ('love','like')),
    n_comments  = (select count(*) from public.comments where item_id = p and not hidden)
  where item_id = p;
end $$;

-- 5. record_view replaces record_play. Needs a session (guest or real) and counts once per account.
drop function if exists public.record_play(uuid);

create or replace function public.record_view(p_item uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare added int;
begin
  if auth.uid() is null or not public.item_published(p_item) or public.is_blocked() then return; end if;
  insert into public.views (item_id, user_id) values (p_item, auth.uid()) on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 then
    update public.counters set n_views = n_views + 1 where item_id = p_item;
  end if;
end $$;

revoke all on function public.record_view(uuid) from public;
grant execute on function public.record_view(uuid) to authenticated;

-- 6. Guest merge also moves views, and keeps a guest's Like and Love separately.
create or replace function public.merge_users(p_guest uuid, p_account uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_guest is null or p_account is null or p_guest = p_account then raise exception 'bad ids'; end if;
  delete from public.reactions g using public.reactions a
    where g.user_id = p_guest and a.user_id = p_account and a.item_id = g.item_id and a.type = g.type;
  update public.reactions set user_id = p_account where user_id = p_guest;
  update public.comments set user_id = p_account where user_id = p_guest;
  delete from public.views g using public.views a
    where g.user_id = p_guest and a.user_id = p_account and a.item_id = g.item_id;
  update public.views set user_id = p_account where user_id = p_guest;
  insert into public.viewer_profiles (user_id, nickname)
    select p_account, nickname from public.viewer_profiles where user_id = p_guest
    on conflict (user_id) do update
      set nickname = case when public.viewer_profiles.nickname = '' then excluded.nickname
                          else public.viewer_profiles.nickname end;
  delete from public.viewer_profiles where user_id = p_guest;
end $$;

revoke all on function public.merge_users(uuid, uuid) from public;
grant execute on function public.merge_users(uuid, uuid) to service_role;

-- 7. What the public may read.
create or replace view public.items_public with (security_invoker = false) as
select i.id, i.kind, i.title, i.description, i.poem_title, i.poem_stanzas, i.mime, i.duration,
       i.public_media_key, i.public_thumb_key, i.published_at, i.comments_enabled, i.reactions_enabled,
       coalesce(c.n_views, 0) as n_views, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_reactions, 0) as n_reactions, coalesce(c.n_comments, 0) as n_comments
from public.published_items i
left join public.counters c on c.item_id = i.id
where i.status = 'published';

revoke all on public.items_public from anon, authenticated;
grant select on public.items_public to anon, authenticated;

-- 8. Make the counters match the rows right now.
do $$
declare r record;
begin
  for r in select item_id from public.counters loop
    perform public.recompute_counters(r.item_id);
  end loop;
end $$;
