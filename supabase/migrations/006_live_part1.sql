-- FabStudio live redesign, Part 1: room and database. No screens change.
-- ACTION: run ONCE in Supabase > SQL Editor, AFTER 005_live.sql. Safe to run again.
--
-- What changes
--   * Questions are removed: old question entries are deleted from saved request logs, and the
--     questionsEnabled setting is removed from saved live settings.
--   * live_love: each person's Love taps for one live, written by the Worker.
--   * live_sessions.markers: timestamps added during the live (used by the recap, Part 3).
--   * record_view_for: lets the Worker count a view for a person and learn whether it was a new view.

-- 1. Questions are gone.
update public.live_sessions
set requests = coalesce((
      select jsonb_agg(e)
      from jsonb_array_elements(requests) as e
      where coalesce(e->>'kind', 'request') <> 'question'
    ), '[]'::jsonb)
where jsonb_typeof(requests) = 'array' and requests @> '[{"kind":"question"}]'::jsonb;

update public.live_sessions
set settings = settings - 'questionsEnabled'
where settings ? 'questionsEnabled';

comment on column public.live_sessions.requests is 'Poem requests, saved when the live ends';

-- 2. Love taps per person per live. The Worker writes the running total (service role). The owner may read it.
create table if not exists public.live_love (
  item_id uuid not null references public.live_sessions(item_id) on delete cascade,
  user_id uuid not null,
  taps int not null default 0 check (taps >= 0),
  updated_at timestamptz not null default now(),
  primary key (item_id, user_id)
);
create index if not exists live_love_user_idx on public.live_love (user_id);

alter table public.live_love enable row level security;
revoke all on public.live_love from anon, authenticated;
grant select on public.live_love to authenticated;
drop policy if exists "owner reads love" on public.live_love;
create policy "owner reads love" on public.live_love for select to authenticated
  using (public.is_owner());

-- 3. Markers added during the live (Part 3 fills and reads them).
alter table public.live_sessions
  add column if not exists markers jsonb not null default '[]'::jsonb;

-- 4. A view counted for a given person. Same rule as record_view: once per account per item,
--    published items only, blocked people are not counted. Returns true only when the view was new.
create or replace function public.record_view_for(p_item uuid, p_user uuid) returns boolean
language plpgsql security definer set search_path = public
as $$
declare added int;
begin
  if p_user is null or not public.item_published(p_item) then return false; end if;
  if exists (select 1 from public.viewer_profiles where user_id = p_user and blocked) then return false; end if;
  insert into public.views (item_id, user_id) values (p_item, p_user) on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 then
    update public.counters set n_views = n_views + 1 where item_id = p_item;
    return true;
  end if;
  return false;
end $$;

revoke all on function public.record_view_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_view_for(uuid, uuid) to service_role;